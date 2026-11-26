import type { AnalysisDraft } from './analysis.js';
import type { ProjectConfig } from './config.js';
import { hash } from './domain.js';
import { requirementsTitle } from './presentation.js';
import { parseThreadUrl } from './slack.js';
import { SlackJobStore, type SlackAction, type SlackJob } from './slack-jobs.js';

export interface SlackAppPolicy { teamId: string; appId: string; command: string; allowedUserIds: string[]; approverUserIds: string[] }
export interface SlackIdentity { teamId: string; appId: string; userId: string }
export interface SlackCommandRequest extends SlackIdentity { channelId: string; command: string; text: string; envelopeId: string }
export interface SlackActionRequest extends SlackIdentity { channelId: string; actionId: string; value: string }
export interface SlackAnalysis {
  runId: string; revisionId: string; snapshotId: string; draft: AnalysisDraft; threadTs?: string;
  evidence?: Record<string, { permalink: string }>;
}
export interface SlackPlan {
  planId: string; sourceRunId: string; revisionId: string; bindingHash: string;
  summary: string; affectedPaths: string[]; checks: string[]; blockers: string[];
  repository: string; baseCommit: string;
  overview?: string;
  changes?: Array<{ id?: string; requirementIds: string[]; currentBehavior: string; proposedChanges: string; dependencies?: string[] }>;
  sideEffects?: Array<{ text: string; codeRefs: Array<{ path: string; quote: string }>; verification: string }>;
}
export interface SlackProposal { analysis: SlackAnalysis; plan?: SlackPlan }
export interface SlackFeedbackInput { id: string; text: string; actor: string; previous: SlackProposal }
export interface SlackProposalApprovalInput { proposal: SlackProposal; actor: string; reason: string }
export interface SlackReviewInput { runId: string; revisionId: string; draft: AnalysisDraft; requirementIds: string[]; reason: string; actor: string }
export interface SlackImplementationInput { planId: string; bindingHash: string; actor: string; reason: string }
/** Backend adapters must validate source evidence/project membership and latest revisions under their own execution lock. */
export interface SlackWorkflowBackend {
  save(threadUrl: string): Promise<{ summary: string; documentId?: string; factCount?: number; threadTs?: string }>;
  analyze(threadUrl: string): Promise<SlackAnalysis>;
  inspectAnalysis(runId: string): Promise<SlackAnalysis> | SlackAnalysis;
  reviewAndPlan(input: SlackReviewInput): Promise<SlackPlan>;
  inspectPlan(planId: string): Promise<SlackPlan> | SlackPlan;
  approveAndImplement(input: SlackImplementationInput): Promise<{ runId: string; prUrl?: string | null; summary?: string }>;
  prepareProposal?(threadUrl: string, feedback?: SlackFeedbackInput): Promise<SlackProposal>;
  inspectProposal?(proposal: SlackProposal): Promise<SlackProposal> | SlackProposal;
  approveProposal?(input: SlackProposalApprovalInput): Promise<{ runId: string; prUrl?: string | null; summary?: string }>;
}
export interface SlackReply { text: string; blocks?: Record<string, unknown>[]; modal?: Record<string, unknown>; jobId?: string }
export interface SlackReviewSubmission extends SlackIdentity {
  privateMetadata: string; selectedRequirementIds: string[]; answers: Record<string, string>; reason: string;
}
export interface SlackFeedbackSubmission extends SlackIdentity { privateMetadata: string; text: string; envelopeId: string }
const plain = (text: string) => ({ type: 'plain_text', text, emoji: false });
const section = (text: string) => ({ type: 'section', text: plain(text) });
const compact = (value: string, limit = 2500) => value.length > limit ? `${value.slice(0, limit - 20)}… (상세 검토에서 확인)` : value;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reasonForImplementation = 'Slack에서 표시된 구현 계획과 검증 명령을 검토한 뒤 구현 및 Draft PR 생성을 승인함. 병합 및 배포는 승인하지 않음.';
const reasonForProposal = 'Slack에 표시된 요구사항 전체(제외 항목 제외), 완료 조건·근거, 구현 계획·사이드 이펙트·검증 명령을 확인하고 예를 선택해 요구사항 확정과 코드 수정·테스트·Draft PR 생성을 함께 승인함. 병합 및 배포는 승인하지 않음.';
const planDetails = (plan: SlackPlan) => `${plan.summary}\n저장소: ${plan.repository}\n기준 커밋: ${plan.baseCommit}\n변경 파일:\n${plan.affectedPaths.join('\n')}\n검증:\n${plan.checks.join('\n')}${plan.blockers.length ? `\n차단 사항:\n${plan.blockers.join('\n')}` : ''}`;
const isProposal = (value: unknown): value is SlackProposal => !!value && typeof value === 'object' && 'analysis' in value;
const eligibleRequirements = (proposal: SlackProposal) => proposal.analysis.draft.requirements.filter(requirement => !['rejected', 'superseded'].includes(requirement.decisionState));
const proposalLimit = 35_000;
const evidenceLimit = 95 * 2900;
const sections = (text: string): Record<string, unknown>[] => {
  const blocks: Record<string, unknown>[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2900, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    blocks.push(section(text.slice(start, end))); start = end;
  }
  return blocks;
};
const proposalEvidence = ({ analysis, plan }: SlackProposal): string => {
  const refs = (values: AnalysisDraft['requirements'][number]['sourceRefs']) => values.map(ref =>
    `원문 ${ref.messageVersionId}: “${ref.quote}”${analysis.evidence?.[ref.messageVersionId] ? `\n${analysis.evidence[ref.messageVersionId]!.permalink}` : ''}`).join('\n') || '(직접 인용 없음)';
  const lines = [`제목: ${requirementsTitle(analysis.draft.title ?? analysis.draft.summary)}`, '', '요약', analysis.draft.summary, '', '기능 구현'];
  for (const requirement of analysis.draft.requirements) {
    lines.push(`${requirement.id} · ${requirement.decisionState}${['rejected', 'superseded'].includes(requirement.decisionState) ? ' · 이번 승인에서 제외' : ''}`,
      requirement.statement, `대체하는 요구사항: ${requirement.supersedesIds.join(', ') || '(없음)'}`,
      `차단 질문: ${requirement.blockingQuestionIds.join(', ') || '(없음)'}`, '완료 조건');
    if (!requirement.acceptanceCriteria.length) lines.push('(완료 조건 미기록)');
    for (const criterion of requirement.acceptanceCriteria) lines.push(`${criterion.id} · ${criterion.origin === 'derived' ? '추론한 제안 조건' : '원문 조건'}: ${criterion.text}`, refs(criterion.sourceRefs));
    lines.push('요구사항 근거', refs(requirement.sourceRefs), '');
  }
  lines.push('현재 코드 기준 사이드 이펙트');
  if (!plan?.sideEffects?.length) lines.push('사이드 이펙트 근거가 아직 기록되지 않았습니다. 영향이 없다는 의미는 아닙니다.');
  for (const effect of plan?.sideEffects ?? []) {
    lines.push(effect.text, ...effect.codeRefs.map(ref => `코드 근거 ${ref.path}: “${ref.quote}”`), `확인 방법: ${effect.verification}`, '');
  }
  lines.push('', '구현 계획·파일·검증');
  if (plan) {
    lines.push(planDetails(plan));
    for (const change of plan.changes ?? []) lines.push('', `${change.id ?? '변경'} · ${change.requirementIds.join(', ')}`,
      `현재: ${change.currentBehavior}`, `변경: ${change.proposedChanges}`, `선행 작업: ${change.dependencies?.join(', ') || '(없음)'}`);
    lines.push(`계획: ${plan.planId}\n계획 원본: ${plan.sourceRunId} / ${plan.revisionId}\n계획 바인딩: ${plan.bindingHash}`);
  }
  else lines.push('구현 계획이 없습니다. 아래 질문을 확인하고 수정 요청으로 답변을 남겨 주세요.');
  if (analysis.draft.questions.length) {
    lines.push('', '확인이 필요한 질문');
    for (const question of analysis.draft.questions) lines.push(`${question.id} · ${question.blocking ? '구현 전 답변 필요' : '참고 질문'}\n${question.text}`,
      `관련 요구사항: ${question.affectedRequirementIds.join(', ') || '(없음)'}`, refs(question.sourceRefs));
  }
  lines.push('', `분석: ${analysis.runId}\n분석 버전: ${analysis.revisionId}\n원문 스냅샷: ${analysis.snapshotId}`,
    '예를 선택하면 위 요구사항과 구현 계획을 함께 승인하고 코드 수정·테스트·Draft PR 생성을 실행합니다. 병합·배포는 포함하지 않습니다.',
    '아니요를 선택하면 이전 승인 버튼을 무효화하고 수정 의견을 입력합니다. 의견을 제출하면 새 제안을 만든 뒤 다시 승인을 받습니다.');
  return lines.join('\n');
};
/** The message lists the complete requested scope; the modal retains the full plan and acceptance criteria. */
const proposalDetails = (proposal: SlackProposal, configuredCheckIds?: string[]): string => {
  const { analysis, plan } = proposal;
  const eligible = eligibleRequirements(proposal);
  const excluded = analysis.draft.requirements.filter(requirement => ['rejected', 'superseded'].includes(requirement.decisionState));
  const lines = [requirementsTitle(analysis.draft.title ?? analysis.draft.summary), '', '요약', analysis.draft.summary, '', '기능 구현'];
  eligible.forEach((requirement, index) => lines.push(`${index + 1}. ${requirement.statement}`));
  if (!eligible.length) lines.push('구현할 요구사항이 아직 정해지지 않았습니다.');
  if (excluded.length) lines.push('', '이번 구현에서 제외', ...excluded.map(requirement => `• ${requirement.statement}`));
  lines.push('', '현재 코드 기준 사이드 이펙트');
  if (!plan?.sideEffects?.length) lines.push('코드 근거를 갖춘 영향 분석이 아직 없습니다. 영향이 없다는 의미는 아닙니다.');
  for (const effect of plan?.sideEffects ?? []) lines.push(`• ${effect.text}`, `  근거: ${[...new Set(effect.codeRefs.map(ref => ref.path))].join(', ')}`);
  if (plan) {
    // Production uses configured command IDs; legacy test adapters can supply bare IDs in checks.
    const checkIds = configuredCheckIds ?? plan.checks.filter(check => /^[A-Za-z0-9_.-]+$/.test(check));
    lines.push('', '변경 파일', ...plan.affectedPaths.map(path => `• ${path}`), `검증: ${[...new Set(checkIds)].join(' · ') || '상세 구현 계획에서 확인'}`);
    if (plan.blockers.length) lines.push('', '차단 사항', ...plan.blockers.map(blocker => `• ${blocker}`));
  } else lines.push('', '구현 계획이 없습니다. 질문에 대한 답변이나 수정 의견을 남겨 주세요.');
  if (analysis.draft.questions.length) {
    lines.push('', '확인이 필요한 질문');
    analysis.draft.questions.forEach((question, index) => lines.push(`${index + 1}. ${question.text}${question.blocking ? ' (답변 필요)' : ' (참고)'}`));
  }
  lines.push('', '상세 구현 계획과 완료 조건을 확인한 뒤 승인해 주세요.',
    '승인하면 코드 수정·테스트 후 Draft PR을 만듭니다. 병합·배포는 포함하지 않습니다.');
  return lines.join('\n');
};
const proposalBlocker = (proposal: SlackProposal, configuredCheckIds?: string[]): string | undefined => {
  if (!proposal.plan) return '구현 계획을 먼저 완성해야 합니다.';
  if (!eligibleRequirements(proposal).length) return '승인할 요구사항이 없습니다.';
  if (proposal.plan.blockers.length || proposal.analysis.draft.questions.some(question => question.blocking) ||
    eligibleRequirements(proposal).some(requirement => requirement.blockingQuestionIds.length)) return '차단 질문·사항에 대한 답변이 필요합니다. 아니요 · 수정 요청 버튼이나 feedback 명령으로 알려 주세요.';
  if (proposalDetails(proposal, configuredCheckIds).length > proposalLimit || proposalEvidence(proposal).length > evidenceLimit) return '제안 또는 상세 근거 전체가 Slack 표시 한도를 넘었습니다. 범위를 줄이거나 로컬 보고서에서 검토하세요.';
  return undefined;
};

