import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { analyzeThread, normalizeSnapshot, reviewRun, safeError, FileAnalyzer } from '../src/workflow.js';
import { loadConfig, type ProjectConfig } from '../src/config.js';
import { RunStore } from '../src/store.js';
import type { ThreadSnapshot } from '../src/domain.js';
import type { AnalysisDraft, Analyzer } from '../src/analysis.js';

const url = 'https://example.slack.com/archives/CDEMO12345/p1795046400000001';
const rawSnapshot = JSON.parse(readFileSync(new URL('../examples/thread.json', import.meta.url), 'utf8')) as ThreadSnapshot;
const rawDraft = JSON.parse(readFileSync(new URL('../examples/analysis.json', import.meta.url), 'utf8')) as AnalysisDraft;
let directory: string;
let config: ProjectConfig;
function fixture() {
  const analyzer: Analyzer = { name: 'test', model: 'fixture', promptVersion: 'v1', analyze: vi.fn(async () => structuredClone(rawDraft)) };
  const collect = vi.fn(async () => structuredClone(rawSnapshot));
  return { config, threadUrl: url, analyzer, collect };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-dev-test-'));
  config = { projectId: 'test', slack: { workspace: 'example', channelIds: ['CDEMO12345'] }, storageDir: directory, model: 'fixture' };
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('analyze pipeline and durable history', () => {
  it('persists an immutable snapshot, validated draft, step checkpoints and readable evidence report', async () => {
    const result = await analyzeThread(fixture());
    expect(result.status).toBe('needs_input');
    expect(readFileSync(result.reportPath!, 'utf8')).toContain('https://example.slack.com/');
    const store = new RunStore(join(directory, 'history.sqlite'));
    try {
      const detail = store.detail(result.runId);
      expect(detail.steps).toHaveLength(2);
      expect(detail.revisions).toHaveLength(1);
      expect(detail.revisions[0]).toMatchObject({ origin: 'model', review_state: 'pending' });
      expect(store.getSnapshot(result.runId).messages).toEqual(rawSnapshot.messages);
      expect(JSON.parse(detail.run.input_json)).toMatchObject({ workflowVersion: 'analyze-v1', analyzer: { model: 'fixture' } });
      expect(detail.run.finished_at).toBeTruthy();
    } finally { store.close(); }
  });
  it('reuses identical inputs without a second model call; force creates a new draft', async () => {
    const options = fixture();
    const first = await analyzeThread(options);
    const second = await analyzeThread(options);
    expect(second).toMatchObject({ runId: first.runId, reused: true });
    expect(second.requestRunId).not.toBe(first.runId);
    expect(options.analyzer.analyze).toHaveBeenCalledTimes(1);
    const forced = await analyzeThread({ ...options, force: true });
    expect(forced.runId).not.toBe(first.runId);
    expect(forced.reused).toBe(false);
    expect(options.analyzer.analyze).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a changed model or changed source snapshot', async () => {
    const options = fixture();
    await analyzeThread(options);
    const modelChange = await analyzeThread({ ...options, analyzer: { ...options.analyzer, model: 'new' } });
    expect(modelChange.reused).toBe(false);
    const changed = structuredClone(rawSnapshot);
    changed.messages[0]!.text += '\n추가 정보';
    const sourceChange = await analyzeThread({ ...options, collect: async () => changed });
    expect(sourceChange.reused).toBe(false);
  });
  it('preserves partial collection and refuses to send it to the model', async () => {
    const options = fixture();
    const partial = { ...rawSnapshot, status: 'partial' as const, warnings: ['pagination failed'] };
    const result = await analyzeThread({ ...options, collect: async () => partial });
    expect(result).toMatchObject({ status: 'needs_input', reportPath: null });
    expect(options.analyzer.analyze).not.toHaveBeenCalled();
    const store = new RunStore(join(directory, 'history.sqlite'));
    try { expect(store.getSnapshot(result.runId).status).toBe('partial'); } finally { store.close(); }
  });
  it('records a failed analysis and releases the lock for retry', async () => {
    const options = fixture();
    await expect(analyzeThread({ ...options, analyzer: { ...options.analyzer, analyze: async () => ({ invalid: true }) } })).rejects.toThrow();
    const store = new RunStore(join(directory, 'history.sqlite'));
    try {
      const run = store.list(config.projectId)[0]!;
      expect(run.status).toBe('failed');
      expect(store.detail(run.id).steps[1]).toMatchObject({ status: 'failed' });
    } finally { store.close(); }
    expect((await analyzeThread(options)).reused).toBe(false);
  });
  it('persists the original failure when a best-effort usage artifact cannot be written', async () => {
    const options = fixture();
    const analyzer: Analyzer = { ...options.analyzer,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      analyze: async () => {
        const runId = readdirSync(join(directory, 'runs'))[0]!;
        mkdirSync(join(directory, 'runs', runId, 'usage.json'));
        throw new Error('original provider failure');
      },
    };
    await expect(analyzeThread({ ...options, analyzer })).rejects.toThrow('original provider failure');
    const store = new RunStore(join(directory, 'history.sqlite'));
    try {
      const run = store.list(config.projectId)[0]!;
      expect(run.status).toBe('failed');
      expect(store.detail(run.id).steps[1]).toMatchObject({ status: 'failed' });
    } finally { store.close(); }
  });
  it('refuses out-of-scope URLs before collecting or invoking the model', async () => {
    const options = fixture();
    await expect(analyzeThread({ ...options, threadUrl: url.replace('example.', 'outsider.') })).rejects.toThrow();
    expect(options.collect).not.toHaveBeenCalled();
    expect(options.analyzer.analyze).not.toHaveBeenCalled();
  });
  it('does not let an edited replay fixture inherit the old input key', () => {
    const one = normalizeSnapshot(rawSnapshot, config, url);
    const changed = structuredClone(rawSnapshot); changed.messages[0]!.text += ' Changed';
    const two = normalizeSnapshot(changed, config, url);
    expect(two.contentHash).not.toBe(one.contentHash);
  });
  it('rejects a source permalink pointing at another message', () => {
    const bad = structuredClone(rawSnapshot);
    bad.messages[0]!.permalink = bad.messages[0]!.permalink.replace(/\d$/, '9');
    expect(() => normalizeSnapshot(bad, config, url)).toThrow('permalink');
  });
  it('rejects a conflicting explicit thread root even if the requested message exists', () => {
    expect(() => normalizeSnapshot(rawSnapshot, config, `${url}?thread_ts=1795046400.999999`)).toThrow('root');
  });
});

describe('human revisions and locking', () => {
  it('adds a human revision and time entry while keeping the original draft', async () => {
    const run = await analyzeThread(fixture());
    const revised = structuredClone(rawDraft); revised.summary = '사람이 검토한 요약';
    const result = reviewRun(config, run.runId, revised, '표현과 근거를 확인함', 3.5, 'reviewer');
    expect(existsSync(result.reportPath)).toBe(true);
    const store = new RunStore(join(directory, 'history.sqlite'));
    try {
      const detail = store.detail(run.runId);
      expect(detail.revisions).toHaveLength(2);
      expect(detail.revisions[0]).toMatchObject({ review_state: 'pending', data_json: JSON.stringify(rawDraft) });
      expect(detail.revisions[1]).toMatchObject({ review_state: 'accepted', origin: 'human' });
      expect(detail.interventions[0]).toMatchObject({ minutes: 3.5, actor: 'reviewer' });
      expect(JSON.stringify(detail)).not.toContain('executionGrant');
    } finally { store.close(); }
  });
  it('rejects invalid reviewed evidence and invalid review time without a revision', async () => {
    const run = await analyzeThread(fixture());
    const bad = structuredClone(rawDraft); bad.requirements[0]!.sourceRefs[0]!.quote = 'invented quote';
    expect(() => reviewRun(config, run.runId, bad, 'change', 1, 'human')).toThrow();
    expect(() => reviewRun(config, run.runId, rawDraft, 'change', -1, 'human')).toThrow();
    const store = new RunStore(join(directory, 'history.sqlite'));
    try { expect(store.detail(run.runId).revisions).toHaveLength(1); } finally { store.close(); }
  });
  it('returns the latest human revision report when an analyzed input is reused', async () => {
    const options = fixture(); const run = await analyzeThread(options);
    const revised = structuredClone(rawDraft); revised.summary = 'Human-reviewed correction';
    const review = reviewRun(config, run.runId, revised, 'corrected', 2, 'human');
    const repeated = await analyzeThread(options);
    expect(repeated.reportPath).toBe(review.reportPath);
    expect(readFileSync(repeated.reportPath!, 'utf8')).toContain('Human');
    expect(readFileSync(join(directory, 'runs', run.runId, 'analysis.json'), 'utf8')).not.toContain('Human-reviewed correction');
  });
  it('does not accept a human revision when report storage fails', async () => {
    const run = await analyzeThread(fixture());
    writeFileSync(join(directory, 'runs', run.runId, 'reviews'), 'prevent directory creation');
    expect(() => reviewRun(config, run.runId, rawDraft, 'accept', 1, 'human')).toThrow();
    const store = new RunStore(join(directory, 'history.sqlite'));
    try {
      expect(store.detail(run.runId).revisions).toHaveLength(1);
      expect(store.getRun(run.runId).status).toBe('needs_input');
    } finally { store.close(); }
  });
  it('rejects concurrent writers and permits acquisition after release', () => {
    const first = new RunStore(join(directory, 'history.sqlite'));
    const second = new RunStore(join(directory, 'history.sqlite'));
    try {
      first.acquireLock(); expect(() => second.acquireLock()).toThrow('Another run');
      first.releaseLock(); expect(() => second.acquireLock()).not.toThrow();
    } finally { first.close(); second.close(); }
  });
  it('marks abandoned run and step failed when recovering a dead-process lock', () => {
    const path = join(directory, 'history.sqlite'); const store = new RunStore(path);
    store.saveProject('test', config, 'hash'); const id = store.createRun('test', {});
    store.status(id, 'collecting'); store.startStep(id, 'collect', 'hash'); store.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO process_lock VALUES(1,?,?)').run('dead', 2147483647); db.close();
    const next = new RunStore(path);
    try {
      next.acquireLock(); expect(next.getRun(id).status).toBe('failed');
      expect(next.detail(id).steps[0]).toMatchObject({ status: 'failed' });
    } finally { next.close(); }
  });
});

describe('configuration and real CLI', () => {
  it('resolves configured paths relative to the config file', () => {
    const file = join(directory, 'config.json');
    writeFileSync(file, JSON.stringify({ ...config, storageDir: 'data', repoPath: './repo' }));
    expect(loadConfig(file)).toMatchObject({ storageDir: join(directory, 'data'), repoPath: join(directory, 'repo') });
  });
  it('replays the sample through the CLI without credentials', () => {
    const file = join(directory, 'config.json'); writeFileSync(file, JSON.stringify(config));
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'analyze', url, '--config', file,
      '--snapshot', resolve('examples/thread.json'), '--analysis-file', resolve('examples/analysis.json')],
    { encoding: 'utf8', env: { ...process.env, SLACK_TOKEN: '', OPENAI_API_KEY: '', DOTENV_CONFIG_QUIET: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'needs_input', reused: false });
  });
  it('includes replay contents in the analyzer identity', () => {
    const file = join(directory, 'draft.json'); writeFileSync(file, JSON.stringify(rawDraft));
    const first = new FileAnalyzer(file); writeFileSync(file, JSON.stringify({ ...rawDraft, summary: 'changed' }));
    expect(new FileAnalyzer(file).promptVersion).not.toBe(first.promptVersion);
  });
  it('redacts credential-like secrets from stored/displayed failures', () => {
    expect(safeError(new Error('invalid token xoxb-secret-value sk-secret-key')).message).toBe('invalid token [REDACTED] [REDACTED]');
  });
});
