import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type ProjectConfig } from '../src/config.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { RepositoryContext } from '../src/repository.js';
import { FilePlanner, OpenAIPlanner, PLAN_INSTRUCTIONS, generatedPlanSchema, renderPlan, validatePlan, type PlanDraft } from '../src/planning.js';
import type { GenerationClient } from '../src/generation.js';

const directories: string[] = [];
function config(): ProjectConfig {
  const storageDir = mkdtempSync(join(tmpdir(), 'slack-plan-')); directories.push(storageDir);
  return configSchema.parse({ projectId: 'test', slack: { workspace: 'example', channelIds: ['C123'] }, storageDir,
    model: 'gpt-4.1-mini', development: { readPaths: ['src', 'tests'], writePaths: ['src', 'tests'],
      commands: [{ id: 'test', program: 'npm', args: ['test'] }], dockerImage: 'node:24' } });
}
function analysis(): AnalysisDraft {
  return { summary: '한글 요구사항', requirements: [
    { id: 'R1', statement: '지원한다', decisionState: 'confirmed', sourceRefs: [{ messageVersionId: 'M1', quote: '지원한다' }],
      supersedesIds: [], blockingQuestionIds: [], acceptanceCriteria: [{ id: 'A1', text: 'returns yes', origin: 'source', sourceRefs: [{ messageVersionId: 'M1', quote: '지원한다' }] }] },
    { id: 'R2', statement: '나중 작업', decisionState: 'proposed', sourceRefs: [{ messageVersionId: 'M1', quote: '나중 작업' }], supersedesIds: [], blockingQuestionIds: [], acceptanceCriteria: [] },
  ], questions: [] };
}
const context: RepositoryContext = { repoPath: '/unused', commitSha: 'abc123', files: [{ path: 'src/app.ts', content: 'export const enabled = false;\n' }], omittedPaths: [] };
function plan(): PlanDraft {
  return { summary: '동작 수정', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: 'disabled',
    codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }], proposedChanges: 'Enable it and add a test',
    affectedPaths: ['src/app.ts', 'tests/app.test.ts'], dependencies: [], acceptanceChecks: [{ criterionId: 'A1', commandId: 'test', testName: 'returns yes' }], blockers: [] }], excludedRequirements: ['R2'] };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('plan evidence and scope validation', () => {
  it('accepts an evidence-backed plan and a manual criterion check', () => {
    const input = plan(); expect(validatePlan(input, analysis(), context, config(), ['R1'])).toEqual(input);
    input.items[0]!.acceptanceChecks[0]!.commandId = null;
    expect(validatePlan(input, analysis(), context, config(), ['R1'])).toEqual(input);
  });
  it('preserves legacy plan serialization while new generated plans require a title and impact analysis', () => {
    const legacy = plan();
    const validated = validatePlan(legacy, analysis(), context, config(), ['R1']);
    expect(JSON.stringify(validated)).toBe(JSON.stringify(legacy));
    expect(validated).not.toHaveProperty('sideEffects');
    expect(validated).not.toHaveProperty('title');
    expect(() => generatedPlanSchema.parse(legacy)).toThrow();
    expect(() => generatedPlanSchema.parse({ ...legacy, sideEffects: [] })).toThrow();
    expect(generatedPlanSchema.parse({ ...legacy, title: '기능 활성화', sideEffects: [] })).toMatchObject({ title: '기능 활성화', sideEffects: [] });
  });
  it('requires a concise nonempty single-line title when supplied', () => {
    for (const title of ['', ' ', '가'.repeat(81), '기능\n활성화', '기능\r활성화', '기능\r\n활성화']) {
      expect(() => validatePlan({ ...plan(), title }, analysis(), context, config(), ['R1'])).toThrow();
    }
    expect(validatePlan({ ...plan(), title: '거래 내역 필터 색상 변경' }, analysis(), context, config(), ['R1']).title).toBe('거래 내역 필터 색상 변경');
  });
  it('validates each side effect against actual scoped code without claiming execution', () => {
    const input = { ...plan(), sideEffects: [{ text: '공유 플래그를 읽는 경로의 활성 상태가 바뀔 수 있다.',
      codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }], verification: '플래그를 읽는 호출부의 반환값을 확인한다.' }] };
    expect(validatePlan(input, analysis(), context, config(), ['R1'])).toEqual(input);
    input.sideEffects[0]!.codeRefs[0]!.quote = 'enabled = true';
    expect(() => validatePlan(input, analysis(), context, config(), ['R1'])).toThrow(/code evidence/);
    input.sideEffects[0]!.codeRefs = [];
    expect(() => validatePlan(input, analysis(), context, config(), ['R1'])).toThrow();
  });
  it('rejects side effect references outside context/read scope and unexpected grant fields', () => {
    const effect = { text: '호출부의 반환값이 바뀔 수 있다.', codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }], verification: '호출부를 확인한다.' };
    const c = config(); c.development!.readPaths = ['tests'];
    expect(() => validatePlan({ ...plan(), sideEffects: [effect] }, analysis(), context, c, ['R1'])).toThrow(/code evidence/);
    expect(() => validatePlan({ ...plan(), sideEffects: [{ ...effect, codeRefs: [{ path: 'src/missing.ts', quote: 'enabled' }] }] }, analysis(), context, config(), ['R1'])).toThrow(/code evidence/);
    expect(() => validatePlan({ ...plan(), sideEffects: [{ ...effect, approved: true }] }, analysis(), context, config(), ['R1'])).toThrow();
  });
  it.each([
    ['unselected', (p: PlanDraft) => { p.items[0]!.requirementIds = ['R2']; }],
    ['unknown requirement', (p: PlanDraft) => { p.items[0]!.requirementIds = ['missing']; }],
    ['duplicate requirement', (p: PlanDraft) => { p.items[0]!.requirementIds.push('R1'); }],
    ['missing criterion', (p: PlanDraft) => { p.items[0]!.acceptanceChecks = []; }],
    ['unknown criterion', (p: PlanDraft) => { p.items[0]!.acceptanceChecks[0]!.criterionId = 'missing'; }],
    ['duplicate criterion', (p: PlanDraft) => { p.items[0]!.acceptanceChecks.push(p.items[0]!.acceptanceChecks[0]!); }],
    ['unknown command', (p: PlanDraft) => { p.items[0]!.acceptanceChecks[0]!.commandId = 'curl'; }],
    ['fabricated quote', (p: PlanDraft) => { p.items[0]!.codeRefs[0]!.quote = 'enabled = true'; }],
    ['missing evidence', (p: PlanDraft) => { p.items[0]!.codeRefs = []; }],
    ['unknown source', (p: PlanDraft) => { p.items[0]!.codeRefs[0]!.path = 'src/missing.ts'; }],
    ['outside write scope', (p: PlanDraft) => { p.items[0]!.affectedPaths = ['README.md']; }],
    ['path traversal', (p: PlanDraft) => { p.items[0]!.affectedPaths = ['src/../secret']; }],
    ['sensitive path', (p: PlanDraft) => { p.items[0]!.affectedPaths = ['src/.env']; }],
    ['duplicate paths', (p: PlanDraft) => { p.items[0]!.affectedPaths.push('src/app.ts'); }],
    ['missing exclusion', (p: PlanDraft) => { p.excludedRequirements = []; }],
    ['selected exclusion', (p: PlanDraft) => { p.excludedRequirements = ['R1']; }],
    ['duplicate exclusion', (p: PlanDraft) => { p.excludedRequirements.push('R2'); }],
    ['unknown dependency', (p: PlanDraft) => { p.items[0]!.dependencies = ['missing']; }],
    ['self cycle', (p: PlanDraft) => { p.items[0]!.dependencies = ['P1']; }],
    ['duplicate item', (p: PlanDraft) => { p.items.push(p.items[0]!); }],
    ['credential', (p: PlanDraft) => { p.summary = 'sk-' + 'x'.repeat(24); }],
  ])('rejects %s', (_name, mutate) => {
    const input = plan(); mutate(input);
    expect(() => validatePlan(input, analysis(), context, config(), ['R1'])).toThrow();
  });
  it('rejects coverage overlap, missing selected requirements and cross-item criteria', () => {
    const a = analysis(); a.requirements[1]!.acceptanceCriteria = [{ id: 'A2', text: 'second', origin: 'derived', sourceRefs: [] }];
    expect(() => validatePlan(plan(), a, context, config(), ['R1', 'R2'])).toThrow();
    const p = plan(); p.excludedRequirements = []; p.items.push({ ...structuredClone(p.items[0]!), id: 'P2', requirementIds: ['R2'], acceptanceChecks: [{ criterionId: 'A2', commandId: 'test', testName: 'second' }] });
    expect(validatePlan(p, a, context, config(), ['R1', 'R2'])).toEqual(p);
    p.items[0]!.acceptanceChecks[0]!.criterionId = 'A2';
    expect(() => validatePlan(p, a, context, config(), ['R1', 'R2'])).toThrow(/criterion/);
  });
  it('requires read permission and refuses omitted changes', () => {
    const c = config(); c.development!.readPaths = ['tests'];
    expect(() => validatePlan(plan(), analysis(), context, c, ['R1'])).toThrow(/evidence/);
    expect(() => validatePlan(plan(), analysis(), { ...context, omittedPaths: ['tests/app.test.ts'] }, config(), ['R1'])).toThrow(/omitted/);
  });
  it('rejects extra approval fields and invalid requirement selection', () => {
    expect(() => validatePlan({ ...plan(), grants: ['execute'] }, analysis(), context, config(), ['R1'])).toThrow();
    for (const ids of [[], ['R1', 'R1'], ['missing']]) expect(() => validatePlan(plan(), analysis(), context, config(), ids)).toThrow();
  });
});

