import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThreadSnapshot } from './domain.js';
import type { AnalysisDraft } from './analysis.js';

export type RunStatus = 'queued' | 'collecting' | 'analyzing' | 'needs_input' | 'ready' | 'failed' | 'reused';
export interface RunRecord {
  id: string; project_id: string; mode: string; status: RunStatus; created_at: string;
  finished_at: string | null; input_json: string; input_hash: string | null;
  snapshot_id: string | null; error_json: string | null; reused_run_id: string | null;
}
const now = () => new Date().toISOString();
export class RunStore {
  private db: DatabaseSync;
  private lockId?: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, config_json TEXT NOT NULL, config_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), mode TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, input_json TEXT NOT NULL,
        input_hash TEXT, snapshot_id TEXT, error_json TEXT, reused_run_id TEXT REFERENCES runs(id));
      CREATE INDEX IF NOT EXISTS runs_input ON runs(input_hash, status);
      CREATE TABLE IF NOT EXISTS thread_snapshots(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), content_hash TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_versions(snapshot_id TEXT NOT NULL REFERENCES thread_snapshots(id), id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(snapshot_id,id));
      CREATE TABLE IF NOT EXISTS run_steps(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, input_hash TEXT, output_path TEXT, error_json TEXT, attempt INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS spec_revisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), parent_id TEXT REFERENCES spec_revisions(id), created_at TEXT NOT NULL, origin TEXT NOT NULL, review_state TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interventions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), revision_id TEXT NOT NULL REFERENCES spec_revisions(id), created_at TEXT NOT NULL, reason TEXT NOT NULL, minutes REAL NOT NULL CHECK(minutes>=0), actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS process_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  acquireLock(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const held = this.db.prepare('SELECT owner,pid FROM process_lock WHERE id=1').get() as { owner: string; pid: number } | undefined;
      if (held) {
        let alive = true;
        try { process.kill(held.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error('Another run is active in this storage directory. Retry when it finishes.');
        this.db.prepare('DELETE FROM process_lock WHERE id=1').run();
        const interrupted = JSON.stringify({ code: 'interrupted', message: 'Previous CLI process exited before finishing.', retryable: true });
        this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error_json=? WHERE status IN ('queued','collecting','analyzing')").run(now(), interrupted);
        this.db.prepare("UPDATE run_steps SET status='failed',finished_at=?,error_json=? WHERE status='running'").run(now(), interrupted);
      }
      const owner = randomUUID();
      this.db.prepare('INSERT INTO process_lock(id,owner,pid) VALUES(1,?,?)').run(owner, process.pid);
      this.db.exec('COMMIT'); this.lockId = owner;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  releaseLock(): void {
    if (this.lockId) this.db.prepare('DELETE FROM process_lock WHERE owner=?').run(this.lockId);
    this.lockId = undefined;
  }
  close(): void { this.releaseLock(); this.db.close(); }
  saveProject(id: string, config: unknown, configHash: string): void {
    this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,config_hash=excluded.config_hash').run(id, JSON.stringify(config), configHash);
  }
  createRun(projectId: string, input: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs(id,project_id,mode,status,created_at,input_json) VALUES(?,?,?, ?,?,?)').run(id, projectId, 'analyze', 'queued', now(), JSON.stringify(input));
    return id;
  }
  status(id: string, status: RunStatus, error?: unknown): void {
    const terminal = ['ready', 'needs_input', 'failed', 'reused'].includes(status);
    this.db.prepare('UPDATE runs SET status=?,finished_at=?,error_json=? WHERE id=?').run(status, terminal ? now() : null, error ? JSON.stringify(error) : null, id);
  }
  setInputHash(id: string, inputHash: string): void { this.db.prepare('UPDATE runs SET input_hash=? WHERE id=?').run(inputHash, id); }
  findReusable(inputHash: string, projectId: string): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE input_hash=? AND project_id=? AND status IN ('ready','needs_input') AND EXISTS(SELECT 1 FROM spec_revisions s WHERE s.run_id=runs.id) ORDER BY created_at DESC LIMIT 1").get(inputHash, projectId) as unknown as RunRecord | undefined;
  }
  reuse(id: string, previousId: string): void {
    this.db.prepare("UPDATE runs SET status='reused',finished_at=?,reused_run_id=? WHERE id=?").run(now(), previousId, id);
  }
  saveSnapshot(runId: string, snapshot: ThreadSnapshot): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO thread_snapshots VALUES(?,?,?,?)').run(snapshot.id, runId, snapshot.contentHash, JSON.stringify(snapshot));
      const insert = this.db.prepare('INSERT INTO message_versions VALUES(?,?,?)');
      for (const message of snapshot.messages) insert.run(snapshot.id, message.id, JSON.stringify(message));
      this.db.prepare('UPDATE runs SET snapshot_id=? WHERE id=?').run(snapshot.id, runId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getSnapshot(runId: string): ThreadSnapshot {
    const row = this.db.prepare('SELECT data_json FROM thread_snapshots WHERE run_id=?').get(runId) as { data_json: string } | undefined;
    if (!row) throw new Error('Run has no collected snapshot.');
    return JSON.parse(row.data_json) as ThreadSnapshot;
  }
  startStep(runId: string, name: string, inputHash: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO run_steps(id,run_id,name,status,started_at,input_hash) VALUES(?,?,?,?,?,?)').run(id, runId, name, 'running', now(), inputHash);
    return id;
  }
  finishStep(id: string, outputPath?: string, error?: unknown): void {
    this.db.prepare('UPDATE run_steps SET status=?,finished_at=?,output_path=?,error_json=? WHERE id=?').run(error ? 'failed' : 'completed', now(), outputPath ?? null, error ? JSON.stringify(error) : null, id);
  }
  addDraft(runId: string, draft: AnalysisDraft): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO spec_revisions VALUES(?,?,?,?,?,?,?)').run(id, runId, null, now(), 'model', 'pending', JSON.stringify(draft));
    return id;
  }
  latestRevision(runId: string): { id: string; origin: string; data_json: string } {
    const revision = this.db.prepare('SELECT id,origin,data_json FROM spec_revisions WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as { id: string; origin: string; data_json: string } | undefined;
    if (!revision) throw new Error('Run has no analysis to review.');
    return revision;
  }
  review(runId: string, draft: AnalysisDraft, reason: string, minutes: number, actor: string, id = randomUUID()): string {
    if (!reason.trim() || !actor.trim() || !Number.isFinite(minutes) || minutes < 0) throw new Error('Review requires reason, actor, and nonnegative finite minutes.');
    const parent = this.db.prepare('SELECT id FROM spec_revisions WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as {id: string} | undefined;
    if (!parent) throw new Error('Run has no analysis to review.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO spec_revisions VALUES(?,?,?,?,?,?,?)').run(id, runId, parent.id, now(), 'human', 'accepted', JSON.stringify(draft));
      this.db.prepare('INSERT INTO interventions VALUES(?,?,?,?,?,?,?)').run(randomUUID(), runId, id, now(), reason, minutes, actor);
      this.status(runId, draft.questions.some(q => q.blocking) ? 'needs_input' : 'ready');
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    return row as unknown as RunRecord;
  }
  list(projectId: string, limit = 20): RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000.');
    return this.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as unknown as RunRecord[];
  }
  detail(id: string): { run: RunRecord; steps: unknown[]; revisions: unknown[]; interventions: unknown[] } {
    return { run: this.getRun(id),
      steps: this.db.prepare('SELECT * FROM run_steps WHERE run_id=? ORDER BY rowid').all(id),
      revisions: this.db.prepare('SELECT * FROM spec_revisions WHERE run_id=? ORDER BY rowid').all(id),
      interventions: this.db.prepare('SELECT * FROM interventions WHERE run_id=? ORDER BY rowid').all(id) };
  }
}
