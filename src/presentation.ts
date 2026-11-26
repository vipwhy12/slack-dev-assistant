import type { AnalysisDraft } from './analysis.js';
import type { ThreadSnapshot } from './domain.js';
import type { PlanDraft } from './planning.js';
import type { VerificationResult } from './runner.js';
import { containsCredential } from './generation.js';

export interface ReportCheckpoint {
  baseline?: VerificationResult[];
  changes?: { summary: string };
  applied?: boolean;
  verification?: VerificationResult[];
  commitSha?: string;
  prUrl?: string;
}
export interface ImplementationPresentation {
  plan: PlanDraft;
  checkpoint: ReportCheckpoint;
  runId: string;
  source: AnalysisDraft;
  snapshot: ThreadSnapshot;
}
type TextFormatter = (value: string) => string;

function cleanText(value: string): string {
  const result = value.replace(/https?:\/\/[^\s<>]*\.slack\.com\/[^\s<>]*/gi, '[Slack 링크 생략]');
  if (containsCredential(result)) return '[민감정보를 포함해 본문 생략]';
  // Fullwidth @ preserves a readable name without notifying GitHub or Slack users.
  return result.replace(/@/g, '＠').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
}
export function markdownText(value: string): string {
  return cleanText(value).replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&').replace(/\n+/g, ' ').trim();
}
export function requirementsTitle(summary: string): string {
  const line = cleanText(summary).split('\n')[0]?.trim() || '개발 변경';
  const short = line.length > 64 ? `${line.slice(0, 63)}…` : line;
  return `[${short.replace(/[\[\]]/g, '').replace(/요구사항\s*$/, '').trim()} 요구사항]`;
}
export function renderSideEffects(plan: PlanDraft, text: TextFormatter = markdownText): string[] {
  const lines = ['## 사이드 이펙트', ''];
  if (!plan.sideEffects?.length) return [...lines, '이 계획에는 코드 근거를 갖춘 영향 분석이 기록되지 않았습니다. 변경 후 영향을 별도로 확인해야 합니다.', ''];
  for (const effect of plan.sideEffects) {
    lines.push(`- ${text(effect.text)}`, '', ...effect.codeRefs.map(ref => `  - 코드 근거: ${text(ref.path)} / ${text(ref.quote)}`),
      `  - 확인 방법: ${text(effect.verification)}`, '');
  }
  return [...lines, '위 내용은 제공된 코드에서 추론한 영향이며, 실행으로 확인한 결과는 아닙니다. 검증 기록을 별도로 확인해야 합니다.', ''];
}
function featureLines(plan: PlanDraft, text: TextFormatter): string[] {
  const lines = ['## 기능 구현', ''];
  for (const item of plan.items) {
    lines.push(`### ${item.requirementIds.map(value => text(value)).join(', ')}`, '', text(item.proposedChanges), '',
      `기존 동작: ${text(item.currentBehavior)}`, '', `변경 대상: ${item.affectedPaths.map(value => text(value)).join(', ')}`, '');
    if (item.blockers.length) lines.push(`차단 사항: ${item.blockers.map(value => text(value)).join('; ')}`, '');
  }
  return lines;
}
const statusText: Record<VerificationResult['status'], string> = { passed: '통과', failed: '실패', not_run: '미실행', blocked: '실행 차단' };
function verificationLines(plan: PlanDraft, checkpoint: ReportCheckpoint, text: TextFormatter): string[] {
  const lines = ['## 실제 검증 결과', '', '| 단계 | 명령 | 결과 | 종료 코드 |', '| --- | --- | --- | --- |'];
  for (const [phase, results] of [['변경 전', checkpoint.baseline], ['변경 후', checkpoint.verification]] as const) {
    if (!results?.length) lines.push(`| ${phase} | 기록 없음 | 미실행 | 해당 없음 |`);
    for (const result of results ?? []) lines.push(`| ${phase} | ${text(result.commandId)} | ${statusText[result.status]} | ${result.exitCode ?? '해당 없음'} |`);
  }
  lines.push('', '수용 기준별 확인:', '');
  for (const item of plan.items) for (const check of item.acceptanceChecks) {
    const result = checkpoint.verification?.find(value => value.commandId === check.commandId);
    const state = check.commandId === null ? '미실행 (수동 확인 필요)' : result ? `${statusText[result.status]} (${text(check.commandId)})` : '미실행';
    lines.push(`- ${text(check.criterionId)}: ${state}. ${text(check.testName)}`);
  }
  lines.push('', '명령 통과 여부를 기록했습니다. 요구사항의 의미와 수동 확인 항목은 사람이 검토해야 합니다.', '');
  return lines;
}
function documentLines(input: ImplementationPresentation, text: TextFormatter, title: string): string[] {
  const { plan, checkpoint } = input;
  const summary = checkpoint.applied && checkpoint.changes ? checkpoint.changes.summary : plan.summary;
  return [`# ${text(title)}`, '', '## 요약', '', text(summary), '',
    checkpoint.commitSha ? '별도 브랜치에 변경을 커밋했습니다. 검토 후 병합할 수 있습니다.' : checkpoint.applied ? '파일 변경을 적용했습니다. 커밋과 게시 상태는 실행 기록을 확인하세요.' : '계획한 변경입니다. 아직 파일 변경을 완료하지 않았습니다.', '',
    ...featureLines(plan, text), ...renderSideEffects(plan, text), ...verificationLines(plan, checkpoint, text)];
}
export function renderImplementationReport(input: ImplementationPresentation): string {
  const { checkpoint, plan, source, snapshot, runId } = input;
  const lines = documentLines(input, markdownText, requirementsTitle(plan.title ?? plan.summary));
  lines.push('## 원문 근거', '');
  for (const item of plan.items) for (const id of item.requirementIds) {
    const requirement = source.requirements.find(value => value.id === id);
    for (const ref of requirement?.sourceRefs ?? []) {
      const message = snapshot.messages.find(value => value.id === ref.messageVersionId);
      if (!message) throw new Error('Missing source in implementation report.');
      const url = new URL(message.permalink);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com')) throw new Error('Invalid source link in implementation report.');
      lines.push(`- ${markdownText(id)}: [Slack 원문](<${url.href.replace(/[<>]/g, character => encodeURIComponent(character))}>)`);
    }
  }
  lines.push('', '## 실행 기록', '', `실행: ${markdownText(runId)}`, '', `커밋: ${markdownText(checkpoint.commitSha ?? '생성 전')}`, '', `PR: ${markdownText(checkpoint.prUrl ?? '게시 전')}`, '');
  return lines.join('\n');
}
export function renderPullRequestTitle(input: ImplementationPresentation): string {
  return requirementsTitle(input.plan.title ?? input.plan.summary);
}
export function renderPullRequestBody(input: ImplementationPresentation & { planId: string }): string {
  // Publish the approved functional narrative, even when it matches source wording.
  // Raw Slack message bodies, quote blocks and internal evidence links are never appended here.
  const lines = documentLines(input, markdownText, renderPullRequestTitle(input));
  lines.push('## 검토 정보', '', `계획: ${markdownText(input.planId)}`, '',
    'Slack 원문과 내부 링크는 로컬 실행 보고서에서 확인할 수 있습니다. 이 PR은 검토용 초안입니다.', '',
    `slack-dev-run: ${input.runId}`, '');
  return lines.join('\n');
}
