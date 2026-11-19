import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisDraft } from '../src/analysis.js';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { hash, snapshotContentHash, type ThreadSnapshot } from '../src/domain.js';
import type { PlanDraft } from '../src/planning.js';
import { RunStore } from '../src/store.js';
import { analyzeThread, reviewRun } from '../src/workflow.js';
import { createSlackBackend } from '../src/slack-backend.js';
import type { SlackReviewInput } from '../src/slack-service.js';

const mocks = vi.hoisted(() => ({planCalls: 0, onPlannerConstruct: undefined as (() => void) | undefined,
  planValue: undefined as unknown, implement: vi.fn(async (_input: unknown) => ({runId: 'implementation-run', prUrl: null}))}));
vi.mock('../src/planning.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/planning.js')>();
  return {...actual, OpenAIPlanner: class {
    readonly name = 'fixture'; readonly model = 'offline'; readonly promptVersion = 'v1';
    constructor() {mocks.onPlannerConstruct?.();}
    async plan() {mocks.planCalls += 1; return structuredClone(mocks.planValue);}
  }};
});
vi.mock('../src/generation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/generation.js')>();
  return {...actual, OpenAIImplementer: class {
    readonly name = 'fixture'; readonly model = 'offline'; readonly promptVersion = 'v1';
    async implement() {throw new Error('No live implementation is permitted in this adapter test');}
  }};
});
vi.mock('../src/development.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/development.js')>(), implementPlan: mocks.implement,
}));

let directory: string;
let config: ProjectConfig;
const source: ThreadSnapshot = {id: 'fixture-snapshot', workspace: 'example', channelId: 'CONE', rootTs: '1795046400.000001',
  collectedAt: '2026-11-19T03:00:00.000Z', status: 'complete', warnings: [], contentHash: 'pending', messages: [
    {id: 'M1', ts: '1795046400.000001', text: '버튼을 활성화한다. 클릭하면 실행한다.', author: 'UREQUESTER', editedTs: null, hasAttachments: false,
      permalink: 'https://example.slack.com/archives/CONE/p1795046400000001'},
  ]};
source.contentHash = snapshotContentHash(source);
const draft: AnalysisDraft = {summary: '버튼 활성화', requirements: [{id: 'R1', statement: '버튼을 활성화한다.', decisionState: 'proposed',
  sourceRefs: [{messageVersionId: 'M1', quote: '버튼을 활성화한다.'}], supersedesIds: [], blockingQuestionIds: [],
  acceptanceCriteria: [{id: 'A1', text: '클릭하면 실행한다.', origin: 'source', sourceRefs: [{messageVersionId: 'M1', quote: '클릭하면 실행한다.'}]}]}], questions: []};
const plan: PlanDraft = {summary: '버튼 활성화 구현', items: [{id: 'P1', requirementIds: ['R1'], currentBehavior: '비활성화됨',
  codeRefs: [{path: 'src/app.ts', quote: 'enabled = false'}], proposedChanges: 'enabled를 true로 바꿉니다.', affectedPaths: ['src/app.ts'],
  dependencies: [], acceptanceChecks: [{criterionId: 'A1', commandId: 'web-test', testName: '활성화 확인'}], blockers: []}], excludedRequirements: []};
