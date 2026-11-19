import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configSchema, type ProjectConfig } from '../src/config.js';
import type { RepositoryContext } from '../src/repository.js';
import type { PlanDraft } from '../src/planning.js';
import { BudgetLedger, containsCredential, FileImplementer, MAX_REQUEST_COST_USD, OpenAIImplementer, StructuredGenerator, validateChanges,
  type ChangeSet, type GenerationClient, type GenerationResponse } from '../src/generation.js';
const directories: string[] = [];
function config(): ProjectConfig {
  const storageDir = mkdtempSync(join(tmpdir(), 'slack-gen-')); directories.push(storageDir);
  return configSchema.parse({ projectId: 'test', slack: { workspace: 'example', channelIds: ['C123'] }, storageDir, model: 'gpt-4.1-mini',
    development: { readPaths: ['src'], writePaths: ['src', 'tests'], commands: [{ id: 'test', program: 'npm', args: ['test'] }], dockerImage: 'node:24' } });
}
const context: RepositoryContext = { repoPath: '/unused', commitSha: 'abc123', files: [{ path: 'src/app.ts', content: 'export const enabled = false;\n' }], omittedPaths: [] };
const plan: PlanDraft = { summary: 'enable', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: 'disabled', codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }], proposedChanges: 'enable', affectedPaths: ['src/app.ts', 'tests/new.ts'], dependencies: [], acceptanceChecks: [], blockers: [] }], excludedRequirements: [] };
function changes(): ChangeSet { return { summary: 'Enable', files: [{ path: 'src/app.ts', content: 'export const enabled = true;\n' }] }; }
function provider(overrides: Partial<GenerationResponse> = {}) {
  const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({ status: 'completed', output: [], output_parsed: { value: 'ok' }, ...overrides });
  return { client: { responses: { parse } }, parse };
}
const schema = z.object({ value: z.string() }).strict();
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('whole-file change validation', () => {
  it('accepts actual edits, additions and deletion of a context file', () => {
    const c = config(); expect(validateChanges(changes(), plan, context, c)).toEqual(changes());
    expect(validateChanges({ summary: 'new', files: [{ path: 'tests/new.ts', content: 'export {}' }] }, plan, context, c).files).toHaveLength(1);
    expect(validateChanges({ summary: 'delete', files: [{ path: 'src/app.ts', content: null }] }, plan, context, c).files[0]!.content).toBeNull();
  });
  it.each([
    ['duplicate paths', (c: ChangeSet) => { c.files.push(c.files[0]!); }],
    ['unplanned paths', (c: ChangeSet) => { c.files[0]!.path = 'src/else.ts'; }],
    ['traversal', (c: ChangeSet) => { c.files[0]!.path = 'src/../outside'; }],
    ['no-op edit', (c: ChangeSet) => { c.files[0]!.content = context.files[0]!.content; }],
    ['binary content', (c: ChangeSet) => { c.files[0]!.content = 'hello\0'; }],
    ['unknown deletion', (c: ChangeSet) => { c.files = [{ path: 'tests/new.ts', content: null }]; }],
    ['credential summary', (c: ChangeSet) => { c.summary = 'sk-' + 'x'.repeat(25); }],
    ['credential content', (c: ChangeSet) => { c.files[0]!.content = 'xoxb-' + '1'.repeat(24); }],
  ])('rejects %s', (_name, mutate) => {
    const c = changes(); mutate(c); expect(() => validateChanges(c, plan, context, config())).toThrow();
  });
  it('requires bounded file counts and UTF-8 byte sizes', () => {
    const c = config(); c.development!.maxFileBytes = 256;
    expect(() => validateChanges({ summary: 'large', files: [{ path: 'src/app.ts', content: '한'.repeat(100) }] }, plan, context, c)).toThrow(/file size/);
    c.development!.maxChangedFiles = 1;
    expect(() => validateChanges({ summary: 'two', files: [...changes().files, { path: 'tests/new.ts', content: 'new' }] }, plan, context, c)).toThrow(/file count/);
    c.development!.maxFileBytes = 1000; c.development!.maxChangeBytes = 256;
    expect(() => validateChanges({ summary: 'total', files: [{ path: 'src/app.ts', content: 'x'.repeat(300) }] }, plan, context, c)).toThrow(/total size/);
  });
  it('rejects omitted files, write-scope escape and authority fields', () => {
    expect(() => validateChanges(changes(), plan, { ...context, omittedPaths: ['src/app.ts'] }, config())).toThrow(/omitted/);
    const c = config(); c.development!.writePaths = ['tests'];
    expect(() => validateChanges(changes(), plan, context, c)).toThrow(/write scope/);
    expect(() => validateChanges({ ...changes(), execute: ['rm -rf'] }, plan, context, config())).toThrow();
  });
  it.each(['sk-' + 'a'.repeat(30), 'xoxb-' + 'a'.repeat(20), 'ghp_' + 'a'.repeat(30), 'github_pat_' + 'a'.repeat(30),
    'AKIA' + 'A'.repeat(16), '-----BEGIN OPENSSH PRIVATE KEY-----', 'OPENAI_API_KEY=' + 'A'.repeat(30)])('detects credential pattern', value => expect(containsCredential(value)).toBe(true));
});

