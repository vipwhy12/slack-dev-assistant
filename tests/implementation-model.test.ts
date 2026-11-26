import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { BudgetLedger, implementationModel, modelMaxRequestCostUsd, OpenAIImplementer, StructuredGenerator,
  type GenerationClient, type GenerationResponse, type ImplementationInput } from '../src/generation.js';
import type { PlanDraft } from '../src/planning.js';
import type { RepositoryContext } from '../src/repository.js';
import type { VerificationResult } from '../src/runner.js';

const directories: string[] = [];
const original = 'export const enabled = false;\n';
const fixed = 'export const enabled = true;\n';
const duplicate = fixed + fixed;
const context: RepositoryContext = { repoPath: '/unused', commitSha: 'fixture-commit',
  files: [{ path: 'src/app.ts', content: original }], omittedPaths: [] };
const plan: PlanDraft = { summary: 'Enable the approved flag', items: [{ id: 'P1', requirementIds: ['R1'],
  currentBehavior: 'Flag is disabled', codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }],
  proposedChanges: 'Enable the flag', affectedPaths: ['src/app.ts'], dependencies: [], acceptanceChecks: [], blockers: [] }], excludedRequirements: [] };
const failure: VerificationResult = { commandId: 'test', program: 'npm', args: ['test'], status: 'failed',
  exitCode: 1, durationMs: 1, stdout: '', stderr: 'Duplicate declaration: enabled' };

