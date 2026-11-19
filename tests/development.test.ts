import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { analyzeThread, reviewRun } from '../src/workflow.js';
import { planRun, approvePlan, implementPlan } from '../src/development.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { PlanDraft, Planner } from '../src/planning.js';
import type { Implementer } from '../src/generation.js';
import type { VerificationRunner } from '../src/runner.js';
import { RunStore } from '../src/store.js';

let root: string;
let config: ProjectConfig;
const url = 'https://example.slack.com/archives/CDEMO12345/p1795046400000001';
const rawSnapshot = JSON.parse(readFileSync(new URL('../examples/thread.json', import.meta.url), 'utf8'));
const quote = rawSnapshot.messages[0].text as string;
const analysis: AnalysisDraft = { summary: '인사 기능을 변경한다.', requirements: [{ id: 'R1', statement: '인사를 한국어로 변경한다.',
  decisionState: 'confirmed', sourceRefs: [{ messageVersionId: rawSnapshot.messages[0].id, quote }],
  supersedesIds: [], blockingQuestionIds: [], acceptanceCriteria: [{ id: 'A1', text: '안녕하세요를 반환한다.', origin: 'derived', sourceRefs: [] }] }], questions: [] };
const baseCode = "export function greet() { return 'hello'; }\n";
const baseTest = "import { greet } from '../src/greet.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(typeof greet(), 'string');\n";
const newCode = "export function greet() { return '안녕하세요'; }\n";
const newTest = "import { greet } from '../src/greet.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet(), '안녕하세요');\n";
const plan: PlanDraft = { summary: '한국어 인사와 회귀 테스트', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: 'hello 반환',
  codeRefs: [{ path: 'src/greet.mjs', quote: "return 'hello';" }], proposedChanges: '한국어로 변경하고 검증한다.',
  affectedPaths: ['src/greet.mjs', 'test/greet.mjs'], dependencies: [], acceptanceChecks: [{ criterionId: 'A1', commandId: 'test', testName: 'Korean greeting' }], blockers: [] }], excludedRequirements: [] };
