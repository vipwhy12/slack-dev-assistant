import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.js';
import { SlackJobStore } from '../src/slack-jobs.js';
import { SlackService, type SlackAnalysis, type SlackPlan, type SlackWorkflowBackend, type SlackCommandRequest, type SlackReviewInput } from '../src/slack-service.js';

const directories: string[] = [], stores: SlackJobStore[] = [];
const thread = 'https://team.slack.com/archives/C1/p1795086841177069';
const identity = { teamId: 'T1', appId: 'A1', userId: 'U1', channelId: 'C1' };
const command = (text = `analyze ${thread}`, envelopeId = 'envelope-1'): SlackCommandRequest => ({ ...identity, command: '/duduk', text, envelopeId });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'slack-service-')); directories.push(directory);
  const path = join(directory, 'jobs.sqlite'), store = new SlackJobStore(path, 'test'); stores.push(store);
  const config = { ...configSchema.parse({ projectId: 'test', slack: { workspace: 'team', channelIds: ['C1', 'C2'] }, model: 'test' }),
    slackApp: { teamId: 'T1', appId: 'A1', command: '/duduk', allowedUserIds: ['U1', 'U2'], approverUserIds: ['U1'] } };
  const analysis: SlackAnalysis = { runId: 'run-1', revisionId: 'rev-1', snapshotId: 'snapshot-1', draft: {
    summary: '달력 접근성 개선', requirements: [{ id: 'R1', statement: '선택한 날짜에 aria-pressed를 설정한다.', decisionState: 'proposed', sourceRefs: [{ messageVersionId: 'message-1', quote: '선택한 날짜' }], supersedesIds: [], blockingQuestionIds: ['Q1'],
      acceptanceCriteria: [{ id: 'AC1', text: '선택한 날짜만 true이다.', origin: 'derived', sourceRefs: [] }] }],
    questions: [{ id: 'Q1', text: '웹과 모바일 중 어디에 적용하나요?', blocking: true, affectedRequirementIds: ['R1'], sourceRefs: [] }],
  } };
  const plan: SlackPlan = { planId: 'plan-1', sourceRunId: 'run-1', revisionId: 'review-1', bindingHash: 'binding-1', summary: '웹 달력 버튼 접근성 개선',
    affectedPaths: ['src/Calendar.tsx', 'tests/calendar.test.ts'], checks: ['web-tests', 'web-typecheck'], blockers: [], repository: 'owner/repo', baseCommit: 'abc123' };
  const backend = { save: vi.fn(async () => ({ summary: '저장 완료', factCount: 2 })), analyze: vi.fn(async () => structuredClone(analysis)),
    inspectAnalysis: vi.fn(() => structuredClone(analysis)), reviewAndPlan: vi.fn(async (_input: SlackReviewInput) => structuredClone(plan)),
    inspectPlan: vi.fn(() => structuredClone(plan)), approveAndImplement: vi.fn(async () => ({ runId: 'implement-1', prUrl: 'https://github.com/owner/repo/pull/1' })),
  } satisfies SlackWorkflowBackend;
  const service = new SlackService(config, store, backend);
  return { service, store, backend, analysis, plan, path };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function analyzed(fixture: ReturnType<typeof setup>) {
  const id = fixture.service.handleCommand(command()).jobId!;
  await fixture.service.processNextJob();
  return { id, action: fixture.store.pendingAction(id)! };
}
async function planned(fixture: ReturnType<typeof setup>) {
  const { id, action } = await analyzed(fixture);
  await fixture.service.handleReviewSubmission({ ...identity, privateMetadata: action.nonce, selectedRequirementIds: ['R1'], answers: { Q1: '웹만 적용합니다.' }, reason: '범위와 완료 조건을 확인했습니다.' });
  await fixture.service.processNextJob();
  return { id, action: fixture.store.pendingAction(id)! };
}

