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
function setup(development = false) {
  const directory = mkdtempSync(join(tmpdir(), 'slack-service-')); directories.push(directory);
  const path = join(directory, 'jobs.sqlite'), store = new SlackJobStore(path, 'test'); stores.push(store);
  const config = { ...configSchema.parse({ projectId: 'test', slack: { workspace: 'team', channelIds: ['C1', 'C2'] }, model: 'test',
    ...(development ? { development: { readPaths: ['src', 'tests'], writePaths: ['src', 'tests'], dockerImage: 'node:24',
      commands: [{ id: 'web-tests', program: 'npm', args: ['test', '--', '--run'] }, { id: 'web-typecheck', program: 'npm', args: ['run', 'typecheck'] }] } } : {}) }),
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

function proposalSetup(development = false) {
  const fixture = setup(development);
  fixture.analysis.draft.questions = [];
  fixture.analysis.draft.requirements[0]!.blockingQuestionIds = [];
  fixture.analysis.evidence = { 'message-1': { permalink: thread } };
  fixture.plan.overview = '웹 달력 버튼의 선택 상태를 노출합니다.';
  fixture.plan.changes = [{ id: 'P1', requirementIds: ['R1'], currentBehavior: '선택 상태가 시각적으로만 표시됩니다.', proposedChanges: '날짜 버튼에 aria-pressed를 연결하고 선택 상태 테스트를 추가합니다.', dependencies: [] }];
  fixture.plan.sideEffects = [{ text: '스크린리더의 날짜 선택 안내가 달라질 수 있습니다.', codeRefs: [{ path: 'src/Calendar.tsx', quote: '<button aria-pressed={selected}>' }], verification: '키보드와 스크린리더로 선택 상태를 확인합니다.' }];
  const proposal = { analysis: fixture.analysis, plan: fixture.plan };
  const backend = Object.assign(fixture.backend, {
    prepareProposal: vi.fn(async (_url: string, feedback?: import('../src/slack-service.js').SlackFeedbackInput) => {
      if (feedback) { proposal.analysis.revisionId = `feedback-${feedback.id}`; proposal.plan.bindingHash = `binding-${feedback.id}`; }
      return structuredClone(proposal);
    }),
    inspectProposal: vi.fn(() => structuredClone(proposal)),
    approveProposal: vi.fn(async (_input: import('../src/slack-service.js').SlackProposalApprovalInput) => ({ runId: 'implementation-2', prUrl: 'https://github.com/owner/repo/pull/2' })),
  });
  return { ...fixture, backend, proposal };
}

describe('single-approval proposals and revision-bound feedback', () => {
  it('shows complete approval scope clearly and preserves exact quotations in a read-only details modal', async () => {
    const fixture = proposalSetup();
    const quote = `${'원'.repeat(2890)}😀\n경계를 지나도 인용 전체를 유지합니다.${'문'.repeat(2900)}`;
    fixture.analysis.draft.requirements[0]!.sourceRefs[0]!.quote = quote;
    const { id, action } = await analyzed(fixture);
    const reply = fixture.service.handleCommand(command(`status ${id}`));
    const sections = reply.blocks!.filter(block => ['header', 'section'].includes(block.type as string)).map(block => (block.text as { text: string }).text).join('');
    for (const value of ['[달력 접근성 개선 요구사항]', '요약', '기능 구현', '사이드 이펙트', '1. 선택한 날짜에 aria-pressed를 설정한다.',
      'src/Calendar.tsx', '스크린리더의 날짜 선택 안내가 달라질 수 있습니다.', 'web-tests', '상세 구현 계획과 완료 조건을 확인한 뒤 승인해 주세요.']) expect(sections).toContain(value);
    for (const detail of [quote, thread, 'binding-1', 'snapshot-1', 'message-1', '<button aria-pressed={selected}>', 'R1', 'AC1', '선택한 날짜만 true이다.',
      '키보드와 스크린리더로 선택 상태를 확인합니다.', '선택 상태가 시각적으로만 표시됩니다.', '날짜 버튼에 aria-pressed를 연결하고 선택 상태 테스트를 추가합니다.']) expect(sections).not.toContain(detail);
    expect(reply.text).toMatch(/^\[달력 접근성 개선 요구사항\]/);
    expect(reply.blocks![0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '[달력 접근성 개선 요구사항]', emoji: false } });
    const contentBlocks = reply.blocks!.filter(block => ['header', 'section'].includes(block.type as string) && !block.accessory);
    expect(contentBlocks.length).toBeGreaterThan(4);
    expect(contentBlocks.map(block => (block.text as { text: string }).text).join('\n\n')).toBe(reply.text);
    expect(contentBlocks.filter(block => block.type === 'section').every(block => (block.text as { type: string; verbatim: boolean }).type === 'mrkdwn' && (block.text as { verbatim: boolean }).verbatim)).toBe(true);
    expect(contentBlocks.some(block => (block.text as { text: string }).text.includes('기능 구현\n1.'))).toBe(true);
    const details = await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_details', value: action.nonce });
    expect(details.modal).toMatchObject({ callback_id: 'sd_proposal_details', private_metadata: action.nonce });
    expect(details.modal!.submit).toBeUndefined();
    const evidence = (details.modal!.blocks as Array<{ text: { text: string } }>).map(block => block.text.text).join('');
    for (const value of [quote, thread, 'binding-1', 'snapshot-1', 'message-1', '<button aria-pressed={selected}>', '선택한 날짜만 true이다.',
      '키보드와 스크린리더로 선택 상태를 확인합니다.', '선택 상태가 시각적으로만 표시됩니다.', '날짜 버튼에 aria-pressed를 연결하고 선택 상태 테스트를 추가합니다.']) expect(evidence).toContain(value);
    expect(fixture.store.action(action.nonce).consumedAt).toBeNull(); expect(fixture.store.get(id).status).toBe('awaiting_approval');
    expect(reply.blocks!.every(block => block.type !== 'section' || (block.text as { text: string }).text.length <= 3000)).toBe(true);
    const buttons = reply.blocks!.find(block => block.type === 'actions')!.elements as Array<{ action_id: string; text: { text: string }; confirm?: unknown }>;
    expect(buttons.map(button => button.action_id)).toEqual(['sd_proposal_yes', 'sd_proposal_no']);
    expect(buttons.map(button => button.text.text)).toEqual(['예 · 구현하고 PR 만들기', '아니요 · 수정 요청']);
    const detailsButton = reply.blocks!.find(block => block.accessory)!.accessory as { text: { text: string } };
    expect(detailsButton.text.text).toBe('구현 계획·근거 보기');
    expect(reply.text).toContain('현재 코드 기준 사이드 이펙트');
    expect(reply.text).not.toMatch(/\b[YN]\b/);
    expect(buttons[0]!.confirm).toBeUndefined();
    expect(fixture.backend.prepareProposal).toHaveBeenCalledExactlyOnceWith(thread);
    expect(fixture.backend.analyze).not.toHaveBeenCalled(); expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
  });
  it('keeps every feature, excluded feature, impact, file and question visible without repeating detailed criteria or command arguments', async () => {
    const fixture = proposalSetup(true);
    fixture.analysis.draft.title = '날짜 선택 접근성';
    fixture.analysis.draft.summary = '선택한 날짜를 스크린리더에 알려줍니다.\n키보드로 선택한 날짜도 같은 상태를 표시합니다.';
    const original = fixture.analysis.draft.requirements[0]!;
    fixture.analysis.draft.requirements = [
      { ...original, id: 'R_LONG_SOURCE_IDENTIFICATION_SELECTED_DATE' },
      { ...structuredClone(original), id: 'R_LONG_SOURCE_IDENTIFICATION_KEYBOARD', statement: '키보드로 선택한 날짜도 선택 상태에 반영한다.' },
      { ...structuredClone(original), id: 'R_LONG_SOURCE_IDENTIFICATION_EXCLUDED', statement: '별도의 모바일 날짜 입력창을 만든다.', decisionState: 'rejected' },
    ];
    fixture.analysis.draft.questions = [{ id: 'Q_LONG_IDENTIFIER', text: '기존 키보드 테스트를 확인할 수 있나요?\n대상 브라우저를 알려 주세요.', blocking: false, affectedRequirementIds: [], sourceRefs: [] }];
    fixture.plan.affectedPaths.push('src/Keyboard.tsx', 'tests/keyboard.test.ts');
    fixture.plan.checks = ['web-tests: npm test -- --run', 'web-typecheck: npm run typecheck', 'AC_LONG_IDENTIFIER: web-tests — 선택한 날짜만 true'];
    fixture.plan.sideEffects!.push({ text: '키보드 이동 후 스크린리더 안내 순서가 바뀔 수 있습니다.', codeRefs: [{ path: 'src/Keyboard.tsx', quote: 'handleArrowKey(event)' }], verification: '방향키를 눌러 읽기 순서를 확인합니다.' });
    const { id, action } = await analyzed(fixture);
    const reply = fixture.service.handleCommand(command(`status ${id}`));
    expect(reply.text).toMatch(/^\[날짜 선택 접근성 요구사항\]/);
    for (const requirement of fixture.analysis.draft.requirements) expect(reply.text).toContain(requirement.statement);
    expect(reply.text).toContain('이번 구현에서 제외\n• 별도의 모바일 날짜 입력창을 만든다.');
    for (const effect of fixture.plan.sideEffects!) expect(reply.text).toContain(effect.text);
    for (const path of fixture.plan.affectedPaths) expect(reply.text).toContain(path);
    expect(reply.text).toContain('검증: web-tests · web-typecheck');
    expect(reply.text).toContain(fixture.analysis.draft.questions[0]!.text);
    for (const hidden of ['R_LONG_', 'Q_LONG_', 'AC_LONG_', 'npm test -- --run', 'npm run typecheck', original.acceptanceCriteria[0]!.text]) expect(reply.text).not.toContain(hidden);
    const detail = await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_details', value: action.nonce });
    const text = (detail.modal!.blocks as Array<{ text: { text: string } }>).map(block => block.text.text).join('');
    expect(text).toContain('npm test -- --run'); expect(text).toContain('npm run typecheck');
    expect(text).toContain(original.acceptanceCriteria[0]!.text); expect(text).toContain('방향키를 눌러 읽기 순서를 확인합니다.');
  });
  it('preserves long proposal text within Slack section and message block limits', async () => {
    for (const manyParagraphs of [false, true]) {
      const fixture = proposalSetup();
      fixture.analysis.draft.summary = manyParagraphs ? Array.from({ length: 60 }, (_, index) => `문단 ${index}: 모든 내용을 보존합니다.`).join('\n\n') : '긴 기능 설명을 여러 블록으로 나눕니다.';
      fixture.analysis.draft.requirements[0]!.statement = `${'가'.repeat(2890)}😀${'나'.repeat(3100)} <@U1> <!channel> <https://example.com|링크> & 원문\n다음 줄`;
      const { id } = await analyzed(fixture);
      const reply = fixture.service.handleCommand(command(`status ${id}`));
      const blocks = reply.blocks!.filter(block => ['header', 'section'].includes(block.type as string) && !block.accessory);
      const rendered = blocks.map(block => (block.text as { text: string }).text).join('');
      const decoded = rendered.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      expect(decoded.replace(/\s/g, '')).toBe(reply.text.replace(/\s/g, ''));
      expect(reply.blocks!.length).toBeLessThanOrEqual(50);
      for (const block of blocks) {
        const text = block.text as { type: string; text: string; verbatim?: boolean };
        expect(text.type).toBe(block.type === 'header' ? 'plain_text' : 'mrkdwn');
        if (block.type === 'section') expect(text.verbatim).toBe(true);
        expect(text.text.length).toBeLessThanOrEqual(block.type === 'header' ? 150 : 2900);
        expect(/[\uD800-\uDBFF]$/.test(text.text)).toBe(false);
      }
      expect(rendered).toContain('&lt;@U1&gt; &lt;!channel&gt; &lt;https://example.com|링크&gt; &amp; 원문\n다음 줄');
      expect(rendered).not.toContain('<@U1>');
      expect(JSON.stringify(reply.blocks)).toContain('sd_proposal_yes');
    }
  });
  it('queues one exact proposal approval across duplicate Y clicks and executes only in the worker', async () => {
    const fixture = proposalSetup(), { id, action } = await analyzed(fixture);
    const replies = await Promise.allSettled([1, 2].map(() => fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: action.nonce })));
    expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 'rejected')).toHaveLength(1);
    expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    const completed = await fixture.service.processNextJob();
    expect(fixture.backend.approveProposal).toHaveBeenCalledExactlyOnceWith({ proposal: fixture.proposal, actor: 'U1', reason: expect.stringContaining('예를 선택해 요구사항 확정') });
    expect(completed?.message.text).toContain('/pull/2'); expect(fixture.store.get(id).status).toBe('completed');
    expect(await fixture.service.processNextJob()).toBeUndefined();
  });
  it('invalidates Y immediately on N, performs no paid work, and can reopen a cancelled feedback modal', async () => {
    const fixture = proposalSetup(), { id, action } = await analyzed(fixture);
    const reply = await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_no', value: action.nonce });
    const feedback = fixture.store.pendingAction(id)!;
    expect(reply.modal).toMatchObject({ callback_id: 'sd_feedback_submit', private_metadata: feedback.nonce });
    expect(feedback.nonce).not.toBe(action.nonce); expect(fixture.store.action(action.nonce).consumedAt).not.toBeNull();
    expect(fixture.store.get(id).status).toBe('awaiting_feedback');
    expect(reply.text).toContain('이전 승인 버튼은 무효');
    expect(reply.text).not.toMatch(/\b[YN]\b/);
    expect(JSON.stringify(reply.modal)).not.toMatch(/\b[YN]\b/);
    await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: action.nonce })).rejects.toThrow(/stale|already/);
    expect(await fixture.service.processNextJob()).toBeUndefined();
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(1); expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.service.handleCommand(command(`status ${id}`)))).not.toContain('sd_proposal_yes');
    expect((await fixture.service.handleAction({ ...identity, actionId: 'sd_feedback_open', value: feedback.nonce })).modal).toMatchObject({ private_metadata: feedback.nonce });
  });
  it('accepts modal feedback once, creates a new proposal and still requires a new Y', async () => {
    const fixture = proposalSetup(), { id, action } = await analyzed(fixture);
    await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_no', value: action.nonce });
    const feedback = fixture.store.pendingAction(id)!;
    const request = { ...identity, privateMetadata: feedback.nonce, text: '모바일 화면은 제외하고 웹만 변경해 주세요.', envelopeId: 'feedback-view-1' };
    await fixture.service.handleFeedbackSubmission(request);
    await fixture.service.handleFeedbackSubmission(request);
    expect(fixture.store.get(id)).toMatchObject({ kind: 'feedback', status: 'queued' });
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(1);
    const next = await fixture.service.processNextJob();
    expect(next?.job.status).toBe('awaiting_approval');
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(2);
    expect(fixture.backend.prepareProposal.mock.calls[1]![1]).toMatchObject({ id: expect.stringMatching(/^view:[a-f0-9]{64}$/), actor: 'U1', text: request.text, previous: { analysis: { revisionId: 'rev-1' } } });
    expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    const newAction = fixture.store.pendingAction(id)!;
    expect(newAction.nonce).not.toBe(action.nonce);
    await fixture.service.handleFeedbackSubmission(request);
    expect(await fixture.service.processNextJob()).toBeUndefined();
    await expect(fixture.service.handleFeedbackSubmission({ ...request, envelopeId: 'replayed-stale-view' })).rejects.toThrow(/stale|already/);
    await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: newAction.nonce });
    await fixture.service.processNextJob(); expect(fixture.backend.approveProposal).toHaveBeenCalledTimes(1);
  });
  it('supports same-channel feedback commands and deduplicates their delivery across proposal revisions', async () => {
    const fixture = proposalSetup(), { id, action } = await analyzed(fixture);
    const request = command(`feedback ${id} 웹만 변경하고\n모바일은 유지해 주세요.`, 'feedback-command-1');
    for (const patch of [{ channelId: 'C2' }, { userId: 'U2' }, { teamId: 'T9' }, { appId: 'A9' }]) expect(() => fixture.service.handleCommand({ ...request, ...patch })).toThrow();
    expect(() => fixture.service.handleCommand(command(`feedback ${id}`, 'empty'))).toThrow(/1–3000/);
    fixture.service.handleCommand(request); fixture.service.handleCommand(request);
    await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: action.nonce })).rejects.toThrow(/stale|already/);
    await fixture.service.processNextJob();
    expect(fixture.backend.prepareProposal.mock.calls[1]![1]).toMatchObject({ text: '웹만 변경하고\n모바일은 유지해 주세요.', actor: 'U1' });
    fixture.service.handleCommand(request);
    expect(await fixture.service.processNextJob()).toBeUndefined();
    expect(() => fixture.service.handleCommand({ ...request, text: `feedback ${id} 다른 내용` })).toThrow(/identity/);
  });
  it('requires an approver for Y, N and feedback modal submissions without revealing stale proposal details', async () => {
    const fixture = proposalSetup(), { action } = await analyzed(fixture);
    for (const actionId of ['sd_proposal_yes', 'sd_proposal_no', 'sd_proposal_details']) for (const patch of [{ userId: 'U2' }, { channelId: 'C2' }, { teamId: 'T9' }, { appId: 'A9' }]) {
      await expect(fixture.service.handleAction({ ...identity, ...patch, actionId, value: action.nonce })).rejects.toThrow();
    }
    expect(fixture.backend.inspectProposal).not.toHaveBeenCalled();
    const reply = await fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_no', value: action.nonce });
    const privateMetadata = reply.modal!.private_metadata as string;
    for (const patch of [{ userId: 'U2' }, { teamId: 'T9' }, { appId: 'A9' }]) await expect(fixture.service.handleFeedbackSubmission({ ...identity, ...patch, privateMetadata, text: '웹만', envelopeId: 'view1' })).rejects.toThrow(/authorized/);
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(1);
  });
  it('allows only one winner in a simultaneous Y/N race', async () => {
    const fixture = proposalSetup(), { id, action } = await analyzed(fixture);
    const responses = await Promise.allSettled(['sd_proposal_yes', 'sd_proposal_no'].map(actionId => fixture.service.handleAction({ ...identity, actionId, value: action.nonce })));
    expect(responses.filter(response => response.status === 'fulfilled')).toHaveLength(1);
    expect(responses.filter(response => response.status === 'rejected')).toHaveLength(1);
    expect(['queued', 'awaiting_feedback']).toContain(fixture.store.get(id).status);
    await fixture.service.processNextJob();
    expect(fixture.backend.approveProposal.mock.calls.length).toBeLessThanOrEqual(1);
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(1);
  });
  it('rejects stale proposal clicks, stale feedback submission and changes after queueing before model or code execution', async () => {
    const fixture = proposalSetup(), { action } = await analyzed(fixture);
    fixture.proposal.analysis.revisionId = 'changed';
    for (const actionId of ['sd_proposal_yes', 'sd_proposal_no']) await expect(fixture.service.handleAction({ ...identity, actionId, value: action.nonce })).rejects.toThrow(/Proposal changed/);
    const feedback = proposalSetup(), ready = await analyzed(feedback);
    const no = await feedback.service.handleAction({ ...identity, actionId: 'sd_proposal_no', value: ready.action.nonce });
    feedback.proposal.analysis.revisionId = 'changed';
    await expect(feedback.service.handleFeedbackSubmission({ ...identity, privateMetadata: no.modal!.private_metadata as string, text: '수정', envelopeId: 'view1' })).rejects.toThrow(/Proposal changed/);
    const queued = proposalSetup(), pending = await analyzed(queued);
    queued.service.handleCommand(command(`feedback ${pending.id} 웹만`, 'feedback1'));
    queued.proposal.analysis.revisionId = 'changed';
    expect((await queued.service.processNextJob())?.job.status).toBe('needs_resume');
    expect(queued.backend.prepareProposal).toHaveBeenCalledTimes(1);
    const approved = proposalSetup(), yes = await analyzed(approved);
    await approved.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: yes.action.nonce });
    approved.proposal.plan.baseCommit = 'changed';
    expect((await approved.service.processNextJob())?.job.status).toBe('needs_resume');
    expect(approved.backend.approveProposal).not.toHaveBeenCalled();
  });
  it('withholds Y for blocked or oversized proposals without silently truncating approval content', async () => {
    for (const state of ['question', 'blocker', 'large', 'evidence', 'escaped'] as const) {
      const fixture = proposalSetup();
      if (state === 'question') fixture.analysis.draft.questions = [{ id: 'Q1', text: '어느 화면인가요?', blocking: true, affectedRequirementIds: ['R1'], sourceRefs: [] }];
      if (state === 'blocker') fixture.plan.blockers = ['대상 파일을 확인해야 합니다.'];
      if (state === 'large') fixture.analysis.draft.requirements[0]!.statement = '가'.repeat(36_000);
      if (state === 'evidence') fixture.analysis.draft.requirements[0]!.sourceRefs[0]!.quote = '가'.repeat(300_000);
      if (state === 'escaped') fixture.analysis.draft.requirements[0]!.statement = '&'.repeat(30_000);
      const { id, action } = await analyzed(fixture);
      const reply = fixture.service.handleCommand(command(`status ${id}`));
      expect(JSON.stringify(reply.blocks)).not.toContain('sd_proposal_yes'); expect(JSON.stringify(reply.blocks)).toContain('sd_proposal_no');
      if (state === 'large' || state === 'evidence' || state === 'escaped') expect(reply.text).toContain('Slack 표시 한도');
      expect(reply.blocks!.length).toBeLessThanOrEqual(50);
      if (state === 'evidence') {
        expect(JSON.stringify(reply.blocks)).not.toContain('sd_proposal_details');
        await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_details', value: action.nonce })).rejects.toThrow(/Slack 표시 한도/);
      }
      await expect(fixture.service.handleAction({ ...identity, actionId: 'sd_proposal_yes', value: action.nonce })).rejects.toThrow();
      expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    }
  });
  it('requires deliberate recovery when feedback delivery or implementation may already have happened', async () => {
    const fixture = proposalSetup(), { id } = await analyzed(fixture);
    fixture.backend.prepareProposal.mockRejectedValueOnce(new Error('delivery result unknown xoxb-secret123'));
    fixture.service.handleCommand(command(`feedback ${id} 웹만`, 'feedback1'));
    const failed = await fixture.service.processNextJob();
    expect(failed?.job.status).toBe('needs_resume'); expect(failed?.message.text).not.toContain('secret123');
    expect(await fixture.service.processNextJob()).toBeUndefined();
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(2);
  });
});