describe('durable request budgets', () => {
  it('reserves before requests, survives restart and rejects exceeding cumulative allowance', () => {
    const c = config(); const ledger = new BudgetLedger(c.storageDir, 0.5);
    ledger.reserve('plan'); expect(ledger.summary()).toEqual({ reservedOrSpentUsd: MAX_REQUEST_COST_USD, limitUsd: 0.5, requests: 1 }); ledger.close();
    const reopened = new BudgetLedger(c.storageDir, 0.5);
    expect(() => reopened.reserve('implement')).toThrow(/budget/);
    expect(reopened.summary().requests).toBe(1); reopened.close();
  });
  it('settles provider usage with cached input rate and keeps unknown usage reservation', () => {
    const c = config(); const ledger = new BudgetLedger(c.storageDir, 1);
    const id = ledger.reserve('plan'); const usage = ledger.settle(id, { input_tokens: 100, output_tokens: 200, total_tokens: 300, input_tokens_details: { cached_tokens: 50 } }, 'req-123');
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 200, cachedInputTokens: 50, estimatedCostUsd: 0.000345, requestId: 'req-123' });
    const second = ledger.reserve('implement');
    expect(ledger.settle(second, { input_tokens: -1, output_tokens: 1, total_tokens: 0 })).toBeUndefined();
    expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(0.000345 + MAX_REQUEST_COST_USD);
    ledger.close();
  });
  it('does not reset a settled charge or follow a database symlink', () => {
    const c = config(); const ledger = new BudgetLedger(c.storageDir); const id = ledger.reserve('plan');
    ledger.settle(id, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    ledger.settle(id, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    expect(ledger.summary().reservedOrSpentUsd).toBe(0.000002); ledger.close();
    const other = config(); symlinkSync(join(c.storageDir, 'budget.sqlite'), join(other.storageDir, 'budget.sqlite'));
    expect(() => new BudgetLedger(other.storageDir)).toThrow(/symbolic/);
  });
});

describe('paid transport boundary using mocked requests only', () => {
  it('calls once with strict output, bounded tokens and no remote storage; captures usage', async () => {
    const c = config(); const { client, parse } = provider({ usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } });
    const generator = new StructuredGenerator(c, { client });
    await expect(generator.generate(schema, 'plan', 'instructions', { text: 'data' })).resolves.toEqual({ value: 'ok' });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]![0]).toMatchObject({ model: 'gpt-4.1-mini', store: false, max_output_tokens: 8192, text: { format: { strict: true, name: 'plan' } } });
    expect(generator.usage?.estimatedCostUsd).toBe(0.00036);
  });
  it('never retries provider failure and retains the full reservation', async () => {
    const c = config(); const { client, parse } = provider(); parse.mockRejectedValue(new Error('temporary failure'));
    await expect(new StructuredGenerator(c, { client }).generate(schema, 'plan', 'instructions', {})).rejects.toThrow('temporary failure');
    expect(parse).toHaveBeenCalledTimes(1);
    const ledger = new BudgetLedger(c.storageDir); expect(ledger.summary().reservedOrSpentUsd).toBe(MAX_REQUEST_COST_USD); ledger.close();
  });
  it('refuses unsupported models, excess budget, oversized context and credentials before provider call', async () => {
    const c = config(); const { client, parse } = provider();
    expect(() => new StructuredGenerator({ ...c, model: 'unverified' }, { client })).toThrow(/verified model/);
    c.development!.budgetUsd = 0.01;
    await expect(new StructuredGenerator(c, { client }).generate(schema, 'plan', 'instructions', {})).rejects.toThrow(/budget/);
    c.development!.budgetUsd = 10;
    await expect(new StructuredGenerator(c, { client }).generate(schema, 'plan', 'instructions', { content: '한'.repeat(100_000) })).rejects.toThrow(/context limit/);
    await expect(new StructuredGenerator(c, { client }).generate(schema, 'plan', 'instructions', { token: 'sk-' + 'a'.repeat(30) })).rejects.toThrow(/credential/);
    expect(parse).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'incomplete' }, { status: 'failed' }, { error: { message: 'error' } }, { incomplete_details: { reason: 'limit' } },
    { output_parsed: null }, { output_parsed: { value: 'ok', grant: 'implement' } },
    { output: [{ type: 'message', status: 'incomplete', content: [] }] },
    { output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
  ])('fails closed on provider output %j', async overrides => {
    const c = config(); const { client } = provider(overrides);
    await expect(new StructuredGenerator(c, { client }).generate(schema, 'plan', 'instructions', {})).rejects.toThrow();
  });
  it('replays implementations and validates mocked implementation output', async () => {
    const c = config(); const input = { analysis: { summary: '한글', requirements: [], questions: [] }, plan, context, config: c };
    const file = join(c.storageDir, 'changes.json'); writeFileSync(file, JSON.stringify(changes()));
    const first = new FileImplementer(file); const same = new FileImplementer(file);
    expect(first.promptVersion).toBe(same.promptVersion);
    await expect(first.implement(input)).resolves.toEqual(changes());
    const changed = changes(); changed.summary = 'Updated'; writeFileSync(file, JSON.stringify(changed));
    const second = new FileImplementer(file); expect(second.promptVersion).not.toBe(first.promptVersion);
    await expect(first.implement(input)).resolves.toEqual(changes());
    await expect(second.implement(input)).resolves.toEqual(changed);
    const { client, parse } = provider({ output_parsed: changes() });
    await expect(new OpenAIImplementer(c, { client }).implement(input)).resolves.toEqual(changes());
    expect(parse.mock.calls[0]![0].instructions).toContain('Use Korean');
    expect(parse.mock.calls[0]![0].input).not.toContain(context.repoPath);
  });
});