describe('SlackService commands and security', () => {
  it('authenticates team/app/channel/user and rejects cross-channel collection before any backend call', () => {
    const { service, backend } = setup();
    for (const patch of [{ teamId: 'T9' }, { appId: 'A9' }, { channelId: 'C9' }, { userId: 'U9' }, { command: '/other' }]) {
      expect(() => service.handleCommand({ ...command(), ...patch })).toThrow();
    }
    expect(() => service.handleCommand(command('analyze https://team.slack.com/archives/C2/p1795086841177069'))).toThrow(/same channel/);
    expect(() => service.handleCommand(command('analyze https://other.slack.com/archives/C1/p1795086841177069'))).toThrow(/workspace/);
    expect(backend.analyze).not.toHaveBeenCalled();
  });
  it('saves normalized knowledge through the backend once per envelope and status survives delivery loss', async () => {
    const { service, store, backend } = setup();
    const request = command(`save <${thread}>`);
    const queued = service.handleCommand(request);
    expect(service.handleCommand(request).jobId).toBe(queued.jobId);
    expect(backend.save).not.toHaveBeenCalled();
    const completed = await service.processNextJob();
    expect(completed?.message.text).toContain('저장한 지식: 2건');
    expect(store.get(queued.jobId!).status).toBe('completed');
    expect(await service.processNextJob()).toBeUndefined();
    expect(backend.save).toHaveBeenCalledTimes(1);
    expect(service.handleCommand(command(`status ${queued.jobId}`)).text).toContain('completed');
  });
  it('keeps status commands responsive while the worker is waiting on a model', async () => {
    const { service, backend } = setup();
    let resolve!: (value: { summary: string; factCount: number }) => void;
    backend.save.mockImplementation(() => new Promise(done => { resolve = done; }));
    const id = service.handleCommand(command(`save ${thread}`)).jobId!;
    const running = service.processNextJob();
    expect(service.handleCommand(command(`status ${id}`)).text).toContain('running');
    expect(await service.processNextJob()).toBeUndefined();
    resolve({ summary: 'done', factCount: 1 }); await running;
  });
  it('uses the actual collected root for save and analyze results from reply permalinks', async () => {
    const saved = setup();
    saved.backend.save.mockImplementation(async () => ({ summary: '저장 완료', factCount: 1, threadTs: '1795086800.000001' }));
    saved.service.handleCommand(command(`save ${thread}`));
    expect((await saved.service.processNextJob())?.job.threadTs).toBe('1795086800.000001');
    const analyzed = setup(); analyzed.analysis.threadTs = '1795086800.000002';
    analyzed.service.handleCommand(command());
    expect((await analyzed.service.processNextJob())?.job.threadTs).toBe('1795086800.000002');
  });
  it('does not leak another channel job or preserve transport secrets', async () => {
    const fixture = setup();
    const { id } = await analyzed(fixture);
    expect(() => fixture.service.handleCommand({ ...command(`status ${id}`), channelId: 'C2' })).toThrow(/another channel/);
    const raw = readFileSync(fixture.path).toString();
    expect(raw).not.toContain('response_url'); expect(raw).not.toContain('xoxb-');
    expect(fixture.service.handleCommand(command(`status ${id}`)).blocks).toBeDefined();
  });
});