function config(override?: 'gpt-4.1-mini' | 'gpt-4.1'): ProjectConfig {
  const storageDir = mkdtempSync(join(tmpdir(), 'slack-implementation-model-')); directories.push(storageDir);
  return configSchema.parse({ projectId: 'test', model: 'gpt-4.1-mini', storageDir,
    slack: { workspace: 'example', channelIds: ['C123'] },
    development: { readPaths: ['src'], writePaths: ['src'], commands: [{ id: 'test', program: 'npm', args: ['test'] }],
      dockerImage: 'node:24', budgetUsd: 6.7, ...(override ? { implementationModel: override } : {}) } });
}
function input(c: ProjectConfig): ImplementationInput {
  return { config: c, context: structuredClone(context), plan: structuredClone(plan),
    analysis: { summary: 'Enable', requirements: [], questions: [] } };
}
function patch(old = 'enabled = false', replacement = 'enabled = true') {
  return { summary: 'Enable', files: [{ path: 'src/app.ts', kind: 'edit', replacements: [{ old, new: replacement }] }] };
}
function response(output: unknown, withUsage = true): GenerationResponse {
  return { status: 'completed', output: [], output_parsed: output,
    ...(withUsage ? { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } : {}) };
}
function provider(...responses: GenerationResponse[]) {
  const parse = vi.fn<GenerationClient['responses']['parse']>();
  for (const result of responses) parse.mockResolvedValueOnce(result);
  return { parse, client: { responses: { parse } } };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('implementation-only model routing', () => {
  it('keeps legacy configs on mini and accepts only the two explicitly supported overrides', () => {
    const legacy = config();
    expect(legacy.development!.implementationModel).toBeUndefined();
    expect(Object.hasOwn(legacy.development!, 'implementationModel')).toBe(false);
    expect(implementationModel(legacy)).toBe('gpt-4.1-mini');
    for (const override of ['gpt-4.1-mini', 'gpt-4.1'] as const) {
      const selected = config(override);
      expect(selected.model).toBe('gpt-4.1-mini');
      expect(implementationModel(selected)).toBe(override);
    }
    expect(() => configSchema.parse({ ...legacy, development: { ...legacy.development, implementationModel: 'unpriced-model' } })).toThrow();
  });

  it('does not apply an implementation override to the default structured generator used by analysis and planning', async () => {
    const c = config('gpt-4.1'); const fake = provider(response({ value: 'ok' }));
    const generator = new StructuredGenerator(c, { client: fake.client });
    await expect(generator.generate(z.object({ value: z.string() }).strict(), 'plan', 'Fixture instructions', {})).resolves.toEqual({ value: 'ok' });
    expect(fake.parse).toHaveBeenCalledTimes(1);
    expect(fake.parse.mock.calls[0]![0]).toMatchObject({ model: 'gpt-4.1-mini', store: false, max_output_tokens: 8192 });
    expect(generator.usage?.estimatedCostUsd).toBeCloseTo(0.000072, 12);
  });

  it('keeps implementation on mini when no override was supplied', async () => {
    const c = config(); const fake = provider(response(patch()));
    const implementer = new OpenAIImplementer(c, { client: fake.client });
    expect(implementer.model).toBe('gpt-4.1-mini');
    await implementer.implement(input(c));
    expect(fake.parse.mock.calls[0]![0].model).toBe('gpt-4.1-mini');
  });

  it('rejects using the implementation-only model for an analysis or plan phase before reserving or sending', async () => {
    const c = config('gpt-4.1'); const fake = provider(response({ value: 'ok' }));
    const generator = new StructuredGenerator(c, { client: fake.client }, 'implementation');
    for (const phase of ['analyze', 'plan', 'save']) {
      await expect(generator.generate(z.object({ value: z.string() }), phase, 'Fixture instructions', {})).rejects.toThrow('only generate implementation edits');
    }
    expect(fake.parse).not.toHaveBeenCalled();
    const ledger = new BudgetLedger(c.storageDir, 6.7);
    try { expect(ledger.summary().requests).toBe(0); } finally { ledger.close(); }
  });

  it('uses the override for implementation, anchor correction, verification repair and its anchor correction', async () => {
    const c = config('gpt-4.1');
    const fake = provider(response(patch('not in the original file', 'fixed')), response(patch()),
      response(patch('not in the current file', 'fixed')), response(patch(duplicate, fixed)));
    const implementer = new OpenAIImplementer(c, { client: fake.client });
    expect(implementer.model).toBe('gpt-4.1');
    await expect(implementer.implement(input(c))).resolves.toMatchObject({ files: [{ path: 'src/app.ts', content: fixed }] });
    await expect(implementer.repair({ ...input(c), previousChanges: { summary: 'Duplicate flag', files: [{ path: 'src/app.ts', content: duplicate }] },
      verification: [failure] })).resolves.toMatchObject({ files: [{ path: 'src/app.ts', content: fixed }] });
    expect(fake.parse).toHaveBeenCalledTimes(4);
    expect(fake.parse.mock.calls.map(([request]) => request.model)).toEqual(Array(4).fill('gpt-4.1'));
    expect(fake.parse.mock.calls.map(([request]) => request.text.format.name)).toEqual([
      'file_edits', 'file_edits_repair', 'file_edits_verification_repair', 'file_edits_verification_repair_anchor',
    ]);
    expect(fake.parse.mock.calls.every(([request]) => request.store === false && request.max_output_tokens === 16384)).toBe(true);
    expect(implementer.usage?.estimatedCostUsd).toBeCloseTo(0.00072, 12);
    const ledger = new BudgetLedger(c.storageDir, 6.7);
    try { expect(ledger.summary()).toEqual({ reservedOrSpentUsd: 0.00144, limitUsd: 6.7, requests: 4 }); }
    finally { ledger.close(); }
  });

  it('does not relax approved file scope or retry authority errors when a larger model is selected', async () => {
    const c = config('gpt-4.1');
    const escaped = { ...patch(), files: [...patch().files, { path: 'src/unapproved.ts', kind: 'create', content: 'export {};' }] };
    const fake = provider(response(escaped));
    await expect(new OpenAIImplementer(c, { client: fake.client }).implement(input(c))).rejects.toThrow(/scope/);
    expect(fake.parse).toHaveBeenCalledTimes(1);
    expect(fake.parse.mock.calls[0]![0].model).toBe('gpt-4.1');
  });
});

describe('shared model-priced request ledger', () => {
  it('uses conservative model-specific context and output reservations', () => {
    expect(modelMaxRequestCostUsd('gpt-4.1-mini')).toBeCloseTo(0.4321376, 12);
    expect(modelMaxRequestCostUsd('gpt-4.1')).toBeCloseTo(2.226224, 12);
  });

  it('settles cached usage with each persisted reservation model after reopening the same database', () => {
    const c = config(); const ledger = new BudgetLedger(c.storageDir, 6.7);
    // Phase names deliberately differ from model roles: the stored model determines pricing.
    const mini = ledger.reserve('file_edits');
    const full = ledger.reserve('plan', 'gpt-4.1');
    expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(2.6583616, 12);
    ledger.close();
    const reopened = new BudgetLedger(c.storageDir, 6.7);
    const usage = { input_tokens: 200, output_tokens: 50, total_tokens: 250, input_tokens_details: { cached_tokens: 50 } };
    try {
      expect(reopened.settle(full, usage)?.estimatedCostUsd).toBeCloseTo(0.000725, 12);
      expect(reopened.settle(mini, usage)?.estimatedCostUsd).toBeCloseTo(0.000145, 12);
      expect(reopened.summary()).toEqual({ reservedOrSpentUsd: 0.00087, limitUsd: 6.7, requests: 2 });
    } finally { reopened.close(); }
  });

  it('counts both models against one durable $6.70 cap and blocks either provider before sending a request', async () => {
    const c = config('gpt-4.1'); const ledger = new BudgetLedger(c.storageDir, 6.7);
    for (let i = 0; i < 3; i++) ledger.reserve('file_edits', 'gpt-4.1');
    expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(6.678672, 12);
    ledger.close();
    const fake = provider(response(patch()), response({ value: 'ok' }));
    await expect(new OpenAIImplementer(c, { client: fake.client }).implement(input(c))).rejects.toThrow(/budget/);
    await expect(new StructuredGenerator(c, { client: fake.client }).generate(z.object({ value: z.string() }), 'plan', 'Fixture instructions', {})).rejects.toThrow(/budget/);
    expect(fake.parse).not.toHaveBeenCalled();
    const reopened = new BudgetLedger(c.storageDir, 6.7);
    try { expect(reopened.summary()).toEqual({ reservedOrSpentUsd: 6.678672, limitUsd: 6.7, requests: 3 }); }
    finally { reopened.close(); }
  });

  it('retains the full-model reservation after an ambiguous provider failure instead of charging the mini price', async () => {
    const c = config('gpt-4.1'); const fake = provider(); fake.parse.mockRejectedValue(new Error('Synthetic connection interruption'));
    await expect(new OpenAIImplementer(c, { client: fake.client }).implement(input(c))).rejects.toThrow('connection interruption');
    expect(fake.parse).toHaveBeenCalledTimes(1);
    const reopened = new BudgetLedger(c.storageDir, 6.7);
    try { expect(reopened.summary()).toEqual({ reservedOrSpentUsd: 2.226224, limitUsd: 6.7, requests: 1 }); }
    finally { reopened.close(); }
  });

  it('preflights the full-model price again before a bounded anchor correction', async () => {
    const c = config('gpt-4.1'); c.development!.budgetUsd = 3;
    const fake = provider(response(patch('missing original anchor', 'replacement'), false), response(patch()));
    await expect(new OpenAIImplementer(c, { client: fake.client }).implement(input(c))).rejects.toThrow(/budget/);
    expect(fake.parse).toHaveBeenCalledTimes(1);
    const ledger = new BudgetLedger(c.storageDir, 3);
    try { expect(ledger.summary()).toEqual({ reservedOrSpentUsd: 2.226224, limitUsd: 3, requests: 1 }); }
    finally { ledger.close(); }
  });
});
