import { describe, expect, it } from 'vitest';
import type { AnalysisDraft } from '../src/analysis.js';
import type { ThreadSnapshot } from '../src/domain.js';
import type { PlanDraft } from '../src/planning.js';
import { markdownText, renderImplementationReport, renderPullRequestBody, renderPullRequestTitle, renderSideEffects, type ImplementationPresentation } from '../src/presentation.js';

const secretMessage = '비공개 고객의 결제 내역을 숨겨 주세요.';
const source: AnalysisDraft = { summary: '달력 선택 상태 수정', requirements: [{ id: 'REQ-CALENDAR', statement: '선택한 날짜를 표시한다.',
  decisionState: 'confirmed', sourceRefs: [{ messageVersionId: 'M1', quote: '결제 내역을 숨겨 주세요.' }], supersedesIds: [], blockingQuestionIds: [],
  acceptanceCriteria: [{ id: 'AC-SELECTED', text: '선택한 날짜에 표시가 남는다.', origin: 'derived', sourceRefs: [] },
    { id: 'AC-MOBILE', text: '작은 화면에서도 날짜를 확인할 수 있다.', origin: 'derived', sourceRefs: [] }] }], questions: [] };
const snapshot: ThreadSnapshot = { id: 'S1', workspace: 'private', channelId: 'C123', rootTs: '1795046400.000001', collectedAt: '2026-11-26T00:00:00.000Z',
  status: 'complete', warnings: [], contentHash: 'snapshot', messages: [{ id: 'M1', ts: '1795046400.000001', text: secretMessage, author: 'U123',
    editedTs: null, permalink: 'https://private.slack.com/archives/C123/p1795046400000001', hasAttachments: false }] };
const plan: PlanDraft = { summary: '달력의 선택한 날짜 표시', items: [{ id: 'P1', requirementIds: ['REQ-CALENDAR'], currentBehavior: '버튼에 선택 상태가 없다.',
  proposedChanges: '선택한 날짜 버튼에 aria-pressed를 설정한다.', codeRefs: [{ path: 'src/Calendar.tsx', quote: '<button>' }],
  affectedPaths: ['src/Calendar.tsx', 'test/calendar.test.ts'], dependencies: [], blockers: [], acceptanceChecks: [
    { criterionId: 'AC-SELECTED', commandId: 'unit', testName: '날짜 선택 후 aria-pressed 확인' }, { criterionId: 'AC-MOBILE', commandId: null, testName: '좁은 화면의 날짜 표시 확인' }] }],
  excludedRequirements: [], sideEffects: [{ text: '같은 버튼을 사용하는 날짜 탐색에도 선택 스타일이 적용될 수 있다.',
    codeRefs: [{ path: 'src/Calendar.tsx', quote: '<button>' }], verification: '날짜 이동 후 이전 선택 표시가 지워지는지 확인한다.' }] };
function input(): ImplementationPresentation {
  const passed = { commandId: 'unit', program: 'node', args: ['--test'], status: 'passed' as const, exitCode: 0, durationMs: 1, stdout: '', stderr: '' };
  return { plan: structuredClone(plan), source: structuredClone(source), snapshot: structuredClone(snapshot), runId: 'run-123',
    checkpoint: { applied: true, changes: { summary: '선택한 날짜 버튼에 선택 상태를 표시했다.' }, baseline: [passed], verification: [passed], commitSha: 'abc123' } };
}