describe('planner adapters and report', () => {
  it('replays a file through the same validation without API calls', async () => {
    const c = config(); const path = join(c.storageDir, 'plan.json'); writeFileSync(path, JSON.stringify(plan()));
    await expect(new FilePlanner(path).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).resolves.toEqual(plan());
    writeFileSync(path, JSON.stringify({ ...plan(), approved: true }));
    await expect(new FilePlanner(path).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow();
  });
  it('binds replay identity to content and loads it only once', async () => {
    const c = config(); const path = join(c.storageDir, 'plan.json'); writeFileSync(path, JSON.stringify(plan()));
    const first = new FilePlanner(path); const same = new FilePlanner(path);
    expect(first.promptVersion).toBe(same.promptVersion);
    const changed = plan(); changed.summary = 'Edited plan'; writeFileSync(path, JSON.stringify(changed));
    const second = new FilePlanner(path); expect(second.promptVersion).not.toBe(first.promptVersion);
    const input = { analysis: analysis(), context, config: c, requirementIds: ['R1'] };
    await expect(first.plan(input)).resolves.toEqual(plan());
    await expect(second.plan(input)).resolves.toEqual(changed);
  });
  it('uses structured output and sends scoped repository data without local paths or credentials', async () => {
    const generated = { ...plan(), title: '기능 활성화', sideEffects: [] };
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({ status: 'completed', output_parsed: generated, output: [] });
    const c = config(); const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    await expect(planner.plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).resolves.toEqual(generated);
    const request = parse.mock.calls[0]![0];
    expect(request.instructions).toBe(PLAN_INSTRUCTIONS);
    expect(request.instructions).toContain('Use Korean');
    expect(request.instructions).toContain('Do not invent generic risks');
    expect(request.instructions).toContain('sideEffects');
    expect(request.instructions).toContain('short Korean noun phrase');
    expect(request).toMatchObject({ store: false, max_output_tokens: 8192, text: { format: { strict: true } } });
    expect(request.text.format).toMatchObject({ schema: { required: expect.arrayContaining(['title', 'sideEffects']) } });
    expect(request.text.format).toMatchObject({ schema: { properties: { title: { pattern: '\\S', minLength: 1, maxLength: 80 } } } });
    expect(request.input).not.toContain(context.repoPath);
    expect(request.input).not.toContain(c.storageDir);
    expect(JSON.parse(request.input).commands).toEqual([{ id: 'test' }]);
  });
  it('escapes untrusted markup in human-readable plans', () => {
    const p = plan(); p.summary = '<script>alert(1)</script> [visit](https://evil.test)';
    const rendered = renderPlan(p, context);
    expect(rendered).toContain('계획 초안'); expect(rendered).toContain('abc123');
    expect(rendered).toContain('## 요약\n\n'); expect(rendered).toContain('## 기능 구현\n\n');
    expect(rendered).toContain('## 사이드 이펙트\n\n');
    expect(rendered).not.toContain('<script>'); expect(rendered).not.toContain('https://evil.test');
    expect(rendered).toContain('A1 → test');
  });
  it('uses the short title for the heading while retaining the full summary', () => {
    const p = plan(); p.title = '거래 내역 필터 색상 변경'; p.summary = '거래 내역의 선택한 필터에 배경색을 적용하고 다른 필터로 바꾸면 이전 선택 표시를 지웁니다.';
    const rendered = renderPlan(p, context);
    expect(rendered.split('\n')[0]).toBe('# \\[거래 내역 필터 색상 변경 요구사항\\]');
    expect(rendered).toContain(`## 요약\n\n${p.summary.replace('.', '\\.')}`);
  });
});
