import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Analyzer, AnalysisDraft } from './analysis.js';
import { validateAnalysis, renderReport } from './analysis.js';
import type { ProjectConfig } from './config.js';
import { hash, snapshotSchema, snapshotContentHash, type ThreadSnapshot } from './domain.js';
import { parseThreadUrl } from './slack.js';
import { RunStore } from './store.js';

export const WORKFLOW_VERSION = 'analyze-v1';
export const SCHEMA_VERSION = 'requirements-v1';
export interface AnalyzeOptions {
  config: ProjectConfig; threadUrl: string; analyzer: Analyzer;
  collect: () => Promise<ThreadSnapshot>; force?: boolean;
}
export interface AnalyzeResult { runId: string; requestRunId: string; status: string; reused: boolean; reportPath: string | null }
export function writeArtifact(path: string, value: unknown, plain = false): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, plain ? String(value) : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
export function safeError(error: unknown): { code: string; message: string; retryable: boolean } {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const key of ['SLACK_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = process.env[key];
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  message = message.replace(/\b(?:xox[a-z]-|xapp-|sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/https:\/\/hooks\.slack\.com\/\S+/g, '[REDACTED]').slice(0, 2000);
  const code = /rate.?limit|429/i.test(message) ? 'rate_limited'
    : /auth|token|scope|permission|not_in_channel|channel_not_found/i.test(message) ? 'access_denied'
    : /network|timeout|ECONN|fetch failed/i.test(message) ? 'network_error'
    : /quote|evidence|sourceRef|schema|validation|JSON|requirement|question|analysis/i.test(message) ? 'invalid_analysis'
    : 'execution_error';
  return { code, message, retryable: ['rate_limited', 'network_error'].includes(code) };
}
export function normalizeSnapshot(input: unknown, config: ProjectConfig, threadUrl: string): ThreadSnapshot {
  const parsed = snapshotSchema.parse(input);
  const target = parseThreadUrl(threadUrl, config.slack);
  if (parsed.workspace !== target.workspace || parsed.channelId !== target.channelId) throw new Error('Snapshot does not belong to the requested workspace/channel.');
  if (new URL(threadUrl).searchParams.has('thread_ts') && target.rootTs !== parsed.rootTs) throw new Error('Snapshot root does not match the requested thread.');
  if (target.rootTs !== parsed.rootTs && target.messageTs !== parsed.rootTs && !parsed.messages.some(m => m.ts === target.messageTs)) throw new Error('Snapshot does not contain the requested thread.');
  if (parsed.status === 'complete' && !parsed.messages.some(m => m.ts === target.messageTs)) throw new Error('Snapshot does not contain the requested message.');
  if (new Set(parsed.messages.map(m => m.id)).size !== parsed.messages.length || new Set(parsed.messages.map(m => m.ts)).size !== parsed.messages.length) throw new Error('Snapshot contains duplicate message identities.');
  if (parsed.status === 'complete' && !parsed.messages.some(m => m.ts === parsed.rootTs)) throw new Error('Complete snapshot must include its root message.');
  for (const message of parsed.messages) {
    const link = parseThreadUrl(message.permalink, config.slack);
    if (link.channelId !== parsed.channelId || link.messageTs !== message.ts ||
      (new URL(message.permalink).searchParams.has('thread_ts') && link.rootTs !== parsed.rootTs)) throw new Error('Snapshot permalink does not match its source message.');
  }
  return { ...parsed, id: randomUUID(), contentHash: snapshotContentHash(parsed) };
}
export class FileAnalyzer implements Analyzer {
  readonly name = 'file-replay'; readonly model = 'fixture'; readonly promptVersion: string;
  private data: unknown;
  constructor(path: string) {
    this.data = JSON.parse(readFileSync(path, 'utf8'));
    this.promptVersion = `file:${hash(this.data)}`;
  }
  async analyze(): Promise<unknown> { return this.data; }
}
export async function analyzeThread(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { config, analyzer } = options;
  const target = parseThreadUrl(options.threadUrl, config.slack);
  const repoCommitSha = config.repoPath
    ? execFileSync('git', ['-C', config.repoPath, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    : null;
  const configHash = hash(config);
  const store = new RunStore(join(config.storageDir, 'history.sqlite'));
  let runId: string | undefined;
  let stepId: string | undefined;
  try {
    store.acquireLock();
    store.saveProject(config.projectId, config, configHash);
    const input = { target, repoCommitSha, projectConfigHash: configHash, projectConfig: config,
      workflowVersion: WORKFLOW_VERSION, schemaVersion: SCHEMA_VERSION,
      analyzer: { name: analyzer.name, model: analyzer.model, promptVersion: analyzer.promptVersion } };
    runId = store.createRun(config.projectId, input);
    const directory = join(config.storageDir, 'runs', runId);
    store.status(runId, 'collecting');
    stepId = store.startStep(runId, 'collect', hash(target));
    const snapshot = normalizeSnapshot(await options.collect(), config, options.threadUrl);
    store.saveSnapshot(runId, snapshot);
    const snapshotPath = join(directory, 'snapshot.json');
    writeArtifact(snapshotPath, snapshot);
    store.finishStep(stepId, snapshotPath); stepId = undefined;
    if (snapshot.status !== 'complete') {
      store.status(runId, 'needs_input', { code: 'partial_collection', message: 'Collection is incomplete. Resolve collection warnings and run analyze again.', retryable: true });
      return { runId, requestRunId: runId, status: 'needs_input', reused: false, reportPath: null };
    }
    const inputHash = hash({ projectId: config.projectId, contentHash: snapshot.contentHash, repoCommitSha,
      configHash, workflow: WORKFLOW_VERSION, schema: SCHEMA_VERSION, mode: 'analyze', analyzer: input.analyzer });
    const previous = options.force ? undefined : store.findReusable(inputHash, config.projectId);
    store.setInputHash(runId, inputHash);
    if (previous) {
      const revision = store.latestRevision(previous.id);
      const reportDirectory = revision.origin === 'human'
        ? join(config.storageDir, 'runs', previous.id, 'reviews', revision.id)
        : join(config.storageDir, 'runs', previous.id);
      const reportPath = join(reportDirectory, 'report.md');
      writeArtifact(reportPath, renderReport(JSON.parse(revision.data_json), store.getSnapshot(previous.id)), true);
      store.reuse(runId, previous.id);
      return { runId: previous.id, requestRunId: runId, status: previous.status, reused: true, reportPath };
    }
    if (analyzer.knowledgeContext) writeArtifact(join(directory, 'knowledge-context.json'), analyzer.knowledgeContext);
    store.status(runId, 'analyzing');
    stepId = store.startStep(runId, 'analyze', inputHash);
    const draft = validateAnalysis(await analyzer.analyze(snapshot), snapshot);
    writeArtifact(join(directory, 'analysis.json'), draft);
    const reportPath = join(directory, 'report.md');
    writeArtifact(reportPath, renderReport(draft, snapshot), true);
    const revisionId = store.addDraft(runId, draft);
    writeArtifact(join(directory, 'metadata.json'), { ...input, runId, snapshotId: snapshot.id, contentHash: snapshot.contentHash, inputHash, revisionId, reviewState: 'pending', executionGrant: null, usage: analyzer.usage ?? null, cost: null });
    store.finishStep(stepId, reportPath); stepId = undefined;
    store.status(runId, 'needs_input');
    return { runId, requestRunId: runId, status: 'needs_input', reused: false, reportPath };
  } catch (error) {
    const failure = safeError(error);
    if (runId && analyzer.usage) {
      try { writeArtifact(join(config.storageDir, 'runs', runId, 'usage.json'), analyzer.usage); }
      catch { /* Preserve the original failure when storage itself is unavailable. */ }
    }
    if (stepId) store.finishStep(stepId, undefined, failure);
    if (runId) store.status(runId, 'failed', failure);
    throw new Error(`${failure.message}${runId ? ` (run: ${runId})` : ''}`);
  } finally { store.close(); }
}
export function reviewRun(config: ProjectConfig, runId: string, input: unknown, reason: string, minutes: number, actor: string, expectedRevisionId?: string): { revisionId: string; reportPath: string } {
  const store = new RunStore(join(config.storageDir, 'history.sqlite'));
  try {
    store.acquireLock();
    const run = store.getRun(runId);
    if (run.project_id !== config.projectId) throw new Error('Run belongs to another project.');
    const snapshot = store.getSnapshot(runId);
    const draft: AnalysisDraft = validateAnalysis(input, snapshot);
    if (!reason.trim() || !actor.trim() || !Number.isFinite(minutes) || minutes < 0) throw new Error('Review requires reason, actor, and nonnegative finite minutes.');
    const latest = store.latestRevision(runId);
    if (expectedRevisionId && latest.id !== expectedRevisionId) throw new Error('Analysis changed after approval; review the latest revision.');
    const revisionId = randomUUID();
    const directory = join(config.storageDir, 'runs', runId, 'reviews', revisionId);
    const reportPath = join(directory, 'report.md');
    try {
      writeArtifact(join(directory, 'analysis.json'), draft);
      writeArtifact(reportPath, renderReport(draft, snapshot), true);
      store.review(runId, draft, reason, minutes, actor, revisionId);
    } catch (error) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* No DB revision has been accepted. */ }
      throw error;
    }
    return { revisionId, reportPath };
  } finally { store.close(); }
}