describe('human approvals', () => {
  it('renders an explicit review modal and blocks unanswered questions without consuming approval', async () => {
    const fixture = setup(), { id, action } = await analyzed(fixture);
    const response = await fixture.service.handleAction({ ...identity, actionId: 'sd_review', value: action.nonce });
    expect(response.modal).toMatchObject({ callback_id: 'sd_review_submit', private_metadata: action.nonce });
    await expect(fixture.service.handleReviewSubmission({ ...identity, privateMetadata: action.nonce, selectedRequirementIds: ['R1'], answers: {}, reason: 'review' })).rejects.toThrow(/blocking question/);
    expect(fixture.store.get(id).status).toBe('awaiting_review');
    expect(fixture.store.action(action.nonce).consumedAt).toBeNull();
    expect(fixture.backend.reviewAndPlan).not.toHaveBeenCalled();
  });
  it('preserves every character of a long question across modal section boundaries', async () => {
    const fixture = setup();
    const question = `${'가'.repeat(2790)}\n첫 경계의 문장이 빠지면 안 됩니다.\n${'나'.repeat(2790)}\n둘째 경계의 문장도 유지합니다.\n${'다'.repeat(2790)}\n마지막 문단입니다.`;
    fixture.analysis.draft.questions[0]!.text = question;
    const { action } = await analyzed(fixture);
    const response = await fixture.service.handleAction({ ...identity, actionId: 'sd_review', value: action.nonce });
    const blocks = response.modal!.blocks as Array<{ type: string; block_id?: string; text?: { text: string } }>;
    const start = blocks.findIndex(block => block.text?.text.startsWith('Q1\n'));
    const end = blocks.findIndex(block => block.block_id === 'q_0');
    expect(start).toBeGreaterThanOrEqual(0);
    const sections = blocks.slice(start, end);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.every(block => block.type === 'section' && block.text!.text.length <= 3000)).toBe(true);
    expect(sections.map(block => block.text!.text).join('').slice('Q1\n'.length)).toBe(question);
  });
  it('requires authorized approvers for both modal submission and buttons', async () => {
    const fixture = setup(), { action } = await analyzed(fixture);
    await expect(fixture.service.handleAction({ ...identity, userId: 'U2', actionId: 'sd_review', value: action.nonce })).rejects.toThrow(/authorized/);
    await expect(fixture.service.handleReviewSubmission({ ...identity, userId: 'U2', privateMetadata: action.nonce, selectedRequirementIds: ['R1'], answers: { Q1: 'web' }, reason: 'review' })).rejects.toThrow(/authorized/);
    for (const patch of [{ teamId: 'T9' }, { appId: 'A9' }, { channelId: 'C2' }]) {
      await expect(fixture.service.handleAction({ ...identity, ...patch, actionId: 'sd_review', value: action.nonce })).rejects.toThrow();
    }
    expect(fixture.backend.inspectAnalysis).not.toHaveBeenCalled();
  });
  it('records explicit human answers and confirmation, then grants implementation only once', async () => {
    const fixture = setup(), { id, action } = await planned(fixture);
    const review = fixture.backend.reviewAndPlan.mock.calls[0]![0];
    expect(review).toMatchObject({ actor: 'U1', revisionId: 'rev-1', requirementIds: ['R1'] });
    expect(review.draft.requirements[0]).toMatchObject({ decisionState: 'confirmed', blockingQuestionIds: [] });
    expect(review.draft.questions[0]).toMatchObject({ blocking: false });
    expect(review.draft.questions[0]!.text).toContain('사람 검토 답변 (U1): 웹만 적용합니다.');
    expect(fixture.backend.approveAndImplement).not.toHaveBeenCalled();
    const results = await Promise.allSettled([1, 2].map(() => fixture.service.handleAction({ ...identity, actionId: 'sd_implement', value: action.nonce })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const completed = await fixture.service.processNextJob();
    expect(completed?.message.text).toContain('https://github.com/owner/repo/pull/1');
    expect(fixture.backend.approveAndImplement).toHaveBeenCalledTimes(1);
    expect(fixture.backend.approveAndImplement).toHaveBeenCalledWith({ planId: 'plan-1', bindingHash: 'binding-1', actor: 'U1', reason: expect.stringContaining('병합 및 배포는 승인하지 않음') });
    expect(fixture.store.get(id).status).toBe('completed');
  });
  it('rejects stale analysis and stale plan approval without mutation', async () => {
    const fixture = setup(), { action } = await analyzed(fixture);
    fixture.analysis.revisionId = 'rev-2';
    await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_review', value: action.nonce })).rejects.toThrow(/Analysis changed/);
    expect(fixture.store.action(action.nonce).consumedAt).toBeNull();
    const other = setup(), ready = await planned(other);
    other.plan.bindingHash = 'changed';
    await expect(other.service.handleAction({ ...identity, actionId: 'sd_implement', value: ready.action.nonce })).rejects.toThrow(/Plan changed/);
    expect(other.backend.approveAndImplement).not.toHaveBeenCalled();
  });
  it('revalidates a plan changed after clicking approve before any grant or execution', async () => {
    const fixture = setup(), { id, action } = await planned(fixture);
    await fixture.service.handleAction({ ...identity, actionId: 'sd_implement', value: action.nonce });
    fixture.plan.baseCommit = 'new-head';
    await fixture.service.processNextJob();
    expect(fixture.backend.approveAndImplement).not.toHaveBeenCalled();
    expect(fixture.store.get(id).status).toBe('needs_resume');
  });
  it('revalidates analysis changed after submitting review before writing the human revision', async () => {
    const fixture = setup(), { id, action } = await analyzed(fixture);
    await fixture.service.handleReviewSubmission({ ...identity, privateMetadata: action.nonce, selectedRequirementIds: ['R1'], answers: { Q1: '웹만' }, reason: '검토' });
    fixture.analysis.revisionId = 'newer-review';
    await fixture.service.processNextJob();
    expect(fixture.backend.reviewAndPlan).not.toHaveBeenCalled();
    expect(fixture.store.get(id).status).toBe('failed');
  });
  it('withholds approval buttons for blocked plans and plans that cannot be fully displayed', async () => {
    const fixture = setup();
    fixture.plan.blockers = ['배포 방식이 정해지지 않음'];
    const ready = await planned(fixture);
    const view = fixture.service.handleCommand(command(`status ${ready.id}`));
    expect(JSON.stringify(view.blocks)).not.toContain('sd_implement');
    await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_implement', value: ready.action.nonce })).rejects.toThrow(/blockers/);
    const large = setup(); large.plan.summary = '설명'.repeat(70_000);
    const huge = await planned(large);
    expect(large.service.handleCommand(command(`status ${huge.id}`)).text).toContain('Slack 표시 한도');
    await expect(large.service.handleAction({ ...identity, actionId: 'sd_implement', value: huge.action.nonce })).rejects.toThrow(/fully displayed/);
    expect(large.backend.approveAndImplement).not.toHaveBeenCalled();
  });
  it('does not retry a partially failed implementation and redacts provider credentials', async () => {
    const fixture = setup(), { id, action } = await planned(fixture);
    fixture.backend.approveAndImplement.mockRejectedValue(new Error('failed xoxb-secret123 xapp-secret456 sk-secret789 https://hooks.slack.com/commands/secret'));
    await fixture.service.handleAction({ ...identity, actionId: 'sd_implement', value: action.nonce });
    const failed = await fixture.service.processNextJob();
    expect(failed?.message.text).not.toContain('secret');
    expect(fixture.store.get(id).status).toBe('needs_resume');
    expect(await fixture.service.processNextJob()).toBeUndefined();
    await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_implement', value: action.nonce })).rejects.toThrow(/already/);
    expect(fixture.backend.approveAndImplement).toHaveBeenCalledTimes(1);
  });
  it('parses view fields using stored question IDs and rejects unknown selected requirements or answers', async () => {
    const fixture = setup(), { action } = await analyzed(fixture);
    const fields = fixture.service.parseReviewValues(action.nonce, {
      req_selection: { value: { selected_options: [{ value: 'R1' }] } }, q_0: { value: { value: '웹만' } }, review_reason: { value: { value: '확인' } },
    });
    expect(fields).toEqual({ selectedRequirementIds: ['R1'], answers: { Q1: '웹만' }, reason: '확인' });
    await expect(fixture.service.handleReviewSubmission({ ...identity, privateMetadata: action.nonce, ...fields, selectedRequirementIds: ['unknown'] })).rejects.toThrow(/eligible/);
    await expect(fixture.service.handleReviewSubmission({ ...identity, privateMetadata: action.nonce, ...fields, answers: { invented: 'clear' } })).rejects.toThrow(/existing blocking/);
  });
});