function git(...args: string[]) { return execFileSync('git', ['-C', config.repoPath!, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim(); }
function store<T>(action: (store: RunStore) => T): T {
  const value = new RunStore(join(config.storageDir, 'history.sqlite'));
  try {return action(value);} finally {value.close();}
}
async function reviewInput(): Promise<SlackReviewInput> {
  const result = await analyzeThread({config, threadUrl: source.messages[0]!.permalink, collect: async () => source,
    analyzer: {name: 'fixture', model: 'offline', promptVersion: 'v1', analyze: async () => draft}});
  const revisionId = store(value => value.latestRevision(result.runId).id);
  const reviewed = structuredClone(draft); reviewed.requirements[0]!.decisionState = 'confirmed';
  return {runId: result.runId, revisionId, draft: reviewed, requirementIds: ['R1'], actor: 'UAPPROVER', reason: '원문과 완료 조건 검토'};
}
beforeEach(() => {
  mocks.planCalls = 0; mocks.onPlannerConstruct = undefined; mocks.planValue = plan; mocks.implement.mockClear();
  directory = mkdtempSync(join(tmpdir(), 'slack-backend-'));
  config = configSchema.parse({projectId: 'test', slack: {workspace: 'example', channelIds: ['CONE']}, model: 'gpt-4.1-mini',
    storageDir: join(directory, 'history'), repoPath: join(directory, 'repo'),
    development: {readPaths: ['src'], writePaths: ['src'], dockerImage: 'test:local', commands: [{id: 'web-test', program: 'node', args: ['--version']}]},
    github: {repository: 'example/test', baseBranch: 'main', remote: 'origin'}});
  mkdirSync(join(config.repoPath!, 'src'), {recursive: true}); writeFileSync(join(config.repoPath!, 'src/app.ts'), 'export const enabled = false;\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '-m', 'Initial fixture');
});
afterEach(() => rmSync(directory, {recursive: true, force: true}));

describe('Slack backend review and grant integration', () => {
  it('persists a human review, plans exactly selected requirements and returns reviewable code evidence/checks', async () => {
    const input = await reviewInput(); const backend = createSlackBackend(config, 'unused-offline-token');
    const result = await backend.reviewAndPlan(input);
    expect(result).toMatchObject({sourceRunId: input.runId, repository: 'example/test', affectedPaths: ['src/app.ts'], blockers: []});
    expect(result.revisionId).not.toBe(input.revisionId);
    expect(result.summary).toContain('enabled = false'); expect(result.summary).toContain(plan.items[0]!.proposedChanges);
    expect(result.checks).toContain('web-test: node --version');
    expect(result.checks.join('\n')).toContain('A1: web-test');
    const revision = store(value => value.latestRevision(input.runId));
    expect(revision).toMatchObject({id: result.revisionId, origin: 'human', review_state: 'accepted'});
    expect(mocks.planCalls).toBe(1);
    expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('refuses an outdated Slack review under the workflow lock before adding another revision or making a model call', async () => {
    const input = await reviewInput();
    const newer = reviewRun(config, input.runId, input.draft, '다른 검토', 0, 'OTHER');
    const backend = createSlackBackend(config, 'unused-offline-token');
    await expect(backend.reviewAndPlan(input)).rejects.toThrow('Analysis changed after approval');
    expect(store(value => value.latestRevision(input.runId).id)).toBe(newer.revisionId);
    expect(store(value => value.detail(input.runId).revisions)).toHaveLength(2);
    expect(mocks.planCalls).toBe(0);
  });
  it('detects a revision change between reviewing and acquiring the planning lock', async () => {
    const input = await reviewInput();
    mocks.onPlannerConstruct = () => {
      store(value => { value.acquireLock(); value.review(input.runId, input.draft, '동시 편집', 0, 'OTHER'); });
    };
    await expect(createSlackBackend(config, 'unused-offline-token').reviewAndPlan(input)).rejects.toThrow('changed before planning');
    expect(mocks.planCalls).toBe(0);
    expect(mocks.implement).not.toHaveBeenCalled();
    expect(store(value => value.list(config.projectId).filter(run => run.mode === 'plan'))).toHaveLength(0);
  });
  it('checks the exact binding before granting implementation permission', async () => {
    const backend = createSlackBackend(config, 'unused-offline-token');
    const reviewed = await backend.reviewAndPlan(await reviewInput());
    await expect(backend.approveAndImplement({planId: reviewed.planId, bindingHash: 'stale-binding', actor: 'UAPPROVER', reason: '화면 검토'})).rejects.toThrow('Plan changed after approval');
    expect(mocks.implement).not.toHaveBeenCalled();
    expect(store(value => value.detail(value.getPlan(reviewed.planId).run_id).grants)).toEqual([]);
  });
  it('rejects a plan whose source revision changed after Slack displayed it', async () => {
    const input = await reviewInput(); const backend = createSlackBackend(config, 'unused-offline-token');
    const reviewed = await backend.reviewAndPlan(input);
    reviewRun(config, input.runId, input.draft, '추가 검토', 0, 'OTHER');
    await expect(backend.approveAndImplement({planId: reviewed.planId, bindingHash: reviewed.bindingHash, actor: 'UAPPROVER', reason: '화면 검토'})).rejects.toThrow('Plan is stale');
    expect(mocks.implement).not.toHaveBeenCalled();
    expect(store(value => value.detail(value.getPlan(reviewed.planId).run_id).grants)).toEqual([]);
  });
  it('creates the actor-bound grant and requests Draft PR publication, while allowing a null PR result', async () => {
    const backend = createSlackBackend(config, 'unused-offline-token'); const reviewed = await backend.reviewAndPlan(await reviewInput());
    const result = await backend.approveAndImplement({planId: reviewed.planId, bindingHash: reviewed.bindingHash, actor: 'UAPPROVER', reason: '계획과 테스트 명령 검토'});
    expect(result.runId).toBe('implementation-run'); expect(result.prUrl == null).toBe(true);
    expect(mocks.implement).toHaveBeenCalledTimes(1);
    const implementation = mocks.implement.mock.calls[0]![0] as {grantId: string; planId: string; publish: boolean};
    expect(implementation).toMatchObject({planId: reviewed.planId, publish: true});
    const grant = store(value => value.getGrant(implementation.grantId));
    expect(grant).toMatchObject({actor: 'UAPPROVER', allow_pr: 1, binding_hash: reviewed.bindingHash});
  });
  it('does not inspect another project or trust corrupted stored source references', async () => {
    const input = await reviewInput();
    expect(() => createSlackBackend({...config, projectId: 'foreign'}, 'unused-offline-token').inspectAnalysis(input.runId)).toThrow('another project');
    const corrupted = structuredClone(draft); corrupted.requirements[0]!.sourceRefs[0]!.quote = 'not in source';
    store(value => value.addDraft(input.runId, corrupted));
    expect(() => createSlackBackend(config, 'unused-offline-token').inspectAnalysis(input.runId)).toThrow('Evidence quote');
  });
  it('rejects a foreign-project plan before granting permission', async () => {
    const backend = createSlackBackend(config, 'unused-offline-token'); const reviewed = await backend.reviewAndPlan(await reviewInput());
    const foreign = {...config, projectId: 'foreign'};
    store(value => value.saveProject('foreign', foreign, hash(foreign)));
    await expect(createSlackBackend(foreign, 'unused-offline-token').approveAndImplement({planId: reviewed.planId, bindingHash: reviewed.bindingHash, actor: 'UAPPROVER', reason: '검토'})).rejects.toThrow('another project');
    expect(mocks.implement).not.toHaveBeenCalled();
  });
});
