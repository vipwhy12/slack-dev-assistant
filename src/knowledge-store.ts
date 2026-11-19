import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectConfig } from './config.js';
import { hash, type ThreadSnapshot } from './domain.js';
import type { GenerationUsage } from './generation.js';
import { normalizeKnowledgeKey, type KnowledgeDraft, type KnowledgeExtractor, type KnowledgeItem } from './knowledge.js';

export interface KnowledgeSetRecord { id: string; snapshot_id: string; thread_id: string; status: string; summary: string | null }
export interface StoredKnowledgeEvidence {
  messageVersionId: string; quote: string; text: string; ts: string; editedTs: string | null; author: string | null; permalink: string; snapshotId: string;
}
export interface KnowledgeSearchResult {
  id: string; knowledgeSetId: string; snapshotId: string; kind: KnowledgeItem['kind']; key: string; title: string; statement: string;
  certainty: KnowledgeItem['certainty']; reviewState: 'unreviewed'; state: 'unreviewed' | 'uncertain' | 'conflicting';
  scope: { projectId: string; workspace: string; channelId: string; rootTs: string };
  conflictItemIds: string[]; evidence: StoredKnowledgeEvidence[];
  relationships: Array<{ predicate: string; sourceItemId: string; targetItemId: string; evidence: StoredKnowledgeEvidence[] }>;
}
const now = () => new Date().toISOString();

