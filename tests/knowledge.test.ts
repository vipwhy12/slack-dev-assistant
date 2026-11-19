import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { snapshotContentHash, type ThreadSnapshot } from '../src/domain.js';
import { BudgetLedger, type GenerationClient } from '../src/generation.js';
import { FileKnowledgeExtractor, OpenAIKnowledgeExtractor, validateKnowledge, type KnowledgeDraft, type KnowledgeExtractor } from '../src/knowledge.js';
import { KnowledgeStore } from '../src/knowledge-store.js';
import { queryKnowledge, saveKnowledge } from '../src/knowledge-workflow.js';

const url = 'https://example.slack.com/archives/CDEMO12345/p1795046400000001';
const source = JSON.parse(readFileSync(new URL('../examples/thread.json', import.meta.url), 'utf8')) as ThreadSnapshot;
const draft: KnowledgeDraft = {
  summary: 'CSV 내보내기의 형식과 범위를 보관합니다.',
  items: [
    { id: 'csv', kind: 'entity', key: 'export.csv', title: 'CSV 내보내기', statement: '첫 버전은 CSV만 제공합니다.', certainty: 'stated',
      evidence: [{messageVersionId: 'demo-message-2-v1', quote: '첫 버전은 CSV 내보내기만 제공합니다.'}] },
    { id: 'encoding', kind: 'rule', key: ' Export.Encoding ', title: '파일 인코딩', statement: 'CSV 파일은 UTF-8이어야 합니다.', certainty: 'stated',
      evidence: [{messageVersionId: 'demo-message-4-v1', quote: 'CSV 파일은 UTF-8이어야 합니다.'}] },
    { id: 'timezone', kind: 'decision', key: 'export.timezone', title: '시간대 제안', statement: 'KST는 아직 미확정 제안입니다.', certainty: 'uncertain',
      evidence: [{messageVersionId: 'demo-message-3-v1', quote: '시간대는 아직 확정하지 않았습니다.'}] },
  ],
  relationships: [{sourceId: 'csv', predicate: 'encoding', targetId: 'encoding',
    evidence: [{messageVersionId: 'demo-message-4-v1', quote: 'CSV 파일은 UTF-8이어야 합니다.'}] }],
  uncertainties: ['시간대를 확인해야 합니다.'],
};
let directory: string;
let config: ProjectConfig;
function fixture() {
  const extractor: KnowledgeExtractor = { name: 'fixture', model: 'offline', promptVersion: 'v1', extract: vi.fn(async () => structuredClone(draft)) };
  return {config, threadUrl: url, collect: vi.fn(async () => structuredClone(source)), extractor};
}
function counts() {
  const db = new DatabaseSync(join(directory, 'knowledge.sqlite'));
  try { return Object.fromEntries(['snapshots', 'messages', 'sets', 'items', 'relationships', 'item_evidence'].map(table => {
    const row = db.prepare(`SELECT count(*) AS count FROM knowledge_${table}`).get() as {count: number};
    return [table, row.count];
  })); } finally { db.close(); }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-knowledge-'));
  config = { projectId: 'test', slack: { workspace: 'example', channelIds: ['CDEMO12345'] }, storageDir: directory, model: 'fixture' };
});
afterEach(() => rmSync(directory, {recursive: true, force: true}));

