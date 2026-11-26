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
const plan: PlanDraft = { summary: 'enable', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: 'disabled', codeRefs: [{ path: 'src/app.ts', quote: 'enabled = false' }], proposedChanges: 'enable', affectedPaths: ['src/app.ts'], dependencies: [], acceptanceChecks: [], blockers: [] }], excludedRequirements: [] };
function plannedPaths(...paths: string[]): PlanDraft { return {...plan,items:[{...plan.items[0]!,affectedPaths:paths}]}; }
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
    expect(validateChanges({ summary: 'new', files: [{ path: 'tests/new.ts', content: 'export {}' }] }, plannedPaths('tests/new.ts'), context, c).files).toHaveLength(1);
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
    const { client, parse } = provider({ output_parsed: {summary:'Enable',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'}]}]} });
    await expect(new OpenAIImplementer(c, { client }).implement(input)).resolves.toEqual(changes());
    expect(parse.mock.calls[0]![0].instructions).toContain('Use Korean');
    expect(parse.mock.calls[0]![0].input).not.toContain(context.repoPath);
  });
});

describe('OpenAI surgical edits materialize into the existing whole-file contract', () => {
  const patch = () => ({summary:'Enable',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'}]}]});
  const input = (c = config(), repository = context) => ({analysis:{summary:'버튼 활성화',requirements:[],questions:[]},plan,context:repository,config:c});
  async function generate(output: unknown, options = input()) {
    const fake = provider({output_parsed:output});
    const result = await new OpenAIImplementer(options.config,{client:fake.client}).implement(options);
    return {...fake,result};
  }
  it('changes only exact anchors and returns complete file contents with the unchanged public shape', async () => {
    const {result,parse} = await generate(patch());
    expect(result).toEqual(changes());
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]![0]).toMatchObject({max_output_tokens:8192,store:false,text:{format:{name:'file_edits',strict:true}}});
    expect(parse.mock.calls[0]![0].instructions).toContain('same original file');
    expect(parse.mock.calls[0]![0].instructions).toContain('at most one bounded correction');
  });
  it('supports independent original anchors in any order without editing unrelated content', async () => {
    const repository = {...context,files:[{path:'src/app.ts',content:'prefix\nconst first = 1;\nconst second = 2;\nsuffix\n'}]};
    const output = {summary:'정확한 두 위치 변경',files:[{path:'src/app.ts',kind:'edit',replacements:[
      {old:'const second = 2;',new:'const second = 20;'}, {old:'const first = 1;',new:'const first = 10;'},
    ]}]};
    const {result} = await generate(output,input(config(),repository));
    expect(result.files[0]!.content).toBe('prefix\nconst first = 10;\nconst second = 20;\nsuffix\n');
  });
  it('preserves CRLF, Unicode and literal replacement characters without regex/substitution semantics', async () => {
    const repository = {...context,files:[{path:'src/app.ts',content:'// 원문\r\nconst label = "전";\r\n// 끝\r\n'}]};
    const output = {summary:'레이블 변경',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'const label = "전";',new:'const label = "$& $` $1 후";'}]}]};
    expect((await generate(output,input(config(),repository))).result.files[0]!.content).toBe('// 원문\r\nconst label = "$& $` $1 후";\r\n// 끝\r\n');
  });
  it('accepts explicit create and delete and permits deleting text with an empty new string', async () => {
    const {result} = await generate({summary:'파일 변경',files:[{path:'src/app.ts',kind:'delete'},{path:'tests/new.ts',kind:'create',content:'export {};\n'}]}, {...input(),plan:plannedPaths('src/app.ts','tests/new.ts')});
    expect(result.files).toEqual([{path:'src/app.ts',content:null},{path:'tests/new.ts',content:'export {};\n'}]);
    expect((await generate({summary:'주석 삭제',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'export ',new:''}]}]})).result.files[0]!.content).toBe('const enabled = false;\n');
  });
  it.each([
    ['unmatched old', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'not present',new:'x'}]}]}],
    ['empty old', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'',new:'x'}]}]}],
    ['same old and new', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled',new:'enabled'}]}]}],
    ['no replacements', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[]}]}],
    ['overlap', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'},{old:'false;',new:'true;'}]}]}],
    ['new output anchor', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'},{old:'enabled = true',new:'enabled = null'}]}]}],
    ['duplicate paths', {summary:'x',files:[...patch().files,...patch().files]}],
    ['unseen edit', {summary:'x',files:[{path:'tests/new.ts',kind:'edit',replacements:[{old:'anything',new:'x'}]}]}],
    ['unseen delete', {summary:'x',files:[{path:'tests/new.ts',kind:'delete'}]}],
    ['create existing', {summary:'x',files:[{path:'src/app.ts',kind:'create',content:'replacement'}]}],
    ['unknown operation', {summary:'x',files:[{path:'src/app.ts',kind:'shell',command:'touch /tmp/no'}]}],
    ['extra authority', {summary:'x',files:patch().files,approved:true}],
    ['old whole-file provider shape', changes()],
    ['binary new', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled',new:'a\0b'}]}]}],
    ['credential new', {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled',new:`sk-${'x'.repeat(30)}`}]}]}],
    ['credential summary', {summary:`xoxb-${'x'.repeat(30)}`,files:patch().files}],
    ['unplanned path', {summary:'x',files:[{path:'src/not-planned.ts',kind:'create',content:'export {};'}]}],
    ['traversal path', {summary:'x',files:[{path:'src/../outside',kind:'create',content:'export {};'}]}],
  ])('rejects %s, permitting only one bounded correction for anchor errors', async (name, output) => {
    const options = input(); const {client,parse} = provider({output_parsed:output});
    await expect(new OpenAIImplementer(options.config,{client}).implement(options)).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(['unmatched old','overlap','new output anchor'].includes(name) ? 2 : 1);
  });
  it.each(['same same','aaaa'])('rejects multiple or overlapping occurrences of an anchor in %s', async original => {
    const repository = {...context,files:[{path:'src/app.ts',content:original}]};
    const old = original === 'aaaa' ? 'aaa' : 'same';
    await expect(generate({summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old,new:'other'}]}]},input(config(),repository))).rejects.toThrow('ambiguous');
  });
  it('rejects omitted files, scope escape and final-content byte limits after materializing', async () => {
    await expect(generate(patch(),input(config(),{...context,omittedPaths:['src/app.ts']}))).rejects.toThrow('omitted');
    const c = config(); c.development!.writePaths = ['tests'];
    await expect(generate(patch(),input(c))).rejects.toThrow('write scope');
    const large = {summary:'x',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'false',new:'한'.repeat(100)}]}]};
    const limited = config(); limited.development!.maxFileBytes = 256;
    await expect(generate(large,input(limited))).rejects.toThrow('file size');
    limited.development!.maxFileBytes = 1000; limited.development!.maxChangeBytes = 256;
    await expect(generate(large,input(limited))).rejects.toThrow('total size');
  });
  it('can change a small rule inside a 30 KiB original with a short response', async () => {
    const original = '/* unrelated stylesheet */\n' + '.unchanged { color: black; }\n'.repeat(1100) + '.target { padding: 8px; }\n';
    const repository = {...context,files:[{path:'src/app.ts',content:original}]};
    const output = {summary:'간격 수정',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'.target { padding: 8px; }',new:'.target { padding: 12px; }'}]}]};
    const {result,parse} = await generate(output,input(config(),repository));
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(300);
    expect(Buffer.byteLength(result.files[0]!.content!)).toBeGreaterThan(30_000);
    expect(result.files[0]!.content).toBe(original.replace('padding: 8px','padding: 12px'));
    expect(parse.mock.calls[0]![0].max_output_tokens).toBe(8192);
  });
});

