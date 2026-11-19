import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnalysisDraft } from './analysis.js';
import { validateAnalysis } from './analysis.js';
import type { ProjectConfig } from './config.js';
import { hash } from './domain.js';
import { RunStore, type PlanRecord } from './store.js';
import { safeError, writeArtifact } from './workflow.js';
import { inspectRepository, getRepoCommit, createWorktree, validateWorktree, assertAllowedChanges, createDiff, commitChanges, type RepositoryContext } from './repository.js';
import { validatePlan, renderPlan, type PlanDraft, type Planner } from './planning.js';
import { validateChanges, type Implementer, type ChangeSet } from './generation.js';
import { DockerRunner, type VerificationRunner, type VerificationResult } from './runner.js';
import { publishDraft } from './publisher.js';

const VERSION = 'development-v1';
const openStore = (config: ProjectConfig) => new RunStore(join(config.storageDir, 'history.sqlite'));
function requireDevelopment(config: ProjectConfig) {
  if (!config.repoPath || !config.development) throw new Error('plan/implement require repoPath and development settings (paths, Docker image, verification commands).');
  return config.development;
}
function sourceAnalysis(store: RunStore, config: ProjectConfig, sourceRunId: string) {
  const run = store.getRun(sourceRunId);
  if (run.project_id !== config.projectId || run.mode !== 'analyze') throw new Error('Expected an analyze run in this project.');
  const snapshot = store.getSnapshot(sourceRunId);
  if (snapshot.status !== 'complete') throw new Error('Planning requires a complete source snapshot.');
  const revision = store.latestRevision(sourceRunId);
  const analysis = validateAnalysis(JSON.parse(revision.data_json), snapshot);
  return { snapshot, revision, analysis };
}
function binding(record: Pick<PlanRecord, 'source_run_id' | 'spec_revision_id' | 'snapshot_id' | 'repo_commit_sha' | 'config_hash' | 'requirement_ids_json' | 'context_json' | 'data_json'>) {
  return hash({ version: VERSION, ...record });
}
function checkPlan(store: RunStore, config: ProjectConfig, planId: string, executable: boolean) {
  requireDevelopment(config);
  const record = store.getPlan(planId);
  if (store.getRun(record.run_id).project_id !== config.projectId) throw new Error('Plan belongs to another project.');
  const source = sourceAnalysis(store, config, record.source_run_id);
  const latestSnapshot = store.latestSnapshot(config.projectId, source.snapshot);
  if (source.revision.id !== record.spec_revision_id || source.snapshot.id !== record.snapshot_id || latestSnapshot.contentHash !== source.snapshot.contentHash || hash(config) !== record.config_hash || getRepoCommit(config) !== record.repo_commit_sha) {
    store.status(record.run_id, 'stale');
    throw new Error('Plan is stale: source revision, repository HEAD or configuration changed. Generate and approve a new plan.');
  }
  const context = JSON.parse(record.context_json) as RepositoryContext;
  const requirementIds = JSON.parse(record.requirement_ids_json) as string[];
  const plan = validatePlan(JSON.parse(record.data_json), source.analysis, context, config, requirementIds);
  const expectedBinding = binding({ source_run_id: record.source_run_id, spec_revision_id: record.spec_revision_id,
    snapshot_id: record.snapshot_id, repo_commit_sha: record.repo_commit_sha, config_hash: record.config_hash,
    requirement_ids_json: record.requirement_ids_json, context_json: record.context_json, data_json: record.data_json });
  if (expectedBinding !== record.binding_hash) throw new Error('Stored plan binding does not match its contents.');
  if (executable) {
    if (source.revision.origin !== 'human' || source.revision.review_state !== 'accepted') throw new Error('Review the requirements with review, then generate a new plan before approval or implementation.');
    const selected = source.analysis.requirements.filter(requirement => requirementIds.includes(requirement.id));
    if (selected.some(requirement => requirement.decisionState !== 'confirmed')) throw new Error('Only human-reviewed confirmed requirements may be implemented.');
    if (source.analysis.questions.some(question => question.blocking && question.affectedRequirementIds.some(id => requirementIds.includes(id))) || plan.items.some(item => item.blockers.length > 0)) throw new Error('Selected work has blocking questions. Resolve them and create a new plan.');
  }
  return { record, ...source, context, requirementIds, plan };
}

