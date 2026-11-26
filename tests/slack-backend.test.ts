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
import { SlackFeedbackStore } from '../src/slack-feedback.js';

const mocks = vi.hoisted(() => ({planCalls: 0, onPlannerConstruct: undefined as (() => void) | undefined,
  planValue: undefined as unknown, analysisValue: undefined as unknown, analysisOptions: [] as unknown[],
  implement: vi.fn(async (_input: unknown) => ({runId: 'implementation-run', prUrl: null}))}));
vi.mock('../src/budgeted-analysis.js', () => ({ BudgetedAnalyzer: class {
  readonly name = 'fixture'; readonly model = 'offline'; readonly promptVersion: string;
  constructor(_config: unknown, _url: string, options: unknown) { mocks.analysisOptions.push(options); this.promptVersion = JSON.stringify(options); }
  async analyze() { return structuredClone(mocks.analysisValue); }
} }));
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
  mocks.planCalls = 0; mocks.onPlannerConstruct = undefined; mocks.planValue = plan; mocks.analysisValue = draft; mocks.analysisOptions = []; mocks.implement.mockClear();
  directory = mkdtempSync(join(tmpdir(), 'slack-backend-'));
  config = configSchema.parse({projectId: 'test', slack: {workspace: 'example', channelIds: ['CONE']}, model: 'gpt-4.1-mini',
    slackApp: {teamId: 'TONE', appId: 'AONE', allowedUserIds: ['UAPPROVER'], approverUserIds: ['UAPPROVER']},
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

const url = source.messages[0]!.permalink;
function offlineBackend(read: () => ThreadSnapshot = () => source) {
  return createSlackBackend(config, 'unused-offline-token', 'UBOT', 'BBOT', { collect: async () => read() });
}
function feedbackRecords() {
  const value = new SlackFeedbackStore(join(config.storageDir, 'feedback.sqlite'), config.projectId);
  try { return value.list({ teamId: 'TONE', appId: 'AONE', workspace: 'example', channelId: 'CONE', rootTs: source.rootTs }); }
  finally { value.close(); }
}
describe('single human approval for displayed requirements and exact plan', () => {
  it('prepares source-linked analysis and code preview without creating human review or grant', async () => {
    mocks.planValue = { ...plan, sideEffects: [{ text: '기존 비활성 상태가 바뀝니다.', codeRefs: plan.items[0]!.codeRefs, verification: '활성화 확인' }] };
    const backend = offlineBackend(); const proposal = await backend.prepareProposal!(url);
    expect(proposal.analysis).toMatchObject({ evidence: { M1: { permalink: url } } });
    expect(proposal.plan?.sideEffects).toEqual((mocks.planValue as PlanDraft).sideEffects);
    expect(store(value => value.latestRevision(proposal.analysis.runId))).toMatchObject({ origin: 'model', review_state: 'pending' });
    expect(store(value => value.detail(value.getPlan(proposal.plan!.planId).run_id).grants)).toEqual([]);
    expect(mocks.planCalls).toBe(1); expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('Y confirms displayed requirements and rebinds the identical plan without another model planning call', async () => {
    const backend = offlineBackend(); const proposal = await backend.prepareProposal!(url);
    const originalPlan = store(value => value.getPlan(proposal.plan!.planId));
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: '표시한 내용 Y 승인' })).resolves.toMatchObject({ runId: 'implementation-run' });
    expect(mocks.planCalls).toBe(1); expect(mocks.implement).toHaveBeenCalledTimes(1);
    const implementation = mocks.implement.mock.calls[0]![0] as { planId: string; grantId: string; publish: boolean };
    const approvedPlan = store(value => value.getPlan(implementation.planId));
    expect(implementation.publish).toBe(true); expect(approvedPlan.id).not.toBe(originalPlan.id);
    expect(approvedPlan.data_json).toBe(originalPlan.data_json); expect(approvedPlan.context_json).toBe(originalPlan.context_json);
    expect(approvedPlan.spec_revision_id).not.toBe(originalPlan.spec_revision_id);
    expect(store(value => value.getGrant(implementation.grantId))).toMatchObject({ actor: 'UAPPROVER', allow_pr: 1, binding_hash: approvedPlan.binding_hash });
    expect(store(value => value.latestRevision(proposal.analysis.runId))).toMatchObject({ origin: 'human', review_state: 'accepted' });
    expect(JSON.parse(store(value => value.latestRevision(proposal.analysis.runId).data_json)).requirements[0].decisionState).toBe('confirmed');
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: '재전송' })).rejects.toThrow('Analysis changed');
    expect(mocks.implement).toHaveBeenCalledTimes(1);
  });
  it('rejects a Slack edit before adding a human revision or permission grant', async () => {
    let live = source; const backend = offlineBackend(() => live); const proposal = await backend.prepareProposal!(url);
    live = structuredClone(source); live.messages[0]!.text += ' 변경된 요구사항';
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: 'Y' })).rejects.toThrow('Slack source changed');
    expect(store(value => value.detail(proposal.analysis.runId).revisions)).toHaveLength(1);
    expect(store(value => value.detail(value.getPlan(proposal.plan!.planId).run_id).grants)).toEqual([]);
    expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('rejects a forged display or unauthorized actor without running implementation', async () => {
    const backend = offlineBackend(); const proposal = await backend.prepareProposal!(url);
    const forged = structuredClone(proposal); forged.plan!.summary = '다른 계획';
    await expect(backend.approveProposal!({ proposal: forged, actor: 'UAPPROVER', reason: 'Y' })).rejects.toThrow('Plan changed');
    await expect(backend.approveProposal!({ proposal, actor: 'UOTHER', reason: 'Y' })).rejects.toThrow('not authorized');
    expect(store(value => value.detail(proposal.analysis.runId).revisions)).toHaveLength(1);
    expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('does not approve unresolved blocking questions', async () => {
    const value = structuredClone(draft); value.questions.push({ id: 'Q1', text: '실행 방식은?', blocking: true, affectedRequirementIds: ['R1'], sourceRefs: [{messageVersionId:'M1',quote:'클릭하면 실행한다.'}] });
    value.requirements[0]!.blockingQuestionIds = ['Q1']; mocks.analysisValue = value;
    const backend = offlineBackend(); const proposal = await backend.prepareProposal!(url);
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: 'Y' })).rejects.toThrow('unresolved blocking');
    expect(store(value => value.detail(proposal.analysis.runId).revisions)).toHaveLength(1);
    expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('rejects a repository revision changed while the proposal was awaiting Y', async () => {
    const backend = offlineBackend(); const proposal = await backend.prepareProposal!(url);
    writeFileSync(join(config.repoPath!, 'src/app.ts'), 'export const enabled = false;\n// 다른 작업\n'); git('add', '.'); git('commit', '-m', 'Concurrent work');
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: 'Y' })).rejects.toThrow('Plan is stale');
    expect(mocks.planCalls).toBe(1); expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('checks the live thread again before granting after the human rebind', async () => {
    let calls = 0;
    const backend = offlineBackend(() => {
      calls++; if (calls < 3) return source;
      const changed = structuredClone(source); changed.messages[0]!.text += ' 승인 중 변경'; return changed;
    });
    const proposal = await backend.prepareProposal!(url);
    await expect(backend.approveProposal!({ proposal, actor: 'UAPPROVER', reason: 'Y' })).rejects.toThrow('Slack source changed');
    const plans = store(value => value.list(config.projectId).filter(run => run.mode === 'plan'));
    expect(plans).toHaveLength(2);
    for (const run of plans) expect(store(value => value.detail(run.id).grants)).toEqual([]);
    expect(mocks.implement).not.toHaveBeenCalled();
  });
});