/** Separate normalized knowledge database. Source versions and extracted sets are append-only. */
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private lockId?: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Knowledge database cannot be a symbolic link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS knowledge_projects(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS knowledge_threads(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES knowledge_projects(id), workspace TEXT NOT NULL,
        channel_id TEXT NOT NULL, root_ts TEXT NOT NULL, latest_snapshot_id TEXT REFERENCES knowledge_snapshots(id),
        active_set_id TEXT REFERENCES knowledge_sets(id), UNIQUE(project_id,workspace,channel_id,root_ts));
      CREATE TABLE IF NOT EXISTS knowledge_snapshots(
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES knowledge_threads(id), content_hash TEXT NOT NULL,
        collected_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','partial')), warnings_json TEXT NOT NULL,
        UNIQUE(thread_id,content_hash), UNIQUE(id,thread_id));
      CREATE TABLE IF NOT EXISTS knowledge_messages(
        snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id), id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL,
        author TEXT, edited_ts TEXT, permalink TEXT NOT NULL, has_attachments INTEGER NOT NULL,
        PRIMARY KEY(snapshot_id,id), UNIQUE(snapshot_id,ts));
      CREATE TABLE IF NOT EXISTS knowledge_sets(
        id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL CHECK(status IN ('extracting','complete','failed')),
        extractor_name TEXT NOT NULL, extractor_model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        summary TEXT, review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state='unreviewed'), usage_json TEXT, error_json TEXT,
        FOREIGN KEY(snapshot_id,thread_id) REFERENCES knowledge_snapshots(id,thread_id), UNIQUE(id,snapshot_id));
      CREATE TABLE IF NOT EXISTS knowledge_items(
        id TEXT PRIMARY KEY, set_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, local_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term','entity','rule','fact','decision')), logical_key TEXT NOT NULL,
        title TEXT NOT NULL, statement TEXT NOT NULL, certainty TEXT NOT NULL CHECK(certainty IN ('stated','uncertain')),
        FOREIGN KEY(set_id,snapshot_id) REFERENCES knowledge_sets(id,snapshot_id),
        UNIQUE(set_id,local_id), UNIQUE(id,set_id), UNIQUE(id,snapshot_id));
      CREATE INDEX IF NOT EXISTS knowledge_items_key ON knowledge_items(kind,logical_key);
      CREATE TABLE IF NOT EXISTS knowledge_item_evidence(
        item_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, message_version_id TEXT NOT NULL, quote TEXT NOT NULL,
        FOREIGN KEY(item_id,snapshot_id) REFERENCES knowledge_items(id,snapshot_id),
        FOREIGN KEY(snapshot_id,message_version_id) REFERENCES knowledge_messages(snapshot_id,id),
        PRIMARY KEY(item_id,message_version_id,quote));
      CREATE TABLE IF NOT EXISTS knowledge_relationships(
        id TEXT PRIMARY KEY, set_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_id TEXT NOT NULL, predicate TEXT NOT NULL, target_id TEXT NOT NULL,
        FOREIGN KEY(set_id,snapshot_id) REFERENCES knowledge_sets(id,snapshot_id),
        FOREIGN KEY(source_id,set_id) REFERENCES knowledge_items(id,set_id), FOREIGN KEY(target_id,set_id) REFERENCES knowledge_items(id,set_id),
        UNIQUE(set_id,source_id,predicate,target_id), UNIQUE(id,snapshot_id));
      CREATE TABLE IF NOT EXISTS knowledge_relationship_evidence(
        relationship_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, message_version_id TEXT NOT NULL, quote TEXT NOT NULL,
        FOREIGN KEY(relationship_id,snapshot_id) REFERENCES knowledge_relationships(id,snapshot_id),
        FOREIGN KEY(snapshot_id,message_version_id) REFERENCES knowledge_messages(snapshot_id,id),
        PRIMARY KEY(relationship_id,message_version_id,quote));
      CREATE TABLE IF NOT EXISTS knowledge_uncertainties(
        set_id TEXT NOT NULL REFERENCES knowledge_sets(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(set_id,ordinal));
      CREATE TABLE IF NOT EXISTS knowledge_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  acquireLock(): void {
    this.transaction(() => {
      const held = this.db.prepare('SELECT owner,pid FROM knowledge_lock WHERE id=1').get() as {owner: string; pid: number} | undefined;
      if (held) {
        let alive = true;
        try { process.kill(held.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another knowledge save is active; retry after it finishes');
        this.db.prepare('DELETE FROM knowledge_lock WHERE id=1').run();
        // A provider may have charged before a crash. Never automatically send that input twice.
        this.db.prepare("UPDATE knowledge_sets SET status='failed',error_json=? WHERE status='extracting'")
          .run(JSON.stringify({ code: 'interrupted', message: 'Previous extraction was interrupted; inspect before explicit recovery.' }));
      }
      const owner = randomUUID();
      this.db.prepare('INSERT INTO knowledge_lock VALUES(1,?,?)').run(owner, process.pid);
      this.lockId = owner;
    });
  }
  close(): void {
    if (this.lockId) this.db.prepare('DELETE FROM knowledge_lock WHERE owner=?').run(this.lockId);
    this.lockId = undefined; this.db.close();
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observe(projectId: string, snapshot: ThreadSnapshot): { snapshotId: string; threadId: string } {
    return this.transaction(() => {
      const threadId = hash([projectId, snapshot.workspace, snapshot.channelId, snapshot.rootTs]);
      this.db.prepare('INSERT OR IGNORE INTO knowledge_projects VALUES(?)').run(projectId);
      this.db.prepare('INSERT OR IGNORE INTO knowledge_threads(id,project_id,workspace,channel_id,root_ts) VALUES(?,?,?,?,?)')
        .run(threadId, projectId, snapshot.workspace, snapshot.channelId, snapshot.rootTs);
      const existing = this.db.prepare('SELECT id FROM knowledge_snapshots WHERE thread_id=? AND content_hash=?')
        .get(threadId, snapshot.contentHash) as { id: string } | undefined;
      const snapshotId = existing?.id ?? randomUUID();
      if (!existing) {
        this.db.prepare('INSERT INTO knowledge_snapshots VALUES(?,?,?,?,?,?)').run(snapshotId, threadId, snapshot.contentHash, snapshot.collectedAt, snapshot.status, JSON.stringify(snapshot.warnings));
        const insert = this.db.prepare('INSERT INTO knowledge_messages VALUES(?,?,?,?,?,?,?,?)');
        for (const message of snapshot.messages) insert.run(snapshotId, message.id, message.ts, message.text, message.author, message.editedTs, message.permalink, message.hasAttachments ? 1 : 0);
      }
      this.db.prepare('UPDATE knowledge_threads SET active_set_id=CASE WHEN latest_snapshot_id=? THEN active_set_id ELSE NULL END,latest_snapshot_id=? WHERE id=?')
        .run(snapshotId, snapshotId, threadId);
      return { snapshotId, threadId };
    });
  }
  find(inputHash: string): KnowledgeSetRecord | undefined {
    return this.db.prepare('SELECT id,snapshot_id,thread_id,status,summary FROM knowledge_sets WHERE input_hash=?').get(inputHash) as unknown as KnowledgeSetRecord | undefined;
  }
  claim(inputHash: string, snapshotId: string, threadId: string, extractor: KnowledgeExtractor): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO knowledge_sets(id,snapshot_id,thread_id,input_hash,created_at,status,extractor_name,extractor_model,prompt_version) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, snapshotId, threadId, inputHash, now(), 'extracting', extractor.name, extractor.model, extractor.promptVersion);
    return id;
  }
  fail(id: string, error: unknown, usage?: GenerationUsage): void {
    this.db.prepare("UPDATE knowledge_sets SET status='failed',completed_at=?,error_json=?,usage_json=? WHERE id=? AND status='extracting'")
      .run(now(), JSON.stringify(error), usage ? JSON.stringify(usage) : null, id);
  }
  activate(id: string): void {
    const row = this.db.prepare("SELECT thread_id,snapshot_id FROM knowledge_sets WHERE id=? AND status='complete'").get(id) as { thread_id: string; snapshot_id: string } | undefined;
    if (!row) throw new Error('Knowledge set is not complete');
    const result = this.db.prepare('UPDATE knowledge_threads SET active_set_id=? WHERE id=? AND latest_snapshot_id=?').run(id, row.thread_id, row.snapshot_id);
    if (result.changes !== 1) throw new Error('Knowledge set is no longer the current thread snapshot');
  }
  complete(id: string, draft: KnowledgeDraft, usage?: GenerationUsage): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT snapshot_id FROM knowledge_sets WHERE id=? AND status='extracting'").get(id) as { snapshot_id: string } | undefined;
      if (!row) throw new Error('Knowledge extraction is not pending');
      const snapshotId = row.snapshot_id;
      const itemIds = new Map<string, string>();
      for (const item of draft.items) {
        const itemId = randomUUID(); itemIds.set(item.id, itemId);
        this.db.prepare('INSERT INTO knowledge_items VALUES(?,?,?,?,?,?,?,?,?)').run(itemId, id, snapshotId, item.id, item.kind, normalizeKnowledgeKey(item.key), item.title, item.statement, item.certainty);
        for (const reference of item.evidence) this.db.prepare('INSERT INTO knowledge_item_evidence VALUES(?,?,?,?)').run(itemId, snapshotId, reference.messageVersionId, reference.quote);
      }
      for (const relationship of draft.relationships) {
        const relationshipId = randomUUID();
        this.db.prepare('INSERT INTO knowledge_relationships VALUES(?,?,?,?,?,?)').run(relationshipId, id, snapshotId, itemIds.get(relationship.sourceId) ?? '', normalizeKnowledgeKey(relationship.predicate), itemIds.get(relationship.targetId) ?? '');
        for (const reference of relationship.evidence) this.db.prepare('INSERT INTO knowledge_relationship_evidence VALUES(?,?,?,?)').run(relationshipId, snapshotId, reference.messageVersionId, reference.quote);
      }
      draft.uncertainties.forEach((value, index) => this.db.prepare('INSERT INTO knowledge_uncertainties VALUES(?,?,?)').run(id, index, value));
      this.db.prepare("UPDATE knowledge_sets SET status='complete',completed_at=?,summary=?,usage_json=? WHERE id=?").run(now(), draft.summary, usage ? JSON.stringify(usage) : null, id);
      this.activate(id);
    });
  }
  getDraft(id: string): KnowledgeDraft {
    const set = this.db.prepare("SELECT summary FROM knowledge_sets WHERE id=? AND status='complete'").get(id) as { summary: string } | undefined;
    if (!set) throw new Error('Knowledge set is not complete');
    const rows = this.db.prepare('SELECT * FROM knowledge_items WHERE set_id=? ORDER BY rowid').all(id) as unknown as Array<{id: string; local_id: string; kind: KnowledgeItem['kind']; logical_key: string; title: string; statement: string; certainty: KnowledgeItem['certainty']}>;
    const local = new Map(rows.map(row => [row.id, row.local_id]));
    const items = rows.map(row => ({id: row.local_id, kind: row.kind, key: row.logical_key, title: row.title, statement: row.statement, certainty: row.certainty,
      evidence: this.db.prepare('SELECT message_version_id AS messageVersionId,quote FROM knowledge_item_evidence WHERE item_id=? ORDER BY rowid').all(row.id) as unknown as KnowledgeItem['evidence'] }));
    const relationships = (this.db.prepare('SELECT * FROM knowledge_relationships WHERE set_id=? ORDER BY rowid').all(id) as unknown as Array<{id: string; source_id: string; predicate: string; target_id: string}>).map(row => ({
      sourceId: local.get(row.source_id)!, predicate: row.predicate, targetId: local.get(row.target_id)!,
      evidence: this.db.prepare('SELECT message_version_id AS messageVersionId,quote FROM knowledge_relationship_evidence WHERE relationship_id=? ORDER BY rowid').all(row.id) as unknown as KnowledgeItem['evidence'],
    }));
    const uncertainties = (this.db.prepare('SELECT text FROM knowledge_uncertainties WHERE set_id=? ORDER BY ordinal').all(id) as Array<{text: string}>).map(row => row.text);
    return { summary: set.summary, items, relationships, uncertainties };
  }
  getSnapshot(id: string): ThreadSnapshot {
    const row = this.db.prepare(`SELECT s.*,t.workspace,t.channel_id,t.root_ts FROM knowledge_snapshots s
      JOIN knowledge_threads t ON t.id=s.thread_id WHERE s.id=?`).get(id) as { id: string; workspace: string; channel_id: string; root_ts: string; collected_at: string; status: 'complete' | 'partial'; warnings_json: string; content_hash: string } | undefined;
    if (!row) throw new Error('Knowledge snapshot not found');
    const messages = (this.db.prepare('SELECT * FROM knowledge_messages WHERE snapshot_id=? ORDER BY ts').all(id) as unknown as Array<{id: string; ts: string; text: string; author: string | null; edited_ts: string | null; permalink: string; has_attachments: number}>).map(message => ({
      id: message.id, ts: message.ts, text: message.text, author: message.author, editedTs: message.edited_ts, permalink: message.permalink, hasAttachments: Boolean(message.has_attachments),
    }));
    return {id: row.id, workspace: row.workspace, channelId: row.channel_id, rootTs: row.root_ts, collectedAt: row.collected_at, status: row.status, warnings: JSON.parse(row.warnings_json) as string[], contentHash: row.content_hash, messages};
  }
  query(config: ProjectConfig, query = '', limit = 20, knowledgeSetId?: string): KnowledgeSearchResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Knowledge limit must be an integer from 1 to 200');
    if (query.length > 2000) throw new Error('Knowledge query is too long');
    const channels = config.slack.channelIds.map(() => '?').join(',');
    const scopeValues = [config.projectId, config.slack.workspace, ...config.slack.channelIds];
    const scope = `t.project_id=? AND t.workspace=? AND t.channel_id IN (${channels})`;
    const active = `FROM knowledge_items i JOIN knowledge_sets s ON s.id=i.set_id JOIN knowledge_threads t ON t.active_set_id=s.id AND t.latest_snapshot_id=s.snapshot_id WHERE ${scope} AND s.status='complete'`;
    const pattern = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const rows = this.db.prepare(`SELECT i.*,t.project_id,t.workspace,t.channel_id,t.root_ts ${active}
      AND (i.logical_key LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.statement LIKE ? ESCAPE '\\') ${knowledgeSetId ? 'AND s.id=?' : ''} ORDER BY s.rowid DESC,i.rowid LIMIT ?`)
      .all(...scopeValues, pattern, pattern, pattern, ...(knowledgeSetId ? [knowledgeSetId] : []), limit) as unknown as Array<{id: string; set_id: string; snapshot_id: string; kind: KnowledgeItem['kind']; logical_key: string; title: string; statement: string; certainty: KnowledgeItem['certainty']; project_id: string; workspace: string; channel_id: string; root_ts: string}>;
    return rows.map(row => {
      const conflicts = this.db.prepare(`SELECT i.id ${active} AND i.id<>? AND i.kind=? AND i.logical_key=? AND i.statement<>? ORDER BY i.rowid`)
        .all(...scopeValues, row.id, row.kind, row.logical_key, row.statement) as Array<{id: string}>;
      const relationships = (this.db.prepare('SELECT id,source_id,predicate,target_id FROM knowledge_relationships WHERE source_id=? OR target_id=? ORDER BY rowid').all(row.id, row.id) as Array<{id: string; source_id: string; predicate: string; target_id: string}>).map(relationship => ({
        predicate: relationship.predicate, sourceItemId: relationship.source_id, targetItemId: relationship.target_id, evidence: this.evidence('relationship', relationship.id),
      }));
      return { id: row.id, knowledgeSetId: row.set_id, snapshotId: row.snapshot_id, kind: row.kind, key: row.logical_key, title: row.title, statement: row.statement,
        certainty: row.certainty, reviewState: 'unreviewed', state: conflicts.length ? 'conflicting' : row.certainty === 'uncertain' ? 'uncertain' : 'unreviewed',
        scope: {projectId: row.project_id, workspace: row.workspace, channelId: row.channel_id, rootTs: row.root_ts},
        conflictItemIds: conflicts.map(value => value.id), evidence: this.evidence('item', row.id), relationships };
    });
  }
  private evidence(kind: 'item' | 'relationship', id: string): StoredKnowledgeEvidence[] {
    const table = kind === 'item' ? 'knowledge_item_evidence' : 'knowledge_relationship_evidence';
    const column = kind === 'item' ? 'item_id' : 'relationship_id';
    return this.db.prepare(`SELECT e.message_version_id AS messageVersionId,e.quote,m.text,m.ts,m.edited_ts AS editedTs,m.author,m.permalink,e.snapshot_id AS snapshotId
      FROM ${table} e JOIN knowledge_messages m ON m.snapshot_id=e.snapshot_id AND m.id=e.message_version_id WHERE e.${column}=? ORDER BY e.rowid`).all(id) as unknown as StoredKnowledgeEvidence[];
  }
}