describe('normalized domain knowledge', () => {
  it('stores normalized items, relationships, immutable evidence and explicit review state', async () => {
    const result = await saveKnowledge(fixture());
    expect(result).toMatchObject({status: 'unreviewed', reused: false, itemCount: 3, relationshipCount: 1, conflictCount: 0});
    expect(counts()).toEqual({snapshots: 1, messages: 4, sets: 1, items: 3, relationships: 1, item_evidence: 3});
    const rows = queryKnowledge(config);
    expect(rows).toHaveLength(3);
    const encoding = rows.find(row => row.key === 'export.encoding')!;
    expect(encoding).toMatchObject({kind: 'rule', state: 'unreviewed', reviewState: 'unreviewed', scope: {projectId: 'test', workspace: 'example', channelId: 'CDEMO12345', rootTs: source.rootTs}});
    expect(encoding.evidence[0]).toMatchObject({messageVersionId: 'demo-message-4-v1', quote: 'CSV 파일은 UTF-8이어야 합니다.', text: source.messages[3]!.text, permalink: source.messages[3]!.permalink, snapshotId: result.snapshotId});
    expect(encoding.relationships[0]?.evidence[0]?.quote).toBe('CSV 파일은 UTF-8이어야 합니다.');
    expect(rows.find(row => row.key === 'export.timezone')?.state).toBe('uncertain');
    expect(readFileSync(result.reportPath, 'utf8')).toContain('모든 항목은 검토 전');
    expect(readFileSync(result.reportPath, 'utf8')).toContain(source.messages[3]!.permalink);
    expect(statSync(join(directory, 'knowledge.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('reuses identical content without a second extraction, preserving original collection metadata', async () => {
    const options = fixture(); const first = await saveKnowledge(options);
    const again = structuredClone(source); again.collectedAt = '2026-11-19T12:30:00.000Z';
    const second = await saveKnowledge({...options, collect: async () => again});
    expect(second).toMatchObject({snapshotId: first.snapshotId, knowledgeSetId: first.knowledgeSetId, reused: true});
    expect(options.extractor.extract).toHaveBeenCalledTimes(1);
    expect(counts().sets).toBe(1);
    const artifact = JSON.parse(readFileSync(join(directory, 'knowledge', first.knowledgeSetId, 'snapshot.json'), 'utf8')) as ThreadSnapshot;
    expect(artifact.collectedAt).toBe(source.collectedAt);
  });
  it('keeps history after source edits and only returns the latest snapshot as current knowledge', async () => {
    const options = fixture(); const first = await saveKnowledge(options);
    const next = structuredClone(source);
    next.messages[3]!.text = '확인: CSV 파일은 UTF-16이어야 합니다.';
    next.messages[3]!.id = 'demo-message-4-v2'; next.messages[3]!.editedTs = '1795046600.000001';
    const changedDraft = structuredClone(draft);
    changedDraft.items[1]!.statement = 'CSV 파일은 UTF-16이어야 합니다.';
    changedDraft.items[1]!.evidence = [{messageVersionId: 'demo-message-4-v2', quote: 'CSV 파일은 UTF-16이어야 합니다.'}];
    changedDraft.relationships[0]!.evidence = changedDraft.items[1]!.evidence;
    const second = await saveKnowledge({...options, collect: async () => next, extractor: {...options.extractor, extract: async () => changedDraft}});
    expect(second).toMatchObject({reused: false, conflictCount: 0});
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(counts()).toMatchObject({snapshots: 2, messages: 8, sets: 2, items: 6});
    expect(queryKnowledge(config, 'UTF-8')).toHaveLength(0);
    expect(queryKnowledge(config, 'UTF-16')[0]?.evidence[0]?.editedTs).toBe('1795046600.000001');
    const store = new KnowledgeStore(join(directory, 'knowledge.sqlite'));
    try {
      expect(store.getSnapshot(first.snapshotId).messages[3]!.text).toBe(source.messages[3]!.text);
      expect(store.getDraft(first.knowledgeSetId).items[1]!.statement).toContain('UTF-8');
    } finally { store.close(); }
    const restored = await saveKnowledge(options);
    expect(restored).toMatchObject({knowledgeSetId: first.knowledgeSetId, reused: true});
    expect(options.extractor.extract).toHaveBeenCalledTimes(1);
    expect(queryKnowledge(config, 'UTF-8')).toHaveLength(1);
  });
  it('flags differing claims with the same normalized key without overwriting either source', async () => {
    await saveKnowledge(fixture());
    const next = structuredClone(source); next.rootTs = '1795047400.000001';
    next.messages = [{...source.messages[0]!, id: 'second-root', ts: next.rootTs, text: 'CSV 파일은 UTF-16이어야 합니다.', permalink: url.replace('p1795046400000001', 'p1795047400000001')}];
    const other: KnowledgeDraft = {summary: '다른 인코딩 주장', items: [{...draft.items[1]!, id: 'other', key: 'export.encoding', statement: next.messages[0]!.text, evidence: [{messageVersionId: 'second-root', quote: next.messages[0]!.text}]}], relationships: [], uncertainties: []};
    const result = await saveKnowledge({...fixture(), threadUrl: next.messages[0]!.permalink, collect: async () => next, extractor: {...fixture().extractor, extract: async () => other}});
    expect(result.conflictCount).toBe(1);
    const encoding = queryKnowledge(config, 'export.encoding');
    expect(encoding).toHaveLength(2);
    expect(encoding.every(row => row.state === 'conflicting' && row.reviewState === 'unreviewed' && row.conflictItemIds.length === 1)).toBe(true);
  });
  it('preserves distinct opposing claims in the same thread', async () => {
    const opposing = structuredClone(draft);
    opposing.items.push({...draft.items[1]!, id: 'another-encoding', statement: '파일 인코딩은 검토가 필요합니다.', certainty: 'uncertain'});
    const result = await saveKnowledge({...fixture(), extractor: {...fixture().extractor, extract: async () => opposing}});
    expect(result.conflictCount).toBe(2);
    expect(queryKnowledge(config, 'export.encoding').every(row => row.state === 'conflicting')).toBe(true);
  });
  it('scopes queries and deduplication to project, workspace and configured channels', async () => {
    const options = fixture(); await saveKnowledge(options);
    const foreign = {...config, projectId: 'other'};
    expect(queryKnowledge(foreign)).toEqual([]);
    expect(queryKnowledge({...config, slack: {...config.slack, workspace: 'outsider'}})).toEqual([]);
    expect(queryKnowledge({...config, slack: {...config.slack, channelIds: ['COTHER1']}})).toEqual([]);
    const second = await saveKnowledge({...options, config: foreign});
    expect(second.reused).toBe(false);
    expect(options.extractor.extract).toHaveBeenCalledTimes(2);
    expect(queryKnowledge(foreign).every(row => row.scope.projectId === 'other' && row.conflictItemIds.length === 0)).toBe(true);
  });
  it('rejects out-of-scope sources before collecting or invoking an extractor', async () => {
    const options = fixture();
    await expect(saveKnowledge({...options, threadUrl: url.replace('example.', 'foreign.')})).rejects.toThrow('workspace');
    expect(options.collect).not.toHaveBeenCalled(); expect(options.extractor.extract).not.toHaveBeenCalled();
  });
  it('rejects incomplete collection without extracting and hides knowledge from an older observed snapshot', async () => {
    const options = fixture(); await saveKnowledge(options);
    await expect(saveKnowledge({...options, collect: async () => ({...source, status: 'partial', warnings: ['Incomplete pagination']})})).rejects.toThrow('complete thread snapshot');
    expect(options.extractor.extract).toHaveBeenCalledTimes(1);
    expect(queryKnowledge(config)).toEqual([]);
    expect(counts().snapshots).toBe(2);
  });
  it('escapes SQL search metacharacters and validates result limits', async () => {
    await saveKnowledge(fixture());
    expect(queryKnowledge(config, '%')).toEqual([]);
    expect(queryKnowledge(config, "' OR 1=1 --")).toEqual([]);
    expect(queryKnowledge(config, 'CSV', 1)).toHaveLength(1);
    expect(() => queryKnowledge(config, '', 0)).toThrow('limit');
  });
});

describe('knowledge source validation and durable failure boundaries', () => {
  it('rejects invented evidence, source IDs, dangling relations and inferred approval fields', () => {
    const invented = structuredClone(draft); invented.items[0]!.evidence[0]!.quote = 'Not in the source';
    expect(() => validateKnowledge(invented, source)).toThrow('exact quote');
    const wrongSource = structuredClone(draft); wrongSource.items[0]!.evidence[0]!.messageVersionId = 'foreign';
    expect(() => validateKnowledge(wrongSource, source)).toThrow('exact quote');
    const badRelation = structuredClone(draft); badRelation.relationships[0]!.targetId = 'missing';
    expect(() => validateKnowledge(badRelation, source)).toThrow('unknown item');
    expect(() => validateKnowledge({...draft, reviewState: 'accepted'}, source)).toThrow();
  });
  it('rolls back every normalized item when a foreign-key insert fails mid-transaction', () => {
    const store = new KnowledgeStore(join(directory, 'knowledge.sqlite'));
    try {
      const snapshot = {...source, contentHash: snapshotContentHash(source)};
      const {snapshotId, threadId} = store.observe(config.projectId, snapshot);
      const setId = store.claim('rollback-input', snapshotId, threadId, fixture().extractor);
      const broken = structuredClone(draft); broken.items[1]!.evidence[0]!.messageVersionId = 'missing-version';
      expect(() => store.complete(setId, broken)).toThrow('FOREIGN KEY');
      expect(counts()).toMatchObject({items: 0, relationships: 0, item_evidence: 0, sets: 1});
      expect(store.find('rollback-input')?.status).toBe('extracting');
      store.complete(setId, draft);
      expect(store.query(config)).toHaveLength(3);
    } finally { store.close(); }
  });
  it('records a failed extraction and blocks an automatic duplicate paid retry', async () => {
    const options = fixture(); options.extractor.extract = vi.fn(async () => {throw new Error('Provider interrupted');});
    await expect(saveKnowledge(options)).rejects.toThrow('Provider interrupted');
    await expect(saveKnowledge(options)).rejects.toThrow('duplicate API charges');
    expect(options.extractor.extract).toHaveBeenCalledTimes(1);
    expect(queryKnowledge(config)).toEqual([]);
    const db = new DatabaseSync(join(directory, 'knowledge.sqlite'));
    try { expect(db.prepare('SELECT status FROM knowledge_sets').get()).toMatchObject({status: 'failed'}); } finally {db.close();}
  });
  it('prevents concurrent processes from both extracting identical input', async () => {
    const options = fixture(); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = saveKnowledge({...options, extractor: {...options.extractor, extract: async () => { entered(); await gate; return draft; }}});
    await ready;
    try { await expect(saveKnowledge(options)).rejects.toThrow('Another knowledge save'); expect(options.extractor.extract).not.toHaveBeenCalled(); }
    finally { release(); await first; }
    expect((await saveKnowledge(options)).reused).toBe(true);
  });
  it('rejects symlink databases rather than changing unrelated file permissions', () => {
    const target = join(directory, 'target'); writeFileSync(target, 'untouched', {mode: 0o644});
    symlinkSync(target, join(directory, 'knowledge.sqlite'));
    expect(() => queryKnowledge(config)).toThrow('symbolic link');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
  it('includes fixture content identity in offline replay to avoid stale reuse', async () => {
    const file = join(directory, 'fixture.json'); writeFileSync(file, JSON.stringify(draft));
    const first = new FileKnowledgeExtractor(file);
    expect(await first.extract(source)).toEqual(draft);
    writeFileSync(file, JSON.stringify({...draft, summary: '다른 요약'}));
    expect(new FileKnowledgeExtractor(file).promptVersion).not.toBe(first.promptVersion);
  });
});

describe('paid knowledge extraction budget guard', () => {
  function paidConfig(budgetUsd = 10): ProjectConfig {
    return configSchema.parse({...config, model: 'gpt-4.1-mini', development: {readPaths: ['src'], writePaths: ['src'], commands: [{id: 'test', program: 'node', args: []}], dockerImage: 'test:local', budgetUsd}});
  }
  it('uses one bounded structured request with no retries, retains source data and settles usage', async () => {
    const parse = vi.fn(async () => ({status: 'completed', output_parsed: draft, usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}, output: []}));
    const client: GenerationClient = {responses: {parse}};
    const extractor = new OpenAIKnowledgeExtractor(paidConfig(), {client});
    const result = await saveKnowledge({...fixture(), config: paidConfig(), extractor});
    expect(result.itemCount).toBe(3);
    expect(parse).toHaveBeenCalledTimes(1);
    const call = parse.mock.calls[0] as unknown as [{input: string; instructions: string; store: boolean; max_output_tokens: number}];
    expect(call[0]).toMatchObject({store: false, max_output_tokens: 8192});
    expect(call[0].instructions).toContain('untrusted data');
    expect(call[0].input).not.toContain(directory);
    expect(extractor.usage?.estimatedCostUsd).toBeCloseTo(0.000072);
    await saveKnowledge({...fixture(), config: paidConfig(), extractor});
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('does not call the provider when budget is insufficient or source contains a recognizable credential', async () => {
    const parse = vi.fn(); const client: GenerationClient = {responses: {parse}};
    await expect(new OpenAIKnowledgeExtractor(paidConfig(0.01), {client}).extract(source)).rejects.toThrow('budget');
    const secret = structuredClone(source); secret.messages[0]!.text = `token xoxb-${'A'.repeat(24)}`;
    await expect(new OpenAIKnowledgeExtractor(paidConfig(), {client}).extract(secret)).rejects.toThrow('credential');
    expect(parse).not.toHaveBeenCalled();
    const ledger = new BudgetLedger(directory); try { expect(ledger.summary().requests).toBe(0); } finally {ledger.close();}
  });
});