describe('authenticated feedback echo source integration', () => {
  function fixture() {
    let live = structuredClone(source);
    const collect = vi.fn(async (_url: string, included: string[]) => ({ ...structuredClone(live), messages: live.messages.filter(message => message.author !== 'UBOT' || included.includes(message.ts)) }));
    const postFeedback = vi.fn(async (input: {text: string}) => {
      const ts = '1795046401.000001';
      live.messages.push({ ...source.messages[0]!, id: 'FEEDBACK1', ts, text: input.text, author: 'UBOT', permalink: `https://example.slack.com/archives/CONE/p${ts.replace('.', '')}?thread_ts=${source.rootTs}&cid=CONE` });
      return {ts};
    });
    const backend = createSlackBackend(config, 'unused-offline-token', 'UBOT', 'BBOT', { collect, postFeedback });
    return { backend, collect, postFeedback, editEcho: (text: string) => {live.messages[1]!.text = text;} };
  }
  it('echoes only authenticated feedback, preserves actor/revision provenance and supplies the real source reference', async () => {
    const { backend, collect, postFeedback } = fixture(); const previous = await backend.prepareProposal!(url);
    const feedback = { id: 'command:feedback-one', text: '버튼 색상은 유지해 주세요.', actor: 'UAPPROVER', previous };
    const proposal = await backend.prepareProposal!(url, feedback);
    expect(postFeedback).toHaveBeenCalledTimes(1);
    expect(postFeedback).toHaveBeenCalledWith(expect.objectContaining({channelId:'CONE', threadTs:source.rootTs, actor:'UAPPROVER'}));
    expect(collect.mock.calls.at(-1)![1]).toEqual(['1795046401.000001']);
    expect(feedbackRecords()).toMatchObject([{ id: feedback.id, status: 'linked', actor: 'UAPPROVER', postedTs: '1795046401.000001', messageVersionId: 'FEEDBACK1', previousRevisionId: previous.analysis.revisionId, previousPlanId: previous.plan!.planId }]);
    expect(proposal.analysis.evidence?.FEEDBACK1?.permalink).toContain('p1795046401000001');
    expect(mocks.analysisOptions.at(-1)).toMatchObject({feedback:{entries:[{actor:'UAPPROVER',text:feedback.text,messageVersionId:'FEEDBACK1'}], previousProposal:previous}});
    expect(store(value => value.latestRevision(proposal.analysis.runId))).toMatchObject({origin:'model',review_state:'pending'});
    expect(mocks.implement).not.toHaveBeenCalled();
  });
  it('does not post foreign-thread or unauthorized feedback', async () => {
    const { backend, postFeedback } = fixture(); const previous = await backend.prepareProposal!(url);
    await expect(backend.prepareProposal!('https://example.slack.com/archives/CONE/p1795046499000001', {id:'command:one',text:'변경',actor:'UAPPROVER',previous})).rejects.toThrow('another Slack thread');
    await expect(backend.prepareProposal!(url, {id:'command:one',text:'변경',actor:'UOTHER',previous})).rejects.toThrow('not authorized');
    expect(postFeedback).not.toHaveBeenCalled();
  });
  it('never automatically repeats an echo with an unknown delivery outcome', async () => {
    const postFeedback = vi.fn(async () => {throw new Error('connection closed after send');});
    const backend = createSlackBackend(config, 'unused-offline-token', 'UBOT', 'BBOT', {collect:async()=>source,postFeedback});
    const previous = await backend.prepareProposal!(url); const feedback = {id:'view:uncertain-one',text:'변경',actor:'UAPPROVER',previous};
    await expect(backend.prepareProposal!(url, feedback)).rejects.toThrow('delivery is uncertain');
    await expect(backend.prepareProposal!(url, feedback)).rejects.toThrow('Automatic repost is blocked');
    expect(postFeedback).toHaveBeenCalledTimes(1); expect(mocks.analysisOptions).toHaveLength(1);
    expect(feedbackRecords()).toEqual([]);
  });
  it('rejects a changed echo before any additional model call', async () => {
    const {backend, editEcho} = fixture(); const previous = await backend.prepareProposal!(url);
    await backend.prepareProposal!(url, {id:'command:one',text:'색상 유지',actor:'UAPPROVER',previous});
    editEcho('봇 피드백을 임의로 변경');
    await expect(backend.analyze(url)).rejects.toThrow('Feedback echo does not match');
    expect(mocks.analysisOptions).toHaveLength(2);
  });
});