const planner = (): Planner => ({ name: 'test', model: 'fixture', promptVersion: 'v1', plan: vi.fn(async () => structuredClone(plan)) });
const implementer = (): Implementer => ({ name: 'test', model: 'fixture', promptVersion: 'v1', implement: vi.fn(async () => ({ summary: '한국어 구현', files: [{ path: 'src/greet.mjs', content: newCode }, { path: 'test/greet.mjs', content: newTest }] })) });
function git(...args: string[]): string { return execFileSync('git', ['-C', config.repoPath!, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const runner = (failOnCall = 0): VerificationRunner => {
  let calls = 0;
  return { run: vi.fn(async (_path: string, commands: Parameters<VerificationRunner['run']>[1]) => {
    calls++;
    return commands.map(command => ({ commandId: command.id, program: command.program, args: command.args,
      status: calls === failOnCall ? 'failed' as const : 'passed' as const, exitCode: calls === failOnCall ? 1 : 0,
      durationMs: 1, stdout: '', stderr: '' }));
  }) };
};
async function analyzed(reviewed = true, draft = structuredClone(analysis)) {
  const result = await analyzeThread({ config, threadUrl: url, collect: async () => structuredClone(rawSnapshot), analyzer: {
    name: 'fixture', model: 'fixture', promptVersion: 'v1', analyze: async () => draft,
  } });
  if (reviewed) reviewRun(config, result.runId, draft, 'Synthetic fixture approval', 0, 'test');
  return result.runId;
}
async function approved(options: { allowPr?: boolean } = {}) {
  const sourceRunId = await analyzed();
  const result = await planRun({ config, sourceRunId, planner: planner() });
  const grant = approvePlan(config, result.planId, 'Synthetic plan approval', 'test', options.allowPr);
  return { sourceRunId, result, grant };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-dev-development-'));
  config = configSchema.parse({ projectId: 'test', slack: { workspace: 'example', channelIds: ['CDEMO12345'] }, storageDir: join(root, 'data'), repoPath: join(root, 'repo'), model: 'gpt-4.1-mini',
    development: { readPaths: ['src', 'test'], writePaths: ['src', 'test'], commands: [{ id: 'test', program: 'node', args: ['--test', 'test/greet.mjs'] }], dockerImage: 'node:24' },
    github: { repository: 'example/test', remote: 'origin', baseBranch: 'main' },
  });
  mkdirSync(join(config.repoPath!, 'src'), { recursive: true }); mkdirSync(join(config.repoPath!, 'test'));
  writeFileSync(join(config.repoPath!, 'src/greet.mjs'), baseCode); writeFileSync(join(config.repoPath!, 'test/greet.mjs'), baseTest);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('plan and execution grants', () => {
  it('saves code evidence and reuses identical plans without another generator call', async () => {
    const sourceRunId = await analyzed(); const generator = planner();
    const first = await planRun({ config, sourceRunId, planner: generator });
    const second = await planRun({ config, sourceRunId, planner: generator });
    expect(second).toMatchObject({ planId: first.planId, reused: true });
    expect(generator.plan).toHaveBeenCalledTimes(1);
    expect(readFileSync(first.reportPath, 'utf8')).toContain('greet');
    const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try { expect(store.getRun(first.runId).mode).toBe('plan'); expect(store.detail(first.runId).plans).toHaveLength(1); } finally { store.close(); }
  });
  it('can preview a pending analysis but cannot approve it; a human revision makes the old plan stale', async () => {
    const sourceRunId = await analyzed(false);
    const result = await planRun({ config, sourceRunId, planner: planner() });
    expect(() => approvePlan(config, result.planId, 'approve', 'test')).toThrow('Review the requirements');
    reviewRun(config, sourceRunId, analysis, 'Synthetic review', 0, 'test');
    expect(() => approvePlan(config, result.planId, 'approve', 'test')).toThrow('stale');
  });
  it('rejects proposed requirements and blocking questions even after human review', async () => {
    const draft = structuredClone(analysis); draft.requirements[0]!.decisionState = 'proposed';
    const sourceRunId = await analyzed(true, draft); const result = await planRun({ config, sourceRunId, planner: planner() });
    expect(() => approvePlan(config, result.planId, 'approve', 'test')).toThrow('confirmed');
    draft.requirements[0]!.decisionState = 'confirmed'; draft.requirements[0]!.blockingQuestionIds = ['Q1'];
    draft.questions.push({ id: 'Q1', text: 'Unresolved', blocking: true, affectedRequirementIds: ['R1'], sourceRefs: [] });
    reviewRun(config, sourceRunId, draft, 'Synthetic review', 0, 'test');
    const blocked = await planRun({ config, sourceRunId, planner: planner() });
    expect(() => approvePlan(config, blocked.planId, 'approve', 'test')).toThrow('blocking');
  });
  it('rejects changed configuration, HEAD and uncommitted target edits', async () => {
    const { result } = await approved();
    expect(() => approvePlan({ ...config, development: { ...config.development!, commandTimeoutMs: 4000 } }, result.planId, 'approve', 'test')).toThrow('stale');
    writeFileSync(join(config.repoPath!, 'src/greet.mjs'), newCode);
    expect(() => approvePlan(config, result.planId, 'approve', 'test')).toThrow('clean');
    git('add', '.'); git('commit', '-m', 'changed');
    expect(() => approvePlan(config, result.planId, 'approve', 'test')).toThrow('stale');
  });
});

describe('implementation checkpoints, verification and publication', () => {
  it('changes only the worktree, commits after checks, and resumes without a duplicate generator/PR call', async () => {
    const { result, grant } = await approved({ allowPr: true });
    const agent = implementer(); const verifier = runner(); const publish = vi.fn(async () => ({ url: 'https://github.com/example/test/pull/1' }));
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: agent, runner: verifier, publish: true, publisher: publish };
    const done = await implementPlan(options);
    expect(done).toMatchObject({ status: 'review_ready', prUrl: 'https://github.com/example/test/pull/1', unverifiedCriteria: [] });
    expect(readFileSync(join(config.repoPath!, 'src/greet.mjs'), 'utf8')).toBe(baseCode);
    expect(readFileSync(join(done.worktreePath, 'src/greet.mjs'), 'utf8')).toBe(newCode);
    expect(git('branch', '--show-current')).toBe('main'); expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(done.diffPath, 'utf8')).toContain('안녕하세요');
    expect(verifier.run).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenCalledTimes(1);
    await expect(implementPlan(options)).rejects.toThrow('Grant already used');
    const resumed = await implementPlan({ ...options, resumeRunId: done.runId });
    expect(resumed.commitSha).toBe(done.commitSha); expect(agent.implement).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledTimes(1);
  });
  it('stops a failing baseline before generating code and persists the failure', async () => {
    const { result, grant } = await approved(); const agent = implementer();
    await expect(implementPlan({ config, planId: result.planId, grantId: grant.grantId, implementer: agent, runner: runner(1) })).rejects.toThrow('Baseline');
    expect(agent.implement).not.toHaveBeenCalled();
    const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try { const run = store.list(config.projectId)[0]!; expect(run.status).toBe('failed'); expect(existsSync(join(config.storageDir, 'runs', run.id, 'baseline.json'))).toBe(true); } finally { store.close(); }
  });
  it('preserves a failed test diff; resume re-verifies the saved patch without another model request', async () => {
    const { result, grant } = await approved({ allowPr: true }); const agent = implementer(); const publish = vi.fn();
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: agent, publish: true, publisher: publish };
    await expect(implementPlan({ ...options, runner: runner(2) })).rejects.toThrow('Changed-code');
    const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    const runId = store.findImplementation(grant.grantId)!.run_id; store.close();
    expect(publish).not.toHaveBeenCalled(); expect(existsSync(join(config.storageDir, 'runs', runId, 'patch.diff'))).toBe(true);
    const success = await implementPlan({ ...options, publish: false, runner: runner(), resumeRunId: runId });
    expect(success.status).toBe('review_ready'); expect(agent.implement).toHaveBeenCalledTimes(1);
  });
  it('refuses publication without permission and rejects a grant for another plan', async () => {
    const { sourceRunId, result, grant } = await approved(); const agent = implementer();
    await expect(implementPlan({ config, planId: result.planId, grantId: grant.grantId, implementer: agent, publish: true, runner: runner() })).rejects.toThrow('does not allow PR');
    const another = await planRun({ config, sourceRunId, planner: planner(), force: true });
    await expect(implementPlan({ config, planId: another.planId, grantId: grant.grantId, implementer: agent, runner: runner() })).rejects.toThrow('does not match');
    expect(agent.implement).not.toHaveBeenCalled();
  });
  it('rejects generated files outside the plan before applying them', async () => {
    const { result, grant } = await approved();
    const agent = { ...implementer(), implement: async () => ({ summary: 'bad', files: [{ path: '../escape', content: 'no' }] }) };
    await expect(implementPlan({ config, planId: result.planId, grantId: grant.grantId, implementer: agent, runner: runner() })).rejects.toThrow('scope');
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });
});