describe('Korean implementation documents', () => {
  it('uses a dedicated short title in the PR and local report without replacing the summary', () => {
    const value = input(); value.plan.title = '거래 내역 필터 색상 변경';
    value.plan.summary = '거래 내역 화면에서 선택한 필터의 배경색을 바꾸고 다른 필터를 누르면 이전 표시를 지웁니다.';
    value.checkpoint = {};
    expect(renderPullRequestTitle(value)).toBe('[거래 내역 필터 색상 변경 요구사항]');
    for (const body of [renderImplementationReport(value), renderPullRequestBody({ ...value, planId: 'plan-123' })]) {
      expect(body.split('\n')[0]).toBe('# \\[거래 내역 필터 색상 변경 요구사항\\]');
      expect(body).toContain(`## 요약\n\n${value.plan.summary.replace('.', '\\.')}`);
    }
    delete value.plan.title;
    expect(renderPullRequestTitle(value)).toContain('거래 내역 화면에서 선택한 필터');
  });
  it('leads with the requested change and separates planned effects from executed checks', () => {
    const value = input(); const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    expect(renderPullRequestTitle(value)).toBe('[달력의 선택한 날짜 표시 요구사항]');
    expect(body.indexOf('## 요약')).toBeLessThan(body.indexOf('## 기능 구현'));
    expect(body.indexOf('## 기능 구현')).toBeLessThan(body.indexOf('## 사이드 이펙트'));
    expect(body).toContain('## 실제 검증 결과\n\n');
    expect(body).toContain('코드 근거:'); expect(body).toContain('확인 방법:');
    expect(body).toContain('추론한 영향'); expect(body).toContain('| 변경 전 | unit | 통과 | 0 |');
    expect(body).toContain('미실행 (수동 확인 필요)'); expect(body).toContain('slack-dev-run: run-123');
  });
  it('puts numbered changes and impact checks first while preserving prior behavior and code quotes in details', () => {
    const value = input();
    value.plan.items.push({ ...structuredClone(value.plan.items[0]!), id: 'P2', requirementIds: ['REQ-KEYBOARD'],
      currentBehavior: '키보드로 선택한 날짜를 구별하기 어렵다.', proposedChanges: '키보드로 선택한 날짜에도 선택 상태를 표시한다.',
      affectedPaths: ['src/Keyboard.tsx'], blockers: ['키보드 이동을 수동 확인한다.'] });
    value.plan.sideEffects![0]!.codeRefs.push({ path: 'src/Calendar.tsx', quote: 'const selectedDate = dates[currentIndex];' });
    const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    const detailStart = body.indexOf('<details>');
    const main = body.slice(0, detailStart);
    const details = body.slice(detailStart, body.indexOf('</details>'));
    expect(body).toContain('\n\n<details>\n<summary>변경 전 동작·추적 정보와 코드 근거</summary>\n\n### 기능 구현 상세\n\n');
    expect(body).toContain('\n\n</details>\n\n## 검토 정보');
    for (const [index, item] of value.plan.items.entries()) {
      expect(main).toContain(`${index + 1}. ${markdownText(item.proposedChanges)}`);
      for (const path of item.affectedPaths) expect(main).toContain(markdownText(path));
      for (const blocker of item.blockers) expect(main).toContain(markdownText(blocker));
      expect(main).not.toContain(markdownText(item.currentBehavior));
      expect(details).toContain(markdownText(item.currentBehavior));
      for (const id of item.requirementIds) {
        expect(main).not.toContain(markdownText(id));
        expect(details).toContain(markdownText(id));
      }
    }
    for (const effect of value.plan.sideEffects!) {
      expect(main).toContain(markdownText(effect.text));
      expect(main).toContain(`확인 방법: ${markdownText(effect.verification)}`);
      for (const ref of effect.codeRefs) {
        expect(main).toContain(markdownText(ref.path));
        expect(main).not.toContain(markdownText(ref.quote));
        expect(details).toContain(markdownText(ref.quote));
      }
    }
    expect(main.match(/코드 근거: src\\\/Calendar\\\.tsx/g)).toHaveLength(1);
    expect(main).toContain('## 실제 검증 결과');
    expect(main).toContain('| 변경 후 | unit | 통과 | 0 |');
    const local = renderImplementationReport(value);
    expect(local).toContain(markdownText(value.plan.items[0]!.currentBehavior));
    expect(local).toContain(markdownText(value.plan.sideEffects![0]!.codeRefs[1]!.quote));
    expect(local).not.toContain('<details>');
  });
  it('escapes detail content and keeps Slack links and credentials out of the collapsed PR section', () => {
    const value = input();
    const credential = 'sk-' + 'x'.repeat(25);
    const unsafe = `</details><script>alert(1)</script> @org/team ${snapshot.messages[0]!.permalink}`;
    value.plan.items[0]!.currentBehavior = unsafe;
    value.plan.items[0]!.requirementIds = ['REQ-<@U123>'];
    value.plan.sideEffects![0]!.codeRefs = [{ path: 'src/Calendar.tsx', quote: unsafe },
      { path: 'src/secret.ts', quote: credential }];
    const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    expect(body).not.toContain('<script>'); expect(body).not.toContain('@');
    expect(body).not.toContain('private.slack.com'); expect(body).not.toContain(credential);
    expect(body).not.toContain(secretMessage); expect(body).not.toContain('결제 내역을 숨겨 주세요.');
    expect(body).toContain(markdownText(unsafe));
    expect(body).toContain(markdownText('[민감정보를 포함해 본문 생략]'));
  });
  it('does not describe absent impact analysis as no side effects', () => {
    const value = input(); delete value.plan.sideEffects;
    const body = renderSideEffects(value.plan).join('\n');
    expect(body).toContain('영향 분석이 기록되지 않았습니다');
    expect(body).not.toContain('사이드 이펙트가 없습니다');
    expect(renderSideEffects({ ...value.plan, sideEffects: [] })).toEqual(renderSideEffects(value.plan));
  });
  it('renders failed, blocked and absent checks honestly before code application', () => {
    const value = input(); value.checkpoint = { baseline: [{ commandId: 'unit', program: 'node', args: ['--test'], status: 'blocked', exitCode: null, durationMs: 0, stdout: '', stderr: 'unavailable' }] };
    const body = renderImplementationReport(value);
    expect(body).toContain('아직 파일 변경을 완료하지 않았습니다');
    expect(body).toContain('실행 차단'); expect(body).toContain('| 변경 후 | 기록 없음 | 미실행 |');
    expect(body).not.toContain('변경을 커밋했습니다');
    value.checkpoint.verification = [{ ...value.checkpoint.baseline![0]!, status: 'failed', exitCode: 1 }];
    expect(renderImplementationReport(value)).toContain('| 변경 후 | unit | 실패 | 1 |');
  });
  it('keeps raw source evidence local while preventing links, markup and mentions in the PR', () => {
    const value = input();
    value.plan.summary = '선택 상태 표시 @everyone';
    value.plan.items[0]!.proposedChanges = `선택한 날짜를 표시한다. <@U123> @org/team [클릭](https://evil.test)`;
    value.plan.sideEffects![0]!.text = snapshot.messages[0]!.permalink;
    const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    const title = renderPullRequestTitle(value);
    for (const output of [body, title]) {
      expect(output).not.toContain(secretMessage); expect(output).not.toContain('결제 내역을 숨겨 주세요.');
      expect(output).not.toContain('private.slack.com'); expect(output).not.toContain('@');
    }
    expect(body).not.toContain('[클릭](https://evil.test)'); expect(body).not.toContain('<@U123>');
    expect(renderImplementationReport(input())).toContain(snapshot.messages[0]!.permalink);
  });
  it('preserves an approved functional goal even when it exactly matches a source message or short quote', () => {
    const value = input(); const goal = '선택한 날짜를 표시한다';
    value.snapshot.messages[0]!.text = goal;
    value.source.requirements[0]!.sourceRefs[0]!.quote = '날짜';
    value.plan.summary = goal;
    value.plan.items[0]!.proposedChanges = goal;
    value.checkpoint.changes = { summary: goal };
    const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    expect(renderPullRequestTitle(value)).toBe(`[${goal} 요구사항]`);
    expect(body).toContain(`## 요약\n\n${goal}`);
    expect(body).toContain(goal); expect(body).not.toContain('원문 생략');
    expect(body).not.toContain('## 원문 근거'); expect(body).not.toContain(value.snapshot.messages[0]!.permalink);
  });
  it('does not copy credentials or command output into PR text', () => {
    const value = input(); const credential = 'sk-' + 'x'.repeat(25);
    value.checkpoint.changes = { summary: credential }; value.checkpoint.verification![0]!.stdout = secretMessage;
    const body = renderPullRequestBody({ ...value, planId: 'plan-123' });
    expect(body).not.toContain(credential); expect(body).not.toContain(secretMessage);
  });
});