export interface PlanOptions { config: ProjectConfig; sourceRunId: string; planner: Planner; requirementIds?: string[]; force?: boolean; expectedRevisionId?: string }
export async function planRun(options: PlanOptions) {
  const { config, planner } = options;
  requireDevelopment(config);
  const store = openStore(config);
  let runId: string | undefined;
  let stepId: string | undefined;
  try {
    store.acquireLock();
    const { snapshot, revision, analysis } = sourceAnalysis(store, config, options.sourceRunId);
    if (options.expectedRevisionId && revision.id !== options.expectedRevisionId) throw new Error('Reviewed analysis changed before planning.');
    const requirementIds = options.requirementIds ?? analysis.requirements.filter(r => !['rejected', 'superseded'].includes(r.decisionState)).map(r => r.id);
    if (requirementIds.length === 0 || new Set(requirementIds).size !== requirementIds.length || requirementIds.some(id => !analysis.requirements.some(r => r.id === id))) throw new Error('Select one or more unique known requirement IDs.');
    store.saveProject(config.projectId, config, hash(config));
    runId = store.createRun(config.projectId, { sourceRunId: options.sourceRunId, requirementIds, version: VERSION, planner: { name: planner.name, model: planner.model, promptVersion: planner.promptVersion } }, 'plan');
    store.status(runId, 'planning');
    stepId = store.startStep(runId, 'investigate', hash({ requirementIds, revisionId: revision.id }));
    const context = inspectRepository(config, analysis.requirements.filter(r => requirementIds.includes(r.id)).flatMap(r => r.statement.split(/\s+/)));
    const directory = join(config.storageDir, 'runs', runId);
    writeArtifact(join(directory, 'context.json'), context);
    store.finishStep(stepId, join(directory, 'context.json')); stepId = undefined;
    const inputHash = hash({ version: VERSION, projectId: config.projectId, revisionId: revision.id, context, config,
      requirementIds, planner: { name: planner.name, model: planner.model, promptVersion: planner.promptVersion } });
    store.setInputHash(runId, inputHash);
    const previous = options.force ? undefined : store.findPlan(inputHash, config.projectId);
    if (previous) {
      store.reuse(runId, previous.run_id);
      return { runId: previous.run_id, requestRunId: runId, planId: previous.id, status: store.getRun(previous.run_id).status, reused: true,
        planPath: join(config.storageDir, 'runs', previous.run_id, 'plan.json'), reportPath: join(config.storageDir, 'runs', previous.run_id, 'plan.md') };
    }
    stepId = store.startStep(runId, 'plan', inputHash);
    const plan = validatePlan(await planner.plan({ analysis, context, requirementIds, config }), analysis, context, config, requirementIds);
    const record = { id: randomUUID(), run_id: runId, source_run_id: options.sourceRunId, spec_revision_id: revision.id,
      snapshot_id: snapshot.id, repo_commit_sha: context.commitSha, config_hash: hash(config),
      requirement_ids_json: JSON.stringify(requirementIds), context_json: JSON.stringify(context), data_json: JSON.stringify(plan) };
    const bindingHash = binding({ source_run_id: record.source_run_id, spec_revision_id: record.spec_revision_id, snapshot_id: record.snapshot_id,
      repo_commit_sha: record.repo_commit_sha, config_hash: record.config_hash, requirement_ids_json: record.requirement_ids_json,
      context_json: record.context_json, data_json: record.data_json });
    const planPath = join(directory, 'plan.json');
    const reportPath = join(directory, 'plan.md');
    writeArtifact(planPath, { planId: record.id, bindingHash, specRevisionId: revision.id, repoCommitSha: context.commitSha, requirementIds, plan });
    writeArtifact(reportPath, renderPlan(plan, context), true);
    writeArtifact(join(directory, 'metadata.json'), { version: VERSION, usage: planner.usage ?? null, bindingHash, reviewState: 'pending' });
    store.savePlan({ ...record, binding_hash: bindingHash });
    store.finishStep(stepId, reportPath); stepId = undefined;
    store.status(runId, 'needs_input');
    return { runId, requestRunId: runId, planId: record.id, status: 'needs_input', reused: false, planPath, reportPath };
  } catch (error) {
    const failure = safeError(error);
    if (stepId) store.finishStep(stepId, undefined, failure);
    if (runId) store.status(runId, 'failed', failure);
    throw new Error(`${failure.message}${runId ? ` (run: ${runId})` : ''}`);
  } finally { store.close(); }
}