describe('complete planned file coverage and one bounded implementation correction', () => {
  const planned = plannedPaths('src/app.ts','tests/new.ts');
  const sourceOnly = {summary:'기능과 테스트를 추가합니다.',files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'}]}]};
  const testContent = "import { enabled } from '../src/app';\nimport { expect, it } from 'vitest';\nit('enables the approved behavior', () => expect(enabled).toBe(true));\n";
  const complete = {...sourceOnly,files:[...sourceOnly.files,{path:'tests/new.ts',kind:'create',content:testContent}]};
  const input = (c = config()) => ({analysis:{summary:'활성화와 회귀 테스트',requirements:[],questions:[]},plan:planned,context,config:c});
  const response = (output: unknown) => ({status:'completed',output:[],output_parsed:output,usage:{input_tokens:100,output_tokens:20,total_tokens:120}});
  it('rejects a CSS/source-only change even when the summary claims the planned tests were added', () => {
    expect(() => validateChanges(changes(),planned,context,config())).toThrow('missing planned files: tests/new.ts');
    const existingTest = {...context,files:[...context.files,{path:'tests/new.ts',content:testContent}]};
    expect(() => validateChanges({...changes(),files:[...changes().files,{path:'tests/new.ts',content:testContent}]},planned,existingTest,config())).toThrow('no change');
  });
  it('repairs a missing planned test once, returning complete validated file content and aggregating both reservations', async () => {
    const options = input(); const fake = provider(); fake.parse.mockReset().mockResolvedValueOnce(response(sourceOnly)).mockResolvedValueOnce(response(complete));
    const implementer = new OpenAIImplementer(options.config,{client:fake.client});
    const result = await implementer.implement(options);
    expect(result.files.map(file=>file.path)).toEqual(['src/app.ts','tests/new.ts']);
    expect(result.files[1]!.content).toBe(testContent);
    expect(fake.parse).toHaveBeenCalledTimes(2); expect(implementer.promptVersion).toBe('implementation-v3');
    const first = JSON.parse(fake.parse.mock.calls[0]![0].input), second = JSON.parse(fake.parse.mock.calls[1]![0].input);
    expect(first.expectedChangedPaths).toEqual(['src/app.ts','tests/new.ts']);
    const {correction,...sameSource} = second; expect(sameSource).toEqual(first);
    expect(correction.validationError).toContain('missing planned files: tests/new.ts');
    expect(correction.invalidEdits).toEqual(sourceOnly);
    expect(fake.parse.mock.calls[1]![0]).toMatchObject({max_output_tokens:8192,store:false,text:{format:{name:'file_edits_repair'}}});
    expect(fake.parse.mock.calls[1]![0].instructions).toContain('only correction attempt');
    expect(fake.parse.mock.calls[1]![0].instructions).toContain('meaningful tests required by the approved plan');
    expect(implementer.usage).toMatchObject({inputTokens:200,outputTokens:40,totalTokens:240});
    expect(implementer.usage?.attempts).toHaveLength(2);
    expect(implementer.usage?.attempts?.[0]?.reservationId).not.toBe(implementer.usage?.attempts?.[1]?.reservationId);
    const ledger = new BudgetLedger(options.config.storageDir); try {expect(ledger.summary()).toMatchObject({requests:2});expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(0.000144);} finally {ledger.close();}
  });
  it.each(['missing','mismatch','ambiguous','overlap'])('repairs only one %s error using the original file', async kind => {
    const options = input();
    let broken: unknown = sourceOnly;
    if(kind==='mismatch') broken = {...complete,files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'wrong original',new:'fixed'}]},complete.files[1]!]};
    if(kind==='ambiguous') {
      options.context={...context,files:[{path:'src/app.ts',content:'export const enabled = false;\n// false\n'}]};
      broken={...complete,files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'false',new:'true'}]},complete.files[1]!]};
    }
    if(kind==='overlap') broken={...complete,files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'enabled = false',new:'enabled = true'},{old:'false;',new:'true;'}]},complete.files[1]!]};
    const fake=provider();fake.parse.mockReset().mockResolvedValueOnce(response(broken)).mockResolvedValueOnce(response(complete));
    await expect(new OpenAIImplementer(options.config,{client:fake.client}).implement(options)).resolves.toMatchObject({files:[{path:'src/app.ts'},{path:'tests/new.ts'}]});
    expect(fake.parse).toHaveBeenCalledTimes(2);
  });
  it('stops after a second invalid output and rejects a repair that expands scope', async () => {
    const options=input();const repeat=provider({output_parsed:sourceOnly});
    await expect(new OpenAIImplementer(options.config,{client:repeat.client}).implement(options)).rejects.toThrow('missing planned files');
    expect(repeat.parse).toHaveBeenCalledTimes(2);
    const escaped=provider();escaped.parse.mockReset().mockResolvedValueOnce(response(sourceOnly)).mockResolvedValueOnce(response({...complete,files:[...complete.files,{path:'src/unapproved.ts',kind:'create',content:'export {};'}]}));
    await expect(new OpenAIImplementer(options.config,{client:escaped.client}).implement(options)).rejects.toThrow('write scope');
    expect(escaped.parse).toHaveBeenCalledTimes(2);
  });
  it('does not call a repair when another reservation cannot fit in the budget', async () => {
    const options=input();options.config.development!.budgetUsd=0.5;
    const fake=provider({output_parsed:sourceOnly}); // Unknown usage keeps the first full reservation.
    await expect(new OpenAIImplementer(options.config,{client:fake.client}).implement(options)).rejects.toThrow('API budget would be exceeded');
    expect(fake.parse).toHaveBeenCalledTimes(1);
    const ledger=new BudgetLedger(options.config.storageDir,0.5);try {expect(ledger.summary().requests).toBe(1);} finally {ledger.close();}
  });
  it('never retries provider/schema/credential/scope errors, including errors beside a repairable anchor', async () => {
    const options=input();const failed=provider();failed.parse.mockRejectedValue(new Error('500 provider'));
    await expect(new OpenAIImplementer(options.config,{client:failed.client}).implement(options)).rejects.toThrow('500 provider');expect(failed.parse).toHaveBeenCalledTimes(1);
    const invalids=[{...complete,approved:true}, {...complete,summary:`sk-${'x'.repeat(30)}`},
      {...complete,files:[{path:'src/app.ts',kind:'edit',replacements:[{old:'wrong',new:'x'}]},{path:'src/outside-plan.ts',kind:'create',content:'export {};'}]}];
    for(const output of invalids){const fake=provider({output_parsed:output});await expect(new OpenAIImplementer(options.config,{client:fake.client}).implement(options)).rejects.toThrow();expect(fake.parse).toHaveBeenCalledTimes(1);}
  });
  it('freezes approved inputs so a correction cannot inherit an in-flight caller scope mutation', async () => {
    const options=input();options.plan=structuredClone(planned);options.context=structuredClone(context);
    const fake=provider();fake.parse.mockReset().mockImplementationOnce(async()=>{options.plan.items[0]!.affectedPaths.push('src/outside-plan.ts');options.context.files[0]!.content='mutated outside generation';return response(sourceOnly);}).mockResolvedValueOnce(response(complete));
    const result=await new OpenAIImplementer(options.config,{client:fake.client}).implement(options);
    expect(result.files[0]!.content).toBe(changes().files[0]!.content);
    const second=JSON.parse(fake.parse.mock.calls[1]![0].input);
    expect(second.expectedChangedPaths).toEqual(['src/app.ts','tests/new.ts']);expect(second.repository.files[0].content).toBe(context.files[0]!.content);
  });
});