/** Transport-independent commands and approvals. All execution is performed by the durable worker. */
export class SlackService {
  private readonly policy: SlackAppPolicy;
  private readonly scopeHash: string;
  constructor(private readonly config: ProjectConfig & { slackApp?: SlackAppPolicy }, private readonly store: SlackJobStore,
    private readonly backend: SlackWorkflowBackend) {
    if (!config.slackApp) throw new Error('slackApp configuration is required.');
    if (config.projectId !== store.projectId) throw new Error('Slack queue project does not match configuration.');
    this.policy = config.slackApp; this.scopeHash = hash(config);
  }
  private authorize(identity: SlackIdentity, channelId?: string, approver = false): void {
    if (identity.teamId !== this.policy.teamId || identity.appId !== this.policy.appId ||
      !this.policy.allowedUserIds.includes(identity.userId) ||
      (approver && !this.policy.approverUserIds.includes(identity.userId)) ||
      (channelId !== undefined && !this.config.slack.channelIds.includes(channelId))) {
      throw new Error('This Slack workspace, app, channel or user is not authorized.');
    }
  }
  private authorizeJob(identity: SlackIdentity, job: SlackJob, channelId?: string, approver = false): void {
    this.authorize(identity, channelId ?? job.channelId, approver);
    if (job.scopeHash !== this.scopeHash || job.teamId !== identity.teamId || job.appId !== identity.appId ||
      (channelId !== undefined && channelId !== job.channelId)) throw new Error('This action belongs to another channel or an outdated configuration.');
  }
  /** Only send follow-up errors to a configured app/team/channel/user, never an untrusted payload target. */
  canReplyTo(identity: SlackIdentity, channelId: string): boolean {
    try { this.authorize(identity, channelId); return true; } catch { return false; }
  }
  handleCommand(request: SlackCommandRequest): SlackReply {
    this.authorize(request, request.channelId);
    if (request.command !== this.policy.command) throw new Error('Unexpected Slack command.');
    const [command, argument, extra] = request.text.trim().split(/\s+/);
    if (!command || command === 'help') return { text: `${this.policy.command} save <스레드 링크> — 도메인 지식 저장\n${this.policy.command} analyze <스레드 링크> — 일반 스레드 대화 분석 → 요구사항·계획 확인 → 승인 → PR\n${this.policy.command} feedback <작업 ID> <수정 의견> — 제안 수정 요청\n${this.policy.command} status <작업 ID> — 상태/승인 버튼 다시 보기\n명령은 대상 스레드와 같은 채널의 기본 입력창에서 실행하세요. 배포는 PR 병합과 대상 저장소의 배포 설정이 필요합니다.` };
    if (command === 'status') {
      if (!argument || extra || !uuid.test(argument)) throw new Error('status requires one valid job ID.');
      const job = this.store.get(argument); this.authorizeJob(request, job, request.channelId);
      return this.renderJob(job, this.store.pendingAction(job.id));
    }
    if (command === 'feedback') {
      if (!argument || !uuid.test(argument)) throw new Error('feedback requires a valid job ID and feedback text.');
      this.validateEnvelope(request.envelopeId);
      const text = request.text.trim().replace(/^feedback\s+\S+\s*/, '').trim();
      this.validateFeedback(text);
      const job = this.store.get(argument); this.authorizeJob(request, job, request.channelId, true);
      const id = `command:${hash(request.envelopeId)}`;
      if (this.reusedFeedback(id, job, request.userId, text)) return this.feedbackReply(job, true);
      const action = this.store.pendingAction(job.id);
      if (!action || !['proposal', 'feedback'].includes(action.kind) || !isProposal(job.result)) throw new Error('This job has no current proposal accepting feedback.');
      const input: SlackFeedbackInput = { id, text, actor: request.userId, previous: job.result };
      const queued = this.store.queueFeedback(action.nonce, hash(job.result), id, input);
      return this.feedbackReply(queued.job, queued.reused);
    }
    if (!['save', 'analyze'].includes(command) || !argument || extra) throw new Error(`Use ${this.policy.command} save|analyze <thread URL> or status <job ID>.`);
    this.validateEnvelope(request.envelopeId);
    // Slack may wrap command URL arguments in <url|label> when escaping is enabled.
    const threadUrl = argument.startsWith('<') && argument.endsWith('>') ? argument.slice(1, -1).split('|')[0]! : argument;
    const thread = parseThreadUrl(threadUrl, this.config.slack);
    if (thread.channelId !== request.channelId) throw new Error('Run this command in the same channel as the target thread.');
    const { job, reused } = this.store.enqueue({ scopeHash: this.scopeHash, envelopeId: request.envelopeId,
      teamId: request.teamId, appId: request.appId, channelId: request.channelId, userId: request.userId,
      threadUrl, threadTs: thread.rootTs, kind: command as 'save' | 'analyze' });
    return { jobId: job.id, text: `${reused ? '이미 접수한' : '접수한'} 작업: ${job.id}\n상태: ${job.status}\n결과는 원래 스레드에 남깁니다. ${this.policy.command} status ${job.id}` };
  }
  private validateEnvelope(id: string): void {
    if (!id.trim() || id.length > 512) throw new Error('A stable Slack event identity is required.');
  }
  private validateFeedback(text: string): void {
    if (!text.trim() || text.length > 3000) throw new Error('Feedback must contain 1–3000 characters.');
  }
  private reusedFeedback(id: string, job: SlackJob, actor: string, text: string): boolean {
    const existing = this.store.feedbackRequest(id);
    if (!existing) return false;
    const input = existing.input as SlackFeedbackInput;
    if (existing.jobId !== job.id || input.actor !== actor || input.text !== text) throw new Error('Feedback event identity does not match the original request.');
    return true;
  }
  private feedbackReply(job: SlackJob, reused = false): SlackReply {
    return { text: `${reused ? '이미 접수한' : '접수한'} 수정 요청: ${job.id}\n이전 승인 버튼은 무효입니다. 의견과 원문을 다시 분석한 새 제안을 확인한 뒤 승인해 주세요.`, jobId: job.id };
  }
  private checkedAction(identity: SlackIdentity, nonce: string, kind: SlackAction['kind'], channelId?: string): { action: SlackAction; job: SlackJob } {
    this.authorize(identity, channelId, true);
    if (!uuid.test(nonce)) throw new Error('Invalid approval action.');
    const action = this.store.action(nonce), job = this.store.get(action.jobId);
    this.authorizeJob(identity, job, channelId, true);
    const expected = kind === 'review' ? 'awaiting_review' : kind === 'feedback' ? 'awaiting_feedback' : 'awaiting_approval';
    if (action.kind !== kind || action.consumedAt || job.status !== expected) throw new Error('Approval is stale or has already been used.');
    return { action, job };
  }
  async handleAction(request: SlackActionRequest): Promise<SlackReply> {
    if (request.actionId === 'sd_proposal_details') {
      const { action, job } = this.checkedAction(request, request.value, 'proposal', request.channelId);
      if (!isProposal(job.result) || !this.backend.inspectProposal) throw new Error('Proposal workflow is unavailable.');
      const proposal = await this.backend.inspectProposal(job.result);
      if (hash(proposal) !== action.binding) throw new Error('Proposal changed. Run analyze again before reviewing the evidence.');
      const body = proposalEvidence(proposal);
      if (body.length > evidenceLimit) throw new Error('상세 근거 전체가 Slack 표시 한도를 넘었습니다. 로컬 보고서를 확인하세요.');
      return { text: '원문과 코드 근거를 확인하세요. 승인 상태는 변경되지 않습니다.', jobId: job.id,
        modal: { type: 'modal', callback_id: 'sd_proposal_details', private_metadata: action.nonce,
          title: plain('구현 계획·근거 보기'), close: plain('닫기'), blocks: sections(body) } };
    }
    if (['sd_proposal_yes', 'sd_proposal_no', 'sd_feedback_open'].includes(request.actionId)) {
      const { action, job } = this.checkedAction(request, request.value, request.actionId === 'sd_feedback_open' ? 'feedback' : 'proposal', request.channelId);
      if (!isProposal(job.result) || !this.backend.inspectProposal) throw new Error('Proposal workflow is unavailable.');
      const proposal = await this.backend.inspectProposal(job.result);
      if (hash(proposal) !== action.binding) throw new Error('Proposal changed. Run analyze again before approving or giving feedback.');
      if (request.actionId !== 'sd_proposal_yes') {
        const feedbackAction = request.actionId === 'sd_proposal_no' ? this.store.beginFeedback(action.nonce, action.binding) : action;
        return { text: '수정 의견을 입력해 주세요. 이전 승인 버튼은 무효입니다. 의견을 제출하면 새 제안을 만듭니다.', jobId: job.id, modal: this.feedbackModal(feedbackAction.nonce, job.id) };
      }
      const blocker = proposalBlocker(proposal, this.config.development?.commands.map(command => command.id));
      if (blocker) throw new Error(blocker);
      if (!this.backend.approveProposal) throw new Error('Proposal approval is unavailable.');
      const input: SlackProposalApprovalInput = { proposal, actor: request.userId, reason: reasonForProposal };
      this.store.queueAction(action.nonce, action.binding, input);
      return { text: `요구사항과 구현 계획을 함께 승인했습니다. 작업 ${job.id}\n코드 수정·테스트를 거쳐 Draft PR 링크를 이 스레드에 남깁니다.`, jobId: job.id };
    }
    if (request.actionId === 'sd_review') {
      const { action, job } = this.checkedAction(request, request.value, 'review', request.channelId);
      const source = job.result as SlackAnalysis;
      const latest = await this.backend.inspectAnalysis(source.runId);
      if (hash(latest) !== action.binding) throw new Error('Analysis changed. Run analyze again before reviewing.');
      return { text: '요구사항과 미해결 질문을 검토하세요.', jobId: job.id, modal: this.reviewModal(action.nonce, latest) };
    }
    if (request.actionId !== 'sd_implement') throw new Error('Unknown Slack action.');
    const { action, job } = this.checkedAction(request, request.value, 'implement', request.channelId);
    const plan = await this.backend.inspectPlan((job.result as SlackPlan).planId);
    if (hash(plan) !== action.binding) throw new Error('Plan changed. Generate and approve a new plan.');
    if (plan.blockers.length) throw new Error('Resolve the plan blockers before implementation.');
    if (planDetails(plan).length > 44 * 2900) throw new Error('This plan cannot be fully displayed in Slack. Review and approve it with the local CLI.');
    const input: SlackImplementationInput = { planId: plan.planId, bindingHash: plan.bindingHash, actor: request.userId, reason: reasonForImplementation };
    this.store.queueAction(action.nonce, action.binding, input);
    return { text: `구현 및 Draft PR 생성 승인을 기록했습니다. 작업 ${job.id}\n테스트 통과 후 PR 링크를 이 스레드에 남깁니다. 병합·배포는 실행하지 않습니다.`, jobId: job.id };
  }
  private feedbackModal(nonce: string, jobId: string): Record<string, unknown> {
    return { type: 'modal', callback_id: 'sd_feedback_submit', private_metadata: nonce,
      title: plain('제안 수정 요청'), submit: plain('피드백 제출'), close: plain('나중에'), blocks: [
        section(`작업 ${jobId}\n바꿀 내용, 제외할 기능 또는 차단 질문의 답변을 적어 주세요. 제출 후 새 제안을 만듭니다. 새 제안을 다시 승인해야 구현을 시작합니다.`),
        { type: 'input', block_id: 'feedback_text', label: plain('수정 의견'), element: { type: 'plain_text_input', action_id: 'value', multiline: true, min_length: 1, max_length: 3000 } },
      ] };
  }
  async handleFeedbackSubmission(request: SlackFeedbackSubmission): Promise<SlackReply> {
    this.authorize(request, undefined, true);
    if (!uuid.test(request.privateMetadata)) throw new Error('Invalid feedback action.');
    this.validateEnvelope(request.envelopeId);
    const text = request.text.trim(); this.validateFeedback(text);
    const originalAction = this.store.action(request.privateMetadata), originalJob = this.store.get(originalAction.jobId);
    this.authorizeJob(request, originalJob, undefined, true);
    const id = `view:${hash(request.envelopeId)}`;
    if (this.reusedFeedback(id, originalJob, request.userId, text)) return this.feedbackReply(originalJob, true);
    const { action, job } = this.checkedAction(request, request.privateMetadata, 'feedback');
    if (!isProposal(job.result) || !this.backend.inspectProposal) throw new Error('Proposal workflow is unavailable.');
    const previous = await this.backend.inspectProposal(job.result);
    if (hash(previous) !== action.binding) throw new Error('Proposal changed. Run analyze again before giving feedback.');
    const input: SlackFeedbackInput = { id, text, actor: request.userId, previous };
    const queued = this.store.queueFeedback(action.nonce, action.binding, id, input);
    return this.feedbackReply(queued.job, queued.reused);
  }
  private reviewModal(nonce: string, analysis: SlackAnalysis): Record<string, unknown> {
    const eligible = analysis.draft.requirements.filter(requirement => !['rejected', 'superseded'].includes(requirement.decisionState));
    if (!eligible.length || eligible.length > 100) throw new Error('This analysis must be reviewed with the local CLI (no eligible requirements or too many requirements).');
    const blocks: Record<string, unknown>[] = [section('구현할 요구사항을 직접 선택하고, 해당 요구사항의 차단 질문에 답하세요. 제출하면 선택 항목을 확정하고 계획을 생성합니다. 아직 코드 실행 승인은 아닙니다.')];
    for (const requirement of eligible) {
      const detail = `${requirement.id}\n${requirement.statement}\n완료 조건:\n${requirement.acceptanceCriteria.map(criterion => `• ${criterion.id}: ${criterion.text}`).join('\n') || '(없음)'}\n근거:\n${requirement.sourceRefs.map(ref => `“${ref.quote}”`).join('\n')}`;
      for (let offset = 0; offset < detail.length; offset += 2900) blocks.push(section(detail.slice(offset, offset + 2900)));
    }
    blocks.push({ type: 'input', block_id: 'req_selection', label: plain('구현할 요구사항'), element: {
      type: 'multi_static_select', action_id: 'value', placeholder: plain('직접 선택하세요'), options: eligible.map(requirement => ({ text: plain(compact(requirement.id, 75)), value: requirement.id })),
    } });
    analysis.draft.questions.forEach((question, index) => {
      if (!question.blocking) return;
      for (let offset = 0; offset < question.text.length; offset += 2800) blocks.push(section(`${offset === 0 ? `${question.id}\n` : ''}${question.text.slice(offset, offset + 2800)}`));
      blocks.push({ type: 'input', block_id: `q_${index}`, optional: true, label: plain(compact(`답변: ${question.id}`, 200)),
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 3000, placeholder: plain('선택한 요구사항에 영향을 주는 질문은 반드시 답하세요.') } });
    });
    blocks.push({ type: 'input', block_id: 'review_reason', label: plain('검토 사유'), element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 1000 } });
    if (blocks.length > 100) throw new Error('This analysis exceeds Slack modal limits. Review with the local CLI or use a smaller thread.');
    return { type: 'modal', callback_id: 'sd_review_submit', private_metadata: nonce, title: plain('요구사항 검토'), submit: plain('확정 및 계획 생성'), close: plain('취소'), blocks };
  }
  /** Convert Bolt view.state.values without trusting caller-supplied requirement/question definitions. */
  parseReviewValues(nonce: string, values: Record<string, Record<string, { value?: string | null; selected_options?: Array<{ value: string }> }>>): Pick<SlackReviewSubmission, 'selectedRequirementIds' | 'answers' | 'reason'> {
    const action = this.store.action(nonce), analysis = this.store.get(action.jobId).result as SlackAnalysis;
    if (action.kind !== 'review') throw new Error('Unexpected review action.');
    return { selectedRequirementIds: values.req_selection?.value?.selected_options?.map(option => option.value) ?? [],
      reason: values.review_reason?.value?.value ?? '',
      answers: Object.fromEntries(analysis.draft.questions.flatMap((question, index) => {
        const answer = values[`q_${index}`]?.value?.value;
        return answer?.trim() ? [[question.id, answer.trim()]] : [];
      })) };
  }
  async handleReviewSubmission(request: SlackReviewSubmission): Promise<SlackReply> {
    const { action, job } = this.checkedAction(request, request.privateMetadata, 'review');
    const source = job.result as SlackAnalysis, latest = await this.backend.inspectAnalysis(source.runId);
    if (hash(latest) !== action.binding) throw new Error('Analysis changed. Run analyze again before reviewing.');
    const selected = new Set(request.selectedRequirementIds);
    if (!selected.size || selected.size !== request.selectedRequirementIds.length || [...selected].some(id => !latest.draft.requirements.some(requirement => requirement.id === id && !['rejected', 'superseded'].includes(requirement.decisionState)))) throw new Error('Select unique eligible requirement IDs.');
    if (!request.reason.trim() || request.reason.length > 1000) throw new Error('A review reason of 1–1000 characters is required.');
    const answered = new Set<string>();
    for (const [id, answer] of Object.entries(request.answers)) {
      if (!latest.draft.questions.some(question => question.id === id && question.blocking) || !answer.trim() || answer.length > 3000) throw new Error('Question answers must refer to existing blocking questions and contain 1–3000 characters.');
      answered.add(id);
    }
    for (const question of latest.draft.questions) {
      if (question.blocking && question.affectedRequirementIds.some(id => selected.has(id)) && !answered.has(question.id)) throw new Error(`Answer the blocking question before planning: ${question.id}`);
    }
    const draft: AnalysisDraft = structuredClone(latest.draft);
    for (const requirement of draft.requirements) {
      if (selected.has(requirement.id)) requirement.decisionState = 'confirmed';
      requirement.blockingQuestionIds = requirement.blockingQuestionIds.filter(id => !answered.has(id));
    }
    for (const question of draft.questions) {
      if (answered.has(question.id)) { question.blocking = false; question.text += `\n사람 검토 답변 (${request.userId}): ${request.answers[question.id]!.trim()}`; }
    }
    const input: SlackReviewInput = { runId: latest.runId, revisionId: latest.revisionId, draft,
      requirementIds: request.selectedRequirementIds, reason: request.reason.trim(), actor: request.userId };
    this.store.queueAction(action.nonce, action.binding, input);
    return { text: `검토를 접수했습니다. 작업 ${job.id}\n선택한 요구사항의 계획을 생성한 뒤 별도 구현 승인을 요청합니다.`, jobId: job.id };
  }
  async processNextJob(): Promise<{ job: SlackJob; message: SlackReply } | undefined> {
    const job = this.store.claimNext();
    if (!job) return undefined;
    try {
      this.authorizeJob(job, job, job.channelId);
      let result: unknown, action: SlackAction | undefined;
      if (job.kind === 'save') {
        const saved = await this.backend.save(job.threadUrl); result = saved;
        if (saved.threadTs) this.store.updateThreadTs(job.id, saved.threadTs);
        this.store.finish(job.id, 'completed', result);
      } else if (job.kind === 'analyze') {
        if (this.backend.prepareProposal) {
          if (!this.backend.inspectProposal || !this.backend.approveProposal) throw new Error('Proposal inspection and approval adapters are required.');
          const proposal = await this.backend.prepareProposal(job.threadUrl); result = proposal;
          if (proposal.analysis.threadTs) this.store.updateThreadTs(job.id, proposal.analysis.threadTs);
          action = this.store.finish(job.id, 'awaiting_approval', result, null, { kind: 'proposal', binding: hash(result) });
        } else {
          const analysis = await this.backend.analyze(job.threadUrl); result = analysis;
          if (analysis.threadTs) this.store.updateThreadTs(job.id, analysis.threadTs);
          action = this.store.finish(job.id, 'awaiting_review', result, null, { kind: 'review', binding: hash(result) });
        }
      } else if (job.kind === 'feedback') {
        const { command: _command, ...input } = job.input as SlackFeedbackInput & { command: string };
        this.authorize({ ...job, userId: input.actor }, job.channelId, true);
        if (!this.backend.prepareProposal || !this.backend.inspectProposal) throw new Error('Proposal feedback is unavailable.');
        const current = await this.backend.inspectProposal(input.previous);
        if (hash(current) !== hash(input.previous) || hash(current) !== hash(job.result)) throw new Error('Proposal changed after feedback submission. Run analyze again.');
        const proposal = await this.backend.prepareProposal(job.threadUrl, input); result = proposal;
        if (proposal.analysis.threadTs) this.store.updateThreadTs(job.id, proposal.analysis.threadTs);
        action = this.store.finish(job.id, 'awaiting_approval', result, null, { kind: 'proposal', binding: hash(result) });
      } else if (job.kind === 'plan') {
        const { command: _command, ...input } = job.input as SlackReviewInput & { command: string };
        this.authorize({ ...job, userId: input.actor }, job.channelId, true);
        const current = await this.backend.inspectAnalysis(input.runId);
        if (current.revisionId !== input.revisionId || hash(current) !== hash(job.result)) throw new Error('Analysis changed after review submission. Run analyze again.');
        result = await this.backend.reviewAndPlan(input);
        action = this.store.finish(job.id, 'awaiting_approval', result, null, { kind: 'implement', binding: hash(result) });
      } else if (isProposal(job.result)) {
        const { command: _command, ...input } = job.input as SlackProposalApprovalInput & { command: string };
        this.authorize({ ...job, userId: input.actor }, job.channelId, true);
        if (!this.backend.inspectProposal || !this.backend.approveProposal) throw new Error('Proposal approval is unavailable.');
        const current = await this.backend.inspectProposal(input.proposal);
        if (hash(current) !== hash(input.proposal) || hash(current) !== hash(job.result)) throw new Error('Proposal changed after approval. Generate and approve a new proposal.');
        const blocker = proposalBlocker(current, this.config.development?.commands.map(command => command.id));
        if (blocker) throw new Error(blocker);
        result = await this.backend.approveProposal(input);
        this.store.finish(job.id, 'completed', result);
      } else {
        const { command: _command, ...input } = job.input as SlackImplementationInput & { command: string };
        this.authorize({ ...job, userId: input.actor }, job.channelId, true);
        const current = await this.backend.inspectPlan(input.planId);
        if (current.bindingHash !== input.bindingHash || hash(current) !== hash(job.result) || current.blockers.length) throw new Error('Plan changed after approval. Generate and approve a new plan.');
        result = await this.backend.approveAndImplement(input);
        this.store.finish(job.id, 'completed', result);
      }
      const completed = this.store.get(job.id);
      return { job: completed, message: this.renderJob(completed, action) };
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Unknown workflow error';
      for (const key of ['SLACK_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY']) {
        if (process.env[key]) message = message.replaceAll(process.env[key]!, '[REDACTED]');
      }
      message = message.replace(/\b(?:xox[a-z]-|xapp-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/https:\/\/hooks\.slack\.com\/\S+/g, '[REDACTED]').slice(0, 2000);
      // Implement may already have created a grant, commit or PR: require deliberate recovery.
      this.store.finish(job.id, ['implement', 'feedback'].includes(job.kind) ? 'needs_resume' : 'failed', job.result, message);
      const failed = this.store.get(job.id); return { job: failed, message: this.renderJob(failed) };
    }
  }
  private renderJob(job: SlackJob, action?: SlackAction): SlackReply {
    const header = `작업 ${job.id} · ${job.kind} · ${job.status}`;
    if (job.status === 'awaiting_feedback') {
      const text = `${header}\n이전 승인 버튼은 무효입니다. 수정 의견을 입력하면 새 제안을 생성합니다.\n${this.policy.command} feedback ${job.id} <수정 의견>`;
      const blocks: Record<string, unknown>[] = [section(text)];
      if (action?.kind === 'feedback') blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'sd_feedback_open', text: plain('수정 의견 입력'), value: action.nonce }] });
      return { text, blocks, jobId: job.id };
    }
    if (job.status === 'awaiting_approval' && isProposal(job.result)) {
      const proposal = job.result, checkIds = this.config.development?.commands.map(command => command.id);
      const body = proposalDetails(proposal, checkIds), blocker = proposalBlocker(proposal, checkIds);
      const tooLarge = body.length > proposalLimit, evidenceTooLarge = proposalEvidence(proposal).length > evidenceLimit;
      const text = `${tooLarge ? '제안 전체가 Slack 표시 한도를 넘었습니다. 승인할 수 없습니다. 수정 요청으로 범위를 줄이거나 로컬 보고서를 확인하세요.' : body}${blocker && !tooLarge ? `\n\n승인 대기 사유: ${blocker}` : ''}\n\n작업: ${job.id}`;
      const blocks = sections(text);
      if (action?.kind === 'proposal') {
        if (!evidenceTooLarge) blocks.push({ ...section('상세 계획 · 완료 조건 · 원문과 코드 근거'),
          accessory: { type: 'button', action_id: 'sd_proposal_details', text: plain('구현 계획·근거 보기'), value: action.nonce } });
        const elements: Record<string, unknown>[] = [];
        if (!blocker) elements.push({ type: 'button', action_id: 'sd_proposal_yes', text: plain('예 · 구현하고 PR 만들기'), style: 'primary', value: action.nonce });
        elements.push({ type: 'button', action_id: 'sd_proposal_no', text: plain('아니요 · 수정 요청'), value: action.nonce });
        blocks.push({ type: 'actions', elements });
      }
      return { text, blocks, jobId: job.id };
    }
    if (job.status === 'awaiting_review') {
      const analysis = job.result as SlackAnalysis;
      const text = `${header}\n${compact(analysis.draft.summary, 1800)}\n요구사항 ${analysis.draft.requirements.length}개 · 차단 질문 ${analysis.draft.questions.filter(question => question.blocking).length}개`;
      const blocks: Record<string, unknown>[] = [section(text)];
      if (action) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'sd_review', text: plain('검토 / 계획 생성'), value: action.nonce }] });
      return { text, blocks, jobId: job.id };
    }
    if (job.status === 'awaiting_approval') {
      const plan = job.result as SlackPlan;
      const body = planDetails(plan);
      const blocks: Record<string, unknown>[] = [section(header)];
      for (let offset = 0; offset < body.length; offset += 2900) blocks.push(section(body.slice(offset, offset + 2900)));
      // Never approve a truncated plan. Large plans remain available in the local report.
      if (blocks.length > 45) return { text: `${header}\n계획이 Slack 표시 한도를 넘었습니다. 로컬 계획 보고서에서 검토하세요.`, jobId: job.id };
      if (action && !plan.blockers.length) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'sd_implement', text: plain('구현 및 PR 승인'), style: 'primary', value: action.nonce,
        confirm: { title: plain('구현 및 PR 생성 승인'), text: plain('위 계획대로 코드 수정·테스트·Draft PR 생성을 실행합니다. 병합·배포는 포함하지 않습니다.'), confirm: plain('승인'), deny: plain('취소') } }] });
      return { text: `${header}\n${compact(plan.summary)}`, blocks, jobId: job.id };
    }
    if (job.status === 'completed') {
      const result = job.result as { summary?: string; factCount?: number; prUrl?: string; runId?: string };
      const text = `${header}${result.summary ? `\n${compact(result.summary)}` : ''}${result.factCount !== undefined ? `\n저장한 지식: ${result.factCount}건` : ''}${result.prUrl ? `\nPR: ${result.prUrl}` : ''}${result.runId ? `\n실행: ${result.runId}` : ''}`;
      return { text, blocks: [section(text)], jobId: job.id };
    }
    return { text: `${header}${job.error ? `\n${job.error}` : ''}${job.status === 'needs_resume' ? '\n자동 재실행하지 않습니다. 로컬 실행 기록을 확인한 후 명시적으로 재개하세요.' : ''}`, jobId: job.id };
  }
}
