import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { analyzeThread, reviewRun } from '../src/workflow.js';
import { planRun, approvePlan, implementPlan } from '../src/development.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { PlanDraft, Planner } from '../src/planning.js';
import type { ChangeSet, Implementer } from '../src/generation.js';
import type { VerificationResult, VerificationRunner } from '../src/runner.js';
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

describe('bounded verification corrections', () => {
  const changes = (code = newCode, test = newTest): ChangeSet => ({ summary: '한국어 인사와 테스트 교정', files: [
    { path: 'src/greet.mjs', content: code }, { path: 'test/greet.mjs', content: test },
  ] });
  function persisted(grantId: string) {
    const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try {
      const record = store.findImplementation(grantId)!;
      const checkpoint = JSON.parse(record.checkpoint_json) as {
        worktree: { path: string; branch: string }; changes: ChangeSet; repairAttempts?: number;
        repairBase?: ChangeSet; applied: boolean; changeHash: string; verification?: VerificationResult[];
        commitSha?: string; prUrl?: string;
      };
      return { runId: record.run_id, checkpoint, status: store.getRun(record.run_id).status };
    } finally { store.close(); }
  }
  function failingAfterBaseline(status: VerificationResult['status'] = 'failed', exitCode: number | null = 1): VerificationRunner {
    let calls = 0;
    return { run: vi.fn<VerificationRunner['run']>(async (_path, commands) => {
      const baseline = ++calls === 1;
      return commands.map(command => ({ commandId: command.id, program: command.program, args: command.args,
        status: baseline ? 'passed' : status, exitCode: baseline ? 0 : exitCode, durationMs: 1,
        stdout: '', stderr: baseline ? '' : 'Synthetic verification failure' }));
    }) };
  }

  it('repairs actual duplicate declarations, reruns Node assertions, and only then publishes once', async () => {
    const { result, grant } = await approved({ allowPr: true });
    const invalid = changes(newCode, newTest + newTest);
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async input => {
      expect(input.previousChanges).toEqual(invalid);
      expect(input.verification[0]).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(input.verification[0]!.stdout + input.verification[0]!.stderr).toContain('SyntaxError');
      expect(input.context.files.find(file => file.path === 'test/greet.mjs')!.content).toBe(baseTest);
      expect(input.plan).toEqual(plan);
      return changes();
    });
    const agent: Implementer = { ...implementer(), implement: vi.fn(async () => invalid), repair };
    // Execute only the tiny, local test fixture; no Docker, provider, or remote publisher is involved.
    const verifier: VerificationRunner = { run: vi.fn<VerificationRunner['run']>(async (worktree, commands) => commands.map(command => {
      const execution = spawnSync(process.execPath, command.args, { cwd: worktree, encoding: 'utf8', timeout: 5000 });
      return { commandId: command.id, program: command.program, args: command.args,
        status: execution.status === 0 ? 'passed' as const : 'failed' as const,
        exitCode: execution.status, durationMs: 1, stdout: execution.stdout, stderr: execution.stderr };
    })) };
    const publish = vi.fn(async () => {
      const { checkpoint } = persisted(grant.grantId);
      expect(checkpoint.verification?.every(check => check.status === 'passed')).toBe(true);
      expect(checkpoint.commitSha).toBeTruthy();
      return { url: 'https://github.com/example/test/pull/2' };
    });
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: agent, runner: verifier, publish: true, publisher: publish };
    const done = await implementPlan(options);
    expect(done.prUrl).toBe('https://github.com/example/test/pull/2');
    expect(verifier.run).toHaveBeenCalledTimes(3);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(done.worktreePath, 'test/greet.mjs'), 'utf8')).toBe(newTest);
    expect(readFileSync(join(config.repoPath!, 'test/greet.mjs'), 'utf8')).toBe(baseTest);
    const directory = join(config.storageDir, 'runs', done.runId);
    expect(JSON.parse(readFileSync(join(directory, 'changes-before-repair-1.json'), 'utf8'))).toEqual(invalid);
    expect(readFileSync(join(directory, 'patch-before-repair-1.diff'), 'utf8')).toContain('+import { greet }');
    expect(JSON.parse(readFileSync(join(directory, 'verification-attempt-0.json'), 'utf8'))[0].status).toBe('failed');
    expect(JSON.parse(readFileSync(join(directory, 'verification-attempt-1.json'), 'utf8'))[0].status).toBe('passed');
    const saved = persisted(grant.grantId);
    expect(saved.checkpoint).toMatchObject({ repairAttempts: 1, applied: true, changes: changes() });
    expect(saved.checkpoint.repairBase).toBeUndefined();
    await implementPlan({ ...options, resumeRunId: done.runId });
    expect(agent.implement).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('persists a two-correction ceiling across resume and never commits or publishes a failing patch', async () => {
    const { result, grant } = await approved({ allowPr: true });
    let attempts = 0;
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async () => changes(`${newCode}// correction ${++attempts}\n`));
    const agent: Implementer = { ...implementer(), repair };
    const publish = vi.fn(); const verifier = failingAfterBaseline();
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: agent, runner: verifier, publish: true, publisher: publish };
    await expect(implementPlan(options)).rejects.toThrow('Changed-code');
    const saved = persisted(grant.grantId);
    expect(saved.status).toBe('failed');
    expect(saved.checkpoint.repairAttempts).toBe(2);
    expect(saved.checkpoint.commitSha).toBeUndefined();
    expect(saved.checkpoint.prUrl).toBeUndefined();
    expect(repair).toHaveBeenCalledTimes(2);
    expect(verifier.run).toHaveBeenCalledTimes(4);
    await expect(implementPlan({ ...options, resumeRunId: saved.runId })).rejects.toThrow('Changed-code');
    expect(repair).toHaveBeenCalledTimes(2);
    expect(agent.implement).toHaveBeenCalledTimes(1);
    expect(persisted(grant.grantId).checkpoint.repairAttempts).toBe(2);
    expect(publish).not.toHaveBeenCalled();
    expect(execFileSync('git', ['-C', saved.checkpoint.worktree.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(git('rev-parse', 'HEAD'));
  });

  it('rejects a scope-escaping correction before changing any recorded worktree content', async () => {
    const { result, grant } = await approved({ allowPr: true });
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async () => ({ ...changes(), files: [
      ...changes().files, { path: 'src/unapproved.mjs', content: 'export const bypass = true;\n' },
    ] }));
    const agent: Implementer = { ...implementer(), repair }; const publish = vi.fn();
    await expect(implementPlan({ config, planId: result.planId, grantId: grant.grantId, implementer: agent,
      runner: failingAfterBaseline(), publish: true, publisher: publish })).rejects.toThrow('scope');
    const saved = persisted(grant.grantId);
    expect(saved.checkpoint.changes).toEqual({ summary: '한국어 구현', files: changes().files });
    expect(saved.checkpoint.repairAttempts).toBe(1);
    expect(readFileSync(join(saved.checkpoint.worktree.path, 'src/greet.mjs'), 'utf8')).toBe(newCode);
    expect(existsSync(join(saved.checkpoint.worktree.path, 'src/unapproved.mjs'))).toBe(false);
    expect(saved.checkpoint.commitSha).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'blocked infrastructure', status: 'blocked' as const, exitCode: null },
    { label: 'timeout or signal', status: 'failed' as const, exitCode: null },
    { label: 'invalid zero exit failure', status: 'failed' as const, exitCode: 0 },
  ])('does not request a correction for $label', async ({ status, exitCode }) => {
    const { result, grant } = await approved({ allowPr: true });
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async () => changes());
    const publish = vi.fn();
    await expect(implementPlan({ config, planId: result.planId, grantId: grant.grantId,
      implementer: { ...implementer(), repair }, runner: failingAfterBaseline(status, exitCode), publish: true, publisher: publish })).rejects.toThrow('Changed-code');
    expect(repair).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(persisted(grant.grantId).checkpoint.repairAttempts).toBeUndefined();
  });

  it('consumes an interrupted provider attempt durably without applying an unknown correction', async () => {
    const { result, grant } = await approved({ allowPr: true });
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async () => {
      // The attempt is durable before entering the provider, including an ambiguous network failure.
      expect(persisted(grant.grantId).checkpoint.repairAttempts).toBe(repair.mock.calls.length);
      throw new Error('Synthetic provider connection interrupted');
    });
    const publish = vi.fn(); const verifier = failingAfterBaseline();
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: { ...implementer(), repair },
      runner: verifier, publish: true, publisher: publish };
    await expect(implementPlan(options)).rejects.toThrow('connection interrupted');
    let saved = persisted(grant.grantId);
    expect(saved.checkpoint).toMatchObject({ repairAttempts: 1, applied: true });
    expect(saved.checkpoint.repairBase).toBeUndefined();
    expect(readFileSync(join(saved.checkpoint.worktree.path, 'src/greet.mjs'), 'utf8')).toBe(newCode);
    expect(readFileSync(join(saved.checkpoint.worktree.path, 'test/greet.mjs'), 'utf8')).toBe(newTest);
    await expect(implementPlan({ ...options, resumeRunId: saved.runId })).rejects.toThrow('connection interrupted');
    saved = persisted(grant.grantId);
    expect(saved.checkpoint.repairAttempts).toBe(2);
    await expect(implementPlan({ ...options, resumeRunId: saved.runId })).rejects.toThrow('Changed-code');
    expect(repair).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    expect(saved.checkpoint.commitSha).toBeUndefined();
  });

  it('resumes a durably recorded correction after only one file was applied, without another provider call', async () => {
    const { result, grant } = await approved({ allowPr: true });
    const agent = implementer(); const publish = vi.fn(async () => ({ url: 'https://github.com/example/test/pull/3' }));
    const options = { config, planId: result.planId, grantId: grant.grantId, implementer: agent, publish: true, publisher: publish };
    await expect(implementPlan({ ...options, runner: runner(2) })).rejects.toThrow('Changed-code');
    const saved = persisted(grant.grantId);
    const corrected = changes(`// corrected implementation\n${newCode}`, `// corrected assertion\n${newTest}`);
    // Reproduce the durable boundary after correction generation but before all file writes completed.
    const pending = { ...saved.checkpoint, repairAttempts: 1, repairBase: saved.checkpoint.changes,
      changes: corrected, applied: false };
    delete pending.verification;
    const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try { store.checkpoint(saved.runId, pending); } finally { store.close(); }
    writeFileSync(join(saved.checkpoint.worktree.path, 'src/greet.mjs'), corrected.files[0]!.content!);
    const repair = vi.fn<NonNullable<Implementer['repair']>>(async () => { throw new Error('Must not regenerate a recorded correction'); });
    const verifier = runner();
    const done = await implementPlan({ ...options, implementer: { ...agent, repair }, runner: verifier, resumeRunId: saved.runId });
    expect(done.status).toBe('review_ready');
    expect(readFileSync(join(done.worktreePath, 'test/greet.mjs'), 'utf8')).toBe(corrected.files[1]!.content);
    expect(persisted(grant.grantId).checkpoint.repairBase).toBeUndefined();
    expect(verifier.run).toHaveBeenCalledTimes(1);
    expect(agent.implement).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledTimes(1);
  });
});
