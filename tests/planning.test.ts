import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type ProjectConfig } from '../src/config.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { RepositoryContext } from '../src/repository.js';
import { FilePlanner, OpenAIPlanner, PLAN_INSTRUCTIONS, renderPlan, validatePlan, type PlanDraft } from '../src/planning.js';
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
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({ status: 'completed', output_parsed: plan(), output: [] });
    const c = config(); const planner = new OpenAIPlanner(c, { client: { responses: { parse } } });
    await expect(planner.plan({ analysis: analysis(), context, config: c, requirementIds: ['R1'] })).resolves.toEqual(plan());
    const request = parse.mock.calls[0]![0];
    expect(request.instructions).toBe(PLAN_INSTRUCTIONS);
    expect(request.instructions).toContain('Use Korean');
    expect(request).toMatchObject({ store: false, max_output_tokens: 8192, text: { format: { strict: true } } });
    expect(request.input).not.toContain(context.repoPath);
    expect(request.input).not.toContain(c.storageDir);
    expect(JSON.parse(request.input).commands).toEqual([{ id: 'test' }]);
  });
  it('escapes untrusted markup in human-readable plans', () => {
    const p = plan(); p.summary = '<script>alert(1)</script> [visit](https://evil.test)';
    const rendered = renderPlan(p, context);
    expect(rendered).toContain('Draft only'); expect(rendered).toContain('abc123');
    expect(rendered).not.toContain('<script>'); expect(rendered).not.toContain('https://evil.test');
    expect(rendered).toContain('A1 → test');
  });
});