export function approvePlan(config: ProjectConfig, planId: string, reason: string, actor: string, allowPr = false, expectedBindingHash?: string) {
  const store = openStore(config);
  try {
    store.acquireLock();
    const { record, plan } = checkPlan(store, config, planId, true);
    if (expectedBindingHash && record.binding_hash !== expectedBindingHash) throw new Error('Plan changed after approval.');
    // Check uncommitted target changes before issuing a grant, not merely HEAD.
    inspectRepository(config);
    if (allowPr && !config.github) throw new Error('PR permission requires github repository/baseBranch/remote configuration.');
    const grant = store.grant(planId, record.binding_hash, actor, reason, allowPr);
    store.status(record.run_id, 'ready');
    writeArtifact(join(config.storageDir, 'grants', `${grant.id}.json`), { ...grant, allowedPaths: [...new Set(plan.items.flatMap(item => item.affectedPaths))] });
    return { grantId: grant.id, planId, bindingHash: record.binding_hash, allowPr };
  } finally { store.close(); }
}

interface Checkpoint {
  worktree?: { path: string; branch: string };
  baseline?: VerificationResult[];
  changes?: ChangeSet;
  changeHash?: string;
  applied?: boolean;
  verification?: VerificationResult[];
  commitSha?: string;
  prUrl?: string;
}
export interface ImplementOptions {
  config: ProjectConfig; planId: string; grantId: string; implementer: Implementer; publish?: boolean; resumeRunId?: string;
  runner?: VerificationRunner;
  publisher?: typeof publishDraft;
}
function verificationPassed(results: VerificationResult[], config: ProjectConfig): boolean {
  const commands = config.development!.commands;
  return results.length === commands.length && new Set(results.map(result => result.commandId)).size === commands.length &&
    commands.every(command => results.some(result => result.commandId === command.id && result.program === command.program &&
      JSON.stringify(result.args) === JSON.stringify(command.args) && result.status === 'passed' && result.exitCode === 0 &&
      Number.isFinite(result.durationMs) && result.durationMs >= 0));
}
function assertFileState(worktree: string, context: RepositoryContext, changes: ChangeSet, applied: boolean) {
  for (const file of changes.files) {
    const path = join(worktree, file.path);
    // Never follow a symlink inserted into a parent directory between checkpoints.
    for (let parent = dirname(path); parent !== worktree; parent = dirname(parent)) {
      if (existsSync(parent) && (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())) throw new Error('Changed path contains a non-directory or symbolic link.');
    }
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Changed file is not a regular file.');
    const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const before = context.files.find(source => source.path === file.path)?.content ?? null;
    if (actual !== file.content && (applied || actual !== before)) throw new Error(`Worktree content changed outside the recorded patch: ${file.path}`);
  }
}
function reportImplementation(plan: PlanDraft, checkpoint: Checkpoint, runId: string, source: AnalysisDraft, snapshot: ReturnType<RunStore['getSnapshot']>) {
  const escape = (value: string) => value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&').replace(/[\r\n]/g, ' ');
  const lines = ['# Implementation report', '', `Run: ${runId}`, `Commit: ${checkpoint.commitSha ?? 'not committed'}`, `PR: ${checkpoint.prUrl ?? 'not published'}`, '',
    'This is a reviewable draft. Command success is evidence of execution, not proof that every requirement is semantically correct.', '', '## Verification', '', '| Phase | Command | Result | Exit code |', '| --- | --- | --- | --- |'];
  for (const [phase, results] of [['baseline', checkpoint.baseline], ['after', checkpoint.verification]] as const) for (const result of results ?? []) lines.push(`| ${phase} | ${result.commandId} | ${result.status} | ${result.exitCode ?? '—'} |`);
  lines.push('', '## Requirement evidence', '', '| Requirement | Planned files | Criterion | Verification |', '| --- | --- | --- | --- |');
  for (const item of plan.items) for (const id of item.requirementIds) {
    const requirement = source.requirements.find(r => r.id === id)!;
    for (const criterion of requirement.acceptanceCriteria) {
      const check = item.acceptanceChecks.find(value => value.criterionId === criterion.id);
      const result = checkpoint.verification?.find(value => value.commandId === check?.commandId);
      lines.push(`| ${escape(id)} | ${item.affectedPaths.map(escape).join(', ')} | ${escape(criterion.id)} | ${check?.commandId ? `${result?.status ?? 'not_run'} (${escape(check.commandId)})` : 'not_run (manual review required)'} |`);
    }
    for (const ref of requirement.sourceRefs) {
      const message = snapshot.messages.find(m => m.id === ref.messageVersionId)!;
      const url = new URL(message.permalink);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com')) throw new Error('Invalid source link in implementation report.');
      lines.push('', `- ${escape(id)}: [Slack source](<${url.href.replace(/[<>]/g, character => encodeURIComponent(character))}>)`);
    }
  }
  return lines.join('\n') + '\n';
}
export async function implementPlan(options: ImplementOptions) {
  const { config, implementer } = options;
  const development = requireDevelopment(config);
  const store = openStore(config);
  let runId: string | undefined;
  let stepId: string | undefined;
  let checkpoint: Checkpoint = {};
  let currentPlan: ReturnType<typeof checkPlan> | undefined;
  const runner = options.runner ?? new DockerRunner();
  try {
    store.acquireLock();
    currentPlan = checkPlan(store, config, options.planId, true);
    const { record, context, analysis, plan, snapshot } = currentPlan;
    const grant = store.getGrant(options.grantId);
    if (grant.plan_id !== options.planId || grant.binding_hash !== record.binding_hash) throw new Error('Execution grant does not match this plan version.');
    if (options.publish && (!grant.allow_pr || !config.github)) throw new Error('This grant does not allow PR publication.');
    inspectRepository(config);
    const previous = store.findImplementation(grant.id);
    if (previous) {
      if (options.resumeRunId !== previous.run_id) throw new Error(`Grant already used. Resume with --resume ${previous.run_id}; a new call will not duplicate changes or a PR.`);
      if (previous.plan_id !== options.planId) throw new Error('Resume plan mismatch.');
      runId = previous.run_id;
      checkpoint = JSON.parse(previous.checkpoint_json) as Checkpoint;
    } else {
      if (options.resumeRunId) throw new Error('No matching implementation exists for this grant.');
      store.saveProject(config.projectId, config, hash(config));
      runId = store.createRun(config.projectId, { planId: options.planId, grantId: grant.id, bindingHash: record.binding_hash, version: VERSION,
        implementer: { name: implementer.name, model: implementer.model, promptVersion: implementer.promptVersion } }, 'implement');
      store.startImplementation(runId, options.planId, grant.id, checkpoint);
    }
    const directory = join(config.storageDir, 'runs', runId);
    const save = () => store.checkpoint(runId!, checkpoint);
    const allowedPaths = [...new Set(plan.items.flatMap(item => item.affectedPaths))];
    if (!checkpoint.worktree) {
      store.status(runId, 'implementing');
      stepId = store.startStep(runId, 'prepare', record.binding_hash);
      checkpoint.worktree = createWorktree(config, context.commitSha, runId);
      save(); store.finishStep(stepId, checkpoint.worktree.path); stepId = undefined;
    }
    const worktree = checkpoint.worktree;
    validateWorktree(config, worktree.path, worktree.branch, checkpoint.commitSha ?? context.commitSha);
    const pendingChanges = assertAllowedChanges(config, worktree.path, allowedPaths);
    if (checkpoint.commitSha && pendingChanges.length) throw new Error('Committed worktree has unrecorded changes. Refusing resume without verification.');
    if (!checkpoint.changes) {
      if (assertAllowedChanges(config, worktree.path, allowedPaths).length) throw new Error('Unrecorded changes exist before generation.');
      store.status(runId, 'verifying');
      stepId = store.startStep(runId, 'baseline', context.commitSha);
      checkpoint.baseline = await runner.run(worktree.path, development.commands, config);
      writeArtifact(join(directory, 'baseline.json'), checkpoint.baseline);
      save();
      if (!verificationPassed(checkpoint.baseline, config)) throw new Error('Baseline verification did not pass. Resolve the test environment before generating changes.');
      store.finishStep(stepId, join(directory, 'baseline.json')); stepId = undefined;
      store.status(runId, 'implementing');
      stepId = store.startStep(runId, 'generate', record.binding_hash);
      checkpoint.changes = validateChanges(await implementer.implement({ analysis, plan, context, config }), plan, context, config);
      writeArtifact(join(directory, 'changes.json'), checkpoint.changes);
      writeArtifact(join(directory, 'usage.json'), implementer.usage ?? null);
      save(); store.finishStep(stepId, join(directory, 'changes.json')); stepId = undefined;
    }
    const changes = validateChanges(checkpoint.changes, plan, context, config);
    checkPlan(store, config, options.planId, true);
    assertFileState(worktree.path, context, changes, checkpoint.applied ?? false);
    if (!checkpoint.applied) {
      stepId = store.startStep(runId, 'apply', hash(changes));
      assertAllowedChanges(config, worktree.path, allowedPaths);
      for (const file of changes.files) {
        const target = join(worktree.path, file.path);
        if (file.content === null) rmSync(target, { force: true });
        else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.content, { mode: 0o644 }); }
      }
      const actual = assertAllowedChanges(config, worktree.path, allowedPaths);
      if (actual.length === 0) throw new Error('The proposed change produced no diff.');
      if (actual.some(path => !changes.files.some(file => file.path === path))) throw new Error('Worktree contains changes not present in the recorded patch.');
      const diff = createDiff(worktree.path);
      checkpoint.changeHash = hash(diff); checkpoint.applied = true;
      writeArtifact(join(directory, 'patch.diff'), diff, true);
      save(); store.finishStep(stepId, join(directory, 'patch.diff')); stepId = undefined;
    }
    if (!checkpoint.commitSha) {
      if (hash(createDiff(worktree.path)) !== checkpoint.changeHash) throw new Error('Worktree diff differs from the recorded checkpoint. Refusing resume.');
      store.status(runId, 'verifying');
      stepId = store.startStep(runId, 'verify', checkpoint.changeHash!);
      checkpoint.verification = await runner.run(worktree.path, development.commands, config);
      writeArtifact(join(directory, 'verification.json'), checkpoint.verification);
      save();
      if (!verificationPassed(checkpoint.verification, config)) throw new Error('Changed-code verification did not pass. Diff and test results were preserved; no commit or PR was created.');
      if (checkpoint.verification.some(result => result.imageId !== checkpoint.baseline?.find(before => before.commandId === result.commandId)?.imageId)) {
        throw new Error('Verification image differs from the baseline. Use a pinned image and create a new plan.');
      }
      // Test commands execute in a copy; confirm their source never changed.
      assertFileState(worktree.path, context, changes, true);
      if (hash(createDiff(worktree.path)) !== checkpoint.changeHash) throw new Error('Worktree changed during verification.');
      checkPlan(store, config, options.planId, true);
      store.finishStep(stepId, join(directory, 'verification.json')); stepId = undefined;
      stepId = store.startStep(runId, 'commit', checkpoint.changeHash!);
      checkpoint.commitSha = commitChanges(worktree.path, `Implement reviewed Slack plan ${options.planId}`);
      save(); store.finishStep(stepId); stepId = undefined;
    }
    const reportPath = join(directory, 'report.md');
    const prBodyPath = join(directory, 'pr-body.md');
    writeArtifact(reportPath, reportImplementation(plan, checkpoint, runId, analysis, snapshot), true);
    // Keep Slack message contents and internal evidence links out of external PR text.
    writeArtifact(prBodyPath, `Implements reviewed plan ${options.planId}.\n\nRequirements: ${currentPlan.requirementIds.join(', ')}\n\nVerification: ${checkpoint.verification?.map(result => `${result.commandId}: ${result.status}`).join('; ')}\n\nThis draft requires human review. Detailed evidence and any manual checks are in the local run report.\n\nslack-dev-run: ${runId}\n`, true);
    if (options.publish && !checkpoint.prUrl) {
      checkPlan(store, config, options.planId, true);
      stepId = store.startStep(runId, 'publish', hash({ commit: checkpoint.commitSha, github: config.github }));
      const published = await (options.publisher ?? publishDraft)(config, worktree.path, worktree.branch, prBodyPath, `Implement Slack plan ${options.planId}`);
      checkpoint.prUrl = published.url;
      save(); store.finishStep(stepId, checkpoint.prUrl); stepId = undefined;
      writeArtifact(reportPath, reportImplementation(plan, checkpoint, runId, analysis, snapshot), true);
    }
    store.status(runId, 'review_ready');
    return { runId, planId: options.planId, status: 'review_ready', worktreePath: worktree.path, branch: worktree.branch,
      commitSha: checkpoint.commitSha, prUrl: checkpoint.prUrl ?? null, reportPath, diffPath: join(directory, 'patch.diff'),
      unverifiedCriteria: plan.items.flatMap(item => item.acceptanceChecks.filter(check => check.commandId === null).map(check => check.criterionId)) };
  } catch (error) {
    const failure = safeError(error);
    if (runId && currentPlan) {
      try { writeArtifact(join(config.storageDir, 'runs', runId, 'report.md'), reportImplementation(currentPlan.plan, checkpoint, runId, currentPlan.analysis, currentPlan.snapshot) + `\nFailure: ${failure.message}\n`, true); } catch { /* Keep the original failure. */ }
    }
    if (stepId) store.finishStep(stepId, undefined, failure);
    if (runId) store.status(runId, 'failed', failure);
    throw new Error(`${failure.message}${runId ? ` (run: ${runId})` : ''}`);
  } finally { store.close(); }
}

/** Revalidate the exact stored plan before exposing approval controls. */
export function inspectStoredPlan(config: ProjectConfig, planId: string) {
  const store = new RunStore(join(config.storageDir, 'history.sqlite'), 250);
  try { store.acquireLock(); return checkPlan(store, config, planId, false); }
  finally { store.close(); }
}
