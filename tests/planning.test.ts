import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type ProjectConfig } from '../src/config.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { RepositoryContext } from '../src/repository.js';
import { FilePlanner, OpenAIPlanner, PLAN_INSTRUCTIONS, generatedPlanSchema, generatedPlanWireSchema, renderPlan, validatePlan, type PlanDraft } from '../src/planning.js';
import { BudgetLedger, type GenerationClient } from '../src/generation.js';

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
function wirePlan(): ReturnType<typeof generatedPlanWireSchema.parse> {
  const stored = plan();
  return { ...stored, title: '기능 활성화', sideEffects: [{ text: '현재 false인 enabled 값을 true로 바꾸면 외부에 제공하는 활성 상태가 바뀐다.',
    codeRefs: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }], verification: 'enabled가 true인지 테스트하고 실제 사용처의 분기 동작은 별도로 확인한다.' }], items: stored.items.map(item => ({ ...item,
    codeRefs: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }] })) };
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
    const generated = { ...plan(), title: '기능 활성화', sideEffects: wirePlan().sideEffects.map(effect => ({ ...effect,
      codeRefs: [{ path: 'src/app.ts', quote: 'export const enabled = false;' }] })) };
    generated.items[0]!.codeRefs[0]!.quote = 'export const enabled = false;';
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({ status: 'completed', output_parsed: wirePlan(), output: [] });
    const c = config(); const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    await expect(planner.plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).resolves.toEqual(generated);
    const request = parse.mock.calls[0]![0];
    expect(request.instructions).toBe(PLAN_INSTRUCTIONS);
    expect(request.instructions).toContain('Use Korean');
    expect(request.instructions).toContain('Do not invent generic risks');
    expect(request.instructions).toContain('sideEffects');
    expect(request.instructions).toContain('sideEffects must contain at least one concrete code-grounded impact');
    expect(request.instructions).toContain('short Korean noun phrase');
    expect(request.instructions).toContain('inclusive one-based startLine/endLine');
    expect(request.instructions).toContain('Every file listed in affectedPaths must actually change during implementation');
    expect(request.instructions).toContain('Read-only code evidence and impact analysis belong only in codeRefs');
    expect(request).toMatchObject({ store: false, max_output_tokens: 8192, text: { format: { strict: true } } });
    expect(request.text.format).toMatchObject({ schema: { required: expect.arrayContaining(['title', 'sideEffects']) } });
    expect(request.text.format).toMatchObject({ schema: { properties: { title: { pattern: '\\S', minLength: 1, maxLength: 80 } } } });
    expect(request.text.format).toMatchObject({ schema: { properties: { sideEffects: { minItems: 1 } } } });
    expect(request.input).not.toContain(context.repoPath);
    expect(request.input).not.toContain(c.storageDir);
    expect(JSON.parse(request.input).commands).toEqual([{ id: 'test' }]);
    expect(JSON.parse(request.input).repository.files).toEqual([{ path: 'src/app.ts', lines: [
      { number: 1, text: 'export const enabled = false;' }, { number: 2, text: '' },
    ] }]);
    expect(request.text.format).toMatchObject({ schema: { properties: { items: { items: { properties: {
      codeRefs: { items: { required: ['path', 'startLine', 'endLine'], additionalProperties: false } },
    } } } } } });
    expect(planner.promptVersion).toBe('planning-v8');
    expect(parse).toHaveBeenCalledTimes(1);
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
  it('rejects an empty provider impact analysis while preserving stored-plan compatibility', async () => {
    expect(generatedPlanSchema.parse({ ...plan(), title: '기능 활성화', sideEffects: [] }).sideEffects).toEqual([]);
    const c = config(); const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({
      status: 'completed', output_parsed: { ...wirePlan(), sideEffects: [] }, output: [],
    });
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('uses the short title for the heading while retaining the full summary', () => {
    const p = plan(); p.title = '거래 내역 필터 색상 변경'; p.summary = '거래 내역의 선택한 필터에 배경색을 적용하고 다른 필터로 바꾸면 이전 선택 표시를 지웁니다.';
    const rendered = renderPlan(p, context);
    expect(rendered.split('\n')[0]).toBe('# \\[거래 내역 필터 색상 변경 요구사항\\]');
    expect(rendered).toContain(`## 요약\n\n${p.summary.replace('.', '\\.')}`);
  });
});

