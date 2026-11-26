import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AnalysisDraft } from '../src/analysis.js';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { approvePlan, implementPlan, planRun } from '../src/development.js';
import { hash, snapshotContentHash } from '../src/domain.js';
import type { Implementer } from '../src/generation.js';
import type { PlanDraft, Planner } from '../src/planning.js';
import type { VerificationResult, VerificationRunner } from '../src/runner.js';
import { RunStore } from '../src/store.js';

let root: string;
let config: ProjectConfig;
const snapshot = JSON.parse(readFileSync(new URL('../examples/thread.json', import.meta.url), 'utf8'));
const analysis: AnalysisDraft = { summary: 'Change greeting', requirements: [{ id: 'R1', statement: 'Change greeting', decisionState: 'confirmed',
  sourceRefs: [{ messageVersionId: snapshot.messages[0].id, quote: snapshot.messages[0].text }], supersedesIds: [], blockingQuestionIds: [],
  acceptanceCriteria: [{ id: 'A1', text: 'returns new greeting', origin: 'derived', sourceRefs: [] }] }], questions: [] };
const draft: PlanDraft = { summary: 'Change greeting', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: 'old greeting',
  codeRefs: [{ path: 'src/greet.js', quote: "export const greeting = 'old';" }], proposedChanges: 'Update greeting and inspect unused helper',
  affectedPaths: ['src/greet.js'], dependencies: [], acceptanceChecks: [{ criterionId: 'A1', commandId: 'test', testName: 'new greeting' }], blockers: [] }], excludedRequirements: [] };
const planner: Planner = { name: 'fixture', model: 'fixture', promptVersion: 'audit-v1', async plan() { return structuredClone(draft); } };
const implementer: Implementer = { name: 'fixture', model: 'fixture', promptVersion: 'audit-v1', async implement() {
  return { summary: 'Update greeting', files: [{ path: 'src/greet.js', content: "export const greeting = 'new';\n" }] };
} };
const passingRunner: VerificationRunner = { async run(_path, commands) { return commands.map(command => ({ commandId: command.id, program: command.program,
  args: command.args, status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '' })); } };
function git(...args: string[]) { return execFileSync('git', ['-C', config.repoPath!, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
async function approved() {
  const store = new RunStore(join(config.storageDir, 'history.sqlite'));
  let sourceRunId: string;
  try {
    store.saveProject(config.projectId, config, hash(config)); sourceRunId = store.createRun(config.projectId, {});
    store.saveSnapshot(sourceRunId, snapshot); store.addDraft(sourceRunId, analysis); store.review(sourceRunId, analysis, 'Synthetic audit fixture', 0, 'test');
  } finally { store.close(); }
  const plan = await planRun({ config, sourceRunId, planner });
  const grant = approvePlan(config, plan.planId, 'Synthetic audit approval', 'test');
  return { config, planId: plan.planId, grantId: grant.grantId, implementer, runner: passingRunner };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-development-audit-'));
  config = configSchema.parse({ projectId: 'audit', slack: { workspace: 'example', channelIds: ['CDEMO12345'] }, storageDir: join(root, 'data'), repoPath: join(root, 'repo'), model: 'gpt-4.1-mini',
    development: { readPaths: ['src'], writePaths: ['src'], commands: [{ id: 'test', program: 'node', args: ['--test'] }], dockerImage: 'node:24' } });
  mkdirSync(join(config.repoPath!, 'src'), { recursive: true });
  writeFileSync(join(config.repoPath!, 'src/greet.js'), "export const greeting = 'old';\n");
  writeFileSync(join(config.repoPath!, 'src/unused.js'), 'export const unused = 1;\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'Audit'); git('config', 'user.email', 'audit@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses completed-run resume when an unchanged source file has an unrecorded edit', async () => {
  const options = await approved();
  const complete = await implementPlan(options);
  writeFileSync(join(complete.worktreePath, 'src/unused.js'), 'export const unused = 2;\n');
  await expect(implementPlan({ ...options, resumeRunId: complete.runId })).rejects.toThrow(/outside the approved file scope/);
});

it.each([
  { commandId: 'unknown' },
  { exitCode: 1 },
  { program: 'unexpected-program' },
  { args: ['unexpected-argument'] },
])('rejects an inconsistent passed verification result %j', async badFields => {
  const options = await approved();
  const runner: VerificationRunner = { async run(_path, commands) {
    return commands.map(command => ({ commandId: command.id, program: command.program, args: command.args, status: 'passed', exitCode: 0,
      durationMs: 1, stdout: '', stderr: '', ...badFields } as VerificationResult));
  } };
  await expect(implementPlan({ ...options, runner })).rejects.toThrow(/verification|Baseline|result|command/i);
});

it('invalidates an existing execution grant after new collected analysis evidence arrives', async () => {
  const options = await approved();
  const changed = structuredClone(snapshot); changed.id += '-updated';
  changed.messages[0].text += ' Additional decision.'; changed.contentHash = snapshotContentHash(changed);
  const store = new RunStore(join(config.storageDir, 'history.sqlite'));
  try {
    const newerRun = store.createRun(config.projectId, {}); store.saveSnapshot(newerRun, changed);
  } finally { store.close(); }
  await expect(implementPlan(options)).rejects.toThrow(/stale/);
});