describe('provider line ranges become exact local code evidence', () => {
  const response = (output: unknown) => ({ status: 'completed', output_parsed: output, output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  it.each(['\n', '\r\n'])('preserves original whitespace and Unicode for %j source endings', async ending => {
    const c = config(); const draft = wirePlan();
    draft.items[0]!.codeRefs = [{ path: 'src/app.ts', startLine: 2, endLine: 3 }];
    draft.sideEffects = [{ text: '공유 값이 바뀔 수 있다.', codeRefs: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }], verification: '호출부를 확인한다.' }];
    const scoped = { ...context, files: [{ path: 'src/app.ts', content: ['// header', '\tconst enabled = false;', 'const label = "가";', ''].join(ending) }] };
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    const result = await new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context: scoped, config: c, requirementIds: ['R1'] });
    const quote = '\tconst enabled = false;' + ending + 'const label = "가";' + (ending === '\r\n' ? '\r' : '');
    expect(result.items[0]!.codeRefs).toEqual([{ path: 'src/app.ts', quote }]);
    expect(result.sideEffects).toEqual([{ ...draft.sideEffects[0], codeRefs: [{ path: 'src/app.ts', quote: '// header' + (ending === '\r\n' ? '\r' : '') }] }]);
    expect(scoped.files[0]!.content).toContain(quote);
    expect(result.items[0]).toEqual({ ...draft.items[0], codeRefs: [{ path: 'src/app.ts', quote }] });
    expect(JSON.stringify(result)).not.toContain('startLine'); expect(JSON.stringify(result)).not.toContain('endLine');
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('accepts the inclusive final line and records a single budgeted request', async () => {
    const c = config(); const draft = wirePlan(); draft.items[0]!.codeRefs[0]!.endLine = 2;
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    const result = await planner.plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] });
    expect(result.items[0]!.codeRefs[0]!.quote).toBe(context.files[0]!.content);
    expect(planner.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    const ledger = new BudgetLedger(c.storageDir);
    try { expect(ledger.summary().requests).toBe(1); expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(0.000072); }
    finally { ledger.close(); }
  });
  it.each([
    { name: 'zero start', startLine: 0, endLine: 1, calls: 1 },
    { name: 'zero end', startLine: 1, endLine: 0, calls: 1 },
    { name: 'negative start', startLine: -1, endLine: 1, calls: 1 },
    { name: 'fractional start', startLine: 1.5, endLine: 2, calls: 1 },
    { name: 'fractional end', startLine: 1, endLine: 1.5, calls: 1 },
    { name: 'reverse range', startLine: 2, endLine: 1, calls: 2 },
    { name: 'end beyond file', startLine: 1, endLine: 3, calls: 2 },
    { name: 'start beyond file', startLine: 3, endLine: 3, calls: 2 },
    { name: 'blank final line', startLine: 2, endLine: 2, calls: 2 },
  ])('rejects $name with at most one schema-valid correction', async ({ startLine, endLine, calls }) => {
    const c = config(); const draft = wirePlan(); draft.items[0]!.codeRefs = [{ path: 'src/app.ts', startLine, endLine }];
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(calls);
  });
  it.each(['   \t', 'x'.repeat(16_001)])('rejects blank or oversized selected text', async content => {
    const c = config(); const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(wirePlan()));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context: { ...context, files: [{ path: 'src/app.ts', content }] }, config: c, requirementIds: ['R1'] })).rejects.toThrow(/line range/);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('accepts exactly the stored quote length limit', async () => {
    const c = config(); const content = 'x'.repeat(16_000);
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(wirePlan()));
    const result = await new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context: { ...context, files: [{ path: 'src/app.ts', content }] }, config: c, requirementIds: ['R1'] });
    expect(result.items[0]!.codeRefs[0]!.quote).toBe(content);
  });
  it.each(['src/missing.ts', 'private/app.ts', 'src/../app.ts'])('rejects an unavailable or forbidden evidence path %s', async path => {
    const c = config(); const draft = wirePlan(); draft.items[0]!.codeRefs[0]!.path = path;
    const scoped = { ...context, files: [...context.files, { path: 'private/app.ts', content: 'private code' }] };
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context: scoped, config: c, requirementIds: ['R1'] })).rejects.toThrow(/evidence path/);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('rejects omitted evidence and validates side-effect ranges by the same rules', async () => {
    const c = config(); const draft = wirePlan();
    draft.sideEffects = [{ text: '영향', codeRefs: [{ path: 'src/app.ts', startLine: 1, endLine: 3 }], verification: '확인' }];
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    const input = { analysis: analysis(), context, config: c, requirementIds: ['R1'] };
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input)).rejects.toThrow(/line range/);
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockReset().mockResolvedValue(response(wirePlan()));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ ...input, context: { ...context, omittedPaths: ['src/app.ts'] } })).rejects.toThrow(/evidence path/);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('rejects model-supplied quotes, forged content, and execution authority', async () => {
    const c = config(); const draft = wirePlan();
    for (const output of [
      { ...draft, items: [{ ...draft.items[0], codeRefs: [{ ...draft.items[0]!.codeRefs[0], quote: 'forged code' }] }] },
      { ...draft, repository: { files: [{ path: 'src/app.ts', content: 'forged code' }] } },
      { ...draft, approved: true },
    ]) {
      const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(output));
      await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow();
      expect(parse).toHaveBeenCalledTimes(1);
    }
  });
  it('still enforces the stored plan scope after materialization', async () => {
    const c = config(); const draft = wirePlan(); draft.items[0]!.affectedPaths = ['private/app.ts'];
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(draft));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow(/write scope/);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('never retries provider failures or sends a request beyond the budget', async () => {
    const c = config(); const parse = vi.fn<GenerationClient['responses']['parse']>().mockRejectedValue(new Error('500 provider failure'));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow('500 provider failure');
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockReset().mockResolvedValue(response(wirePlan()));
    const constrained = config(); constrained.development!.budgetUsd = 0.1;
    await expect(new OpenAIPlanner(constrained, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: constrained, requirementIds: ['R1'] })).rejects.toThrow('API budget would be exceeded');
    expect(parse).not.toHaveBeenCalled();
    const ledger = new BudgetLedger(constrained.storageDir, 0.1); try { expect(ledger.summary().requests).toBe(0); } finally { ledger.close(); }
  });
  it('materializes from the frozen source despite in-flight caller changes', async () => {
    const c = config(); const input = { analysis: analysis(), context: structuredClone(context), config: c, requirementIds: ['R1'] };
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockImplementationOnce(async () => {
      input.context.files[0]!.content = 'export const changed = true;'; return response(wirePlan());
    });
    const result = await new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input);
    expect(result.items[0]!.codeRefs[0]!.quote).toBe('export const enabled = false;');
    expect(JSON.parse(parse.mock.calls[0]![0].input).repository.files[0].lines[0]).toEqual({ number: 1, text: 'export const enabled = false;' });
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('one bounded correction of locally invalid plans', () => {
  const response = (output: unknown) => ({ status: 'completed', output_parsed: output, output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  function missingCriterion() { const draft = wirePlan(); draft.items[0]!.acceptanceChecks = []; return draft; }
  it('sends the complete requirement-to-criterion mapping on both calls and validates the corrected plan', async () => {
    const c = config(); const selected = analysis();
    selected.requirements[0]!.acceptanceCriteria.push({ id: 'A2', text: 'second behavior', origin: 'derived', sourceRefs: [] });
    const corrected = wirePlan(); corrected.items[0]!.acceptanceChecks.push({ criterionId: 'A2', commandId: 'test', testName: 'second behavior' });
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValueOnce(response(wirePlan())).mockResolvedValueOnce(response(corrected));
    const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    const result = await planner.plan({ analysis: selected, context, config: c, requirementIds: ['R1'] });
    expect(result.items[0]!.acceptanceChecks).toEqual(corrected.items[0]!.acceptanceChecks);
    expect(result.items[0]!.codeRefs[0]!.quote).toBe('export const enabled = false;');
    expect(parse).toHaveBeenCalledTimes(2);
    const first = JSON.parse(parse.mock.calls[0]![0].input), second = JSON.parse(parse.mock.calls[1]![0].input);
    const { correction, ...unchanged } = second;
    expect(unchanged).toEqual(first);
    expect(first.expectedRequirementCriteria).toEqual([{ requirementId: 'R1', criterionIds: ['A1', 'A2'] }]);
    expect(first.expectedExcludedRequirementIds).toEqual(['R2']);
    expect(correction).toEqual({ invalidWire: wirePlan(), validationError: 'Plan must map every selected acceptance criterion exactly once' });
    expect(parse.mock.calls[1]![0].instructions).toContain('only correction attempt');
    expect(parse.mock.calls[1]![0].instructions).toContain('untrusted diagnostic data');
    expect(parse.mock.calls[1]![0]).toMatchObject({ store: false, text: { format: { name: 'implementation_plan_repair', strict: true } } });
    expect(planner.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, totalTokens: 240,
      attempts: [expect.objectContaining({ inputTokens: 100 }), expect.objectContaining({ inputTokens: 100 })] });
    const ledger = new BudgetLedger(c.storageDir);
    try { expect(ledger.summary().requests).toBe(2); expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(0.000144); }
    finally { ledger.close(); }
  });
  it.each([
    ['missing criterion', (draft: ReturnType<typeof wirePlan>) => { draft.items[0]!.acceptanceChecks = []; }],
    ['unknown requirement', (draft: ReturnType<typeof wirePlan>) => { draft.items[0]!.requirementIds = ['unknown']; }],
    ['unknown command', (draft: ReturnType<typeof wirePlan>) => { draft.items[0]!.acceptanceChecks[0]!.commandId = 'unknown'; }],
    ['line range', (draft: ReturnType<typeof wirePlan>) => { draft.items[0]!.codeRefs[0]!.endLine = 3; }],
    ['write scope', (draft: ReturnType<typeof wirePlan>) => { draft.items[0]!.affectedPaths = ['private/app.ts']; }],
  ])('allows one complete correction for %s', async (_name, mutate) => {
    const c = config(); const invalid = wirePlan(); mutate(invalid);
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(wirePlan()));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).resolves.toMatchObject({ title: '기능 활성화' });
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('stops after a second invalid plan and applies every final invariant', async () => {
    const c = config(); const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(missingCriterion()));
    const input = { analysis: analysis(), context, config: c, requirementIds: ['R1'] };
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input)).rejects.toThrow('Plan must map every selected acceptance criterion exactly once');
    expect(parse).toHaveBeenCalledTimes(2);
    const outsideScope = wirePlan(); outsideScope.items[0]!.affectedPaths = ['private/app.ts'];
    parse.mockReset().mockResolvedValueOnce(response(missingCriterion())).mockResolvedValueOnce(response(outsideScope));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input)).rejects.toThrow('write scope');
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it('does not send a correction if the second reservation exceeds the same durable budget', async () => {
    const c = config(); c.development!.budgetUsd = 0.5;
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({ status: 'completed', output_parsed: missingCriterion(), output: [] });
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).rejects.toThrow('API budget would be exceeded');
    expect(parse).toHaveBeenCalledTimes(1);
    const ledger = new BudgetLedger(c.storageDir, 0.5); try { expect(ledger.summary().requests).toBe(1); } finally { ledger.close(); }
  });
  it('never retries credentials, malformed correction output or a correction provider failure', async () => {
    const c = config(); const input = { analysis: analysis(), context, config: c, requirementIds: ['R1'] };
    const credential = missingCriterion(); credential.summary = 'sk-' + 'x'.repeat(24);
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue(response(credential));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input)).rejects.toThrow('credential');
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockReset().mockResolvedValueOnce(response(missingCriterion())).mockResolvedValueOnce(response({ ...wirePlan(), approved: true }));
    await expect(new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input)).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockReset().mockResolvedValueOnce(response(missingCriterion())).mockRejectedValueOnce(new Error('500 on correction'));
    const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    await expect(planner.plan(input)).rejects.toThrow('500 on correction');
    expect(parse).toHaveBeenCalledTimes(2);
    expect(planner.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, attempts: [expect.objectContaining({ inputTokens: 100 }), null] });
  });
  it('uses frozen analysis and source code for correction and final validation', async () => {
    const c = config(); const input = { analysis: analysis(), context: structuredClone(context), config: c, requirementIds: ['R1'] };
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockImplementationOnce(async () => {
      input.context.files[0]!.content = 'changed source'; input.analysis.requirements[0]!.acceptanceCriteria = [];
      return response(missingCriterion());
    }).mockResolvedValueOnce(response(wirePlan()));
    const result = await new OpenAIPlanner(c, { client: { responses: { parse } } }).plan(input);
    expect(result.items[0]!.codeRefs[0]!.quote).toBe('export const enabled = false;');
    expect(JSON.parse(parse.mock.calls[1]![0].input).expectedRequirementCriteria).toEqual([{ requirementId: 'R1', criterionIds: ['A1'] }]);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
