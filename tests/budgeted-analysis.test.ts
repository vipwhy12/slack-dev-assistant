import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BudgetedAnalyzer } from '../src/budgeted-analysis.js';
import type { AnalysisDraft } from '../src/analysis.js';
import type { ProjectConfig } from '../src/config.js';
import { snapshotContentHash, type ThreadSnapshot } from '../src/domain.js';
import { BudgetLedger, type GenerationClient } from '../src/generation.js';
import type { KnowledgeDraft } from '../src/knowledge.js';
import { saveKnowledge } from '../src/knowledge-workflow.js';
import { analyzeThread } from '../src/workflow.js';

let directory: string;
let config: ProjectConfig;
const url = 'https://example.slack.com/archives/CONE/p1795046400000001';
function snapshot(channelId = 'CONE', text = '버튼을 추가한다.', id = 'current-message'): ThreadSnapshot {
  const value: ThreadSnapshot = {id: 'snapshot', workspace: 'example', channelId, rootTs: '1795046400.000001',
    collectedAt: '2026-11-19T03:00:00.000Z', status: 'complete', warnings: [], contentHash: 'pending', messages: [
      {id, ts: '1795046400.000001', text, author: 'PRIVATE_AUTHOR_ID', editedTs: null, hasAttachments: false,
        permalink: `https://example.slack.com/archives/${channelId}/p1795046400000001`},
    ]};
  return {...value, contentHash: snapshotContentHash(value)};
}
const draft: AnalysisDraft = {title: '버튼 추가', summary: '버튼 추가', requirements: [{id: 'R1', statement: '버튼을 추가한다.', decisionState: 'proposed',
  sourceRefs: [{messageVersionId: 'current-message', quote: '버튼을 추가한다.'}], supersedesIds: [], blockingQuestionIds: [], acceptanceCriteria: []}], questions: []};
function client(output: unknown = draft) {
  const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({status: 'completed', output_parsed: output, output: [], usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}});
  return {parse, client: {responses: {parse}}};
}
async function save(channel = 'CONE', count = 1, statement = '프로젝트 용어는 아직 검토하지 않았습니다.') {
  const source = snapshot(channel, '원문 근거입니다. 나머지 메시지 본문은 불필요합니다.', `knowledge-${channel}`);
  const knowledge: KnowledgeDraft = {summary: '저장한 용어', items: Array.from({length: count}, (_, index) => ({id: `K${index}`, kind: 'term',
    key: `term.${index}`, title: `용어 ${index}`, statement, certainty: 'uncertain', evidence: [{messageVersionId: source.messages[0]!.id, quote: '원문 근거입니다.'}]})), relationships: [], uncertainties: ['확인 필요']};
  return saveKnowledge({config, threadUrl: source.messages[0]!.permalink, collect: async () => source,
    extractor: {name: 'fixture', model: 'offline', promptVersion: statement, extract: async () => knowledge}});
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'budgeted-analysis-'));
  config = {projectId: 'test', slack: {workspace: 'example', channelIds: ['CONE', 'CTWO']}, storageDir: directory, model: 'gpt-4.1-mini'};
});
afterEach(() => rmSync(directory, {recursive: true, force: true}));

describe('budgeted analysis and supplemental knowledge boundaries', () => {
  it('works without development settings and only includes same-channel unreviewed context with exact citations', async () => {
    await save('CONE'); await save('CTWO', 1, '다른 채널 전용 정보');
    const fake = client(); const analyzer = new BudgetedAnalyzer(config, url, {client: fake.client});
    await expect(analyzer.analyze(snapshot())).resolves.toEqual(draft);
    const request = fake.parse.mock.calls[0]![0];
    expect(request).toMatchObject({store: false, max_output_tokens: 8192});
    const input = JSON.parse(request.input) as {supplementalKnowledge: Array<{state: string; reviewState: string; evidence: unknown[]}>};
    expect(input.supplementalKnowledge).toHaveLength(1);
    expect(input.supplementalKnowledge[0]).toMatchObject({state: 'uncertain', reviewState: 'unreviewed', evidence: [{messageVersionId: 'knowledge-CONE', quote: '원문 근거입니다.'}]});
    expect(request.input).not.toContain('다른 채널 전용 정보');
    expect(request.input).not.toContain('PRIVATE_AUTHOR_ID');
    expect(request.input).not.toContain('나머지 메시지 본문은 불필요합니다.');
    expect(request.input).not.toContain(directory);
    expect(request.instructions).toContain('never an approval or authoritative requirement');
    expect(request.instructions).toContain('Every sourceRef must still cite an exact quote from messages in the current snapshot');
    const ledger = new BudgetLedger(directory); try { expect(ledger.summary()).toMatchObject({limitUsd: 10, requests: 1}); } finally {ledger.close();}
  });
  it('caps supplemental context at 20 items and 32 KiB independently of source size', async () => {
    await save('CONE', 30, '지'.repeat(6000));
    const analyzer = new BudgetedAnalyzer(config, url, {client: client().client});
    expect(analyzer.knowledgeContext.length).toBeLessThanOrEqual(20);
    expect(analyzer.knowledgeContext.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(analyzer.knowledgeContext))).toBeLessThanOrEqual(32_768);
  });
  it('binds cache identity to current same-channel knowledge and reuses unchanged inputs without another paid call', async () => {
    await save();
    const fake = client();
    const firstAnalyzer = new BudgetedAnalyzer(config, url, {client: fake.client});
    const first = await analyzeThread({config, threadUrl: url, collect: async () => snapshot(), analyzer: firstAnalyzer});
    await save('CTWO', 1, '타 채널 변경');
    const sameAnalyzer = new BudgetedAnalyzer(config, url, {client: fake.client});
    expect(sameAnalyzer.promptVersion).toBe(firstAnalyzer.promptVersion);
    const same = await analyzeThread({config, threadUrl: url, collect: async () => snapshot(), analyzer: sameAnalyzer});
    expect(same).toMatchObject({runId: first.runId, reused: true});
    expect(fake.parse).toHaveBeenCalledTimes(1);
    await save('CONE', 1, '같은 채널의 변경된 정보');
    const changedAnalyzer = new BudgetedAnalyzer(config, url, {client: fake.client});
    expect(changedAnalyzer.promptVersion).not.toBe(firstAnalyzer.promptVersion);
    expect((await analyzeThread({config, threadUrl: url, collect: async () => snapshot(), analyzer: changedAnalyzer})).reused).toBe(false);
    expect(fake.parse).toHaveBeenCalledTimes(2);
  });
  it('keeps the supplemental snapshot immutable when a caller mutates its returned view', async () => {
    await save(); const fake = client(); const analyzer = new BudgetedAnalyzer(config, url, {client: fake.client});
    const before = JSON.stringify(analyzer.knowledgeContext);
    const view = analyzer.knowledgeContext;
    (view as unknown[]).push({statement: 'unbound change'});
    const first = view[0] as {statement: string; evidence: Array<{quote: string}>};
    first.statement = 'unbound change'; first.evidence[0]!.quote = 'unbound quote';
    expect(JSON.stringify(analyzer.knowledgeContext)).toBe(before);
    await analyzer.analyze(snapshot());
    expect(fake.parse.mock.calls[0]![0].input).not.toContain('unbound');
  });
  it('rejects references to supplemental knowledge as current-thread evidence', async () => {
    await save(); const output = structuredClone(draft);
    output.requirements[0]!.sourceRefs = [{messageVersionId: 'knowledge-CONE', quote: '원문 근거입니다.'}];
    const fake = client(output);
    await expect(new BudgetedAnalyzer(config, url, {client: fake.client}).analyze(snapshot())).rejects.toThrow('Unknown evidence');
  });
  it('rejects credential-shaped values in the current thread and stored context before calling a provider', async () => {
    const fake = client(); const source = snapshot('CONE', `xoxb-${'A'.repeat(24)}`);
    await expect(new BudgetedAnalyzer(config, url, {client: fake.client}).analyze(source)).rejects.toThrow('credential');
    await save();
    const db = new DatabaseSync(join(directory, 'knowledge.sqlite'));
    try {db.prepare('UPDATE knowledge_items SET statement=?').run(`ghp_${'A'.repeat(24)}`);} finally {db.close();}
    await expect(new BudgetedAnalyzer(config, url, {client: fake.client}).analyze(snapshot())).rejects.toThrow('credential');
    expect(fake.parse).not.toHaveBeenCalled();
    const ledger = new BudgetLedger(directory); try {expect(ledger.summary().requests).toBe(0);} finally {ledger.close();}
  });
  it('rejects model-generated approval fields and oversized current context', async () => {
    await expect(new BudgetedAnalyzer(config, url, {client: client({...draft, approved: true}).client}).analyze(snapshot())).rejects.toThrow();
    const fake = client();
    await expect(new BudgetedAnalyzer(config, url, {client: fake.client}).analyze(snapshot('CONE', 'x'.repeat(230_000)))).rejects.toThrow('context limit');
    expect(fake.parse).not.toHaveBeenCalled();
  });
});

describe('one bounded correction for exact source evidence only', () => {
  const response = (output: unknown, usage = {input_tokens:100,output_tokens:20,total_tokens:120}) => ({status:'completed',output_parsed:output,output:[],usage});
  function invalid() {
    const output = structuredClone(draft);
    output.requirements[0]!.sourceRefs[0]!.quote = '버튼을 추가하세요.';
    return output;
  }
  it('corrects one invalid quote with the identical source and records both budgeted requests', async () => {
    const fake = client(); fake.parse.mockReset().mockResolvedValueOnce(response(invalid())).mockResolvedValueOnce(response(draft));
    const analyzer = new BudgetedAnalyzer(config,url,{client:fake.client});
    await expect(analyzer.analyze(snapshot())).resolves.toEqual(draft);
    expect(fake.parse).toHaveBeenCalledTimes(2);
    expect(analyzer.promptVersion).toContain('budgeted-v5');
    const first = JSON.parse(fake.parse.mock.calls[0]![0].input), second = JSON.parse(fake.parse.mock.calls[1]![0].input);
    const {correction,...source} = second;
    expect(source).toEqual(first); expect(correction.invalidDraft).toEqual(invalid());
    expect(correction.validationError).toContain('Evidence quote does not match');
    expect(fake.parse.mock.calls[1]![0]).toMatchObject({max_output_tokens:8192,store:false,text:{format:{name:'slack_requirements_repair'}}});
    expect(fake.parse.mock.calls[1]![0].instructions).toContain('only correction attempt');
    expect(fake.parse.mock.calls[1]![0].instructions).toContain('untrusted diagnostic data');
    expect(analyzer.usage).toMatchObject({inputTokens:200,outputTokens:40,totalTokens:240});
    const usage = analyzer.usage as {attempts:Array<{reservationId:string}>};
    expect(usage.attempts).toHaveLength(2); expect(usage.attempts[0]!.reservationId).not.toBe(usage.attempts[1]!.reservationId);
    const ledger = new BudgetLedger(directory); try {expect(ledger.summary().requests).toBe(2);expect(ledger.summary().reservedOrSpentUsd).toBeCloseTo(0.000144);} finally {ledger.close();}
  });
  it('permits one correction of an unknown message ID but never accepts evidence outside the snapshot', async () => {
    const output = structuredClone(draft); output.requirements[0]!.sourceRefs[0]!.messageVersionId = 'not-in-this-thread';
    const fake = client(); fake.parse.mockReset().mockResolvedValueOnce(response(output)).mockResolvedValueOnce(response(draft));
    await expect(new BudgetedAnalyzer(config,url,{client:fake.client}).analyze(snapshot())).resolves.toEqual(draft);
    expect(fake.parse).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fake.parse.mock.calls[1]![0].input).correction.validationError).toContain('Unknown evidence');
  });
  it('stops after two invalid drafts without string normalization or a third model request', async () => {
    const fake = client(invalid());
    await expect(new BudgetedAnalyzer(config,url,{client:fake.client}).analyze(snapshot())).rejects.toThrow('Evidence quote does not match');
    expect(fake.parse).toHaveBeenCalledTimes(2);
    const ledger = new BudgetLedger(directory); try {expect(ledger.summary().requests).toBe(2);} finally {ledger.close();}
  });
  it('does not call the provider for correction if the next conservative reservation exceeds the budget', async () => {
    // The first response has unknown usage, retaining its full reservation; a second cannot fit in $0.50.
    const constrained = {...config,development:{budgetUsd:0.5} as ProjectConfig['development']};
    const fake = client(); fake.parse.mockResolvedValue({status:'completed',output_parsed:invalid(),output:[]});
    await expect(new BudgetedAnalyzer(constrained,url,{client:fake.client}).analyze(snapshot())).rejects.toThrow('API budget would be exceeded');
    expect(fake.parse).toHaveBeenCalledTimes(1);
    const ledger = new BudgetLedger(directory,0.5); try {expect(ledger.summary().requests).toBe(1);} finally {ledger.close();}
  });
  it('never retries network/provider failures, malformed schema, or other analysis invariants', async () => {
    const fake = client(); fake.parse.mockRejectedValue(new Error('500 provider failure'));
    await expect(new BudgetedAnalyzer(config,url,{client:fake.client}).analyze(snapshot())).rejects.toThrow('500 provider failure');
    expect(fake.parse).toHaveBeenCalledTimes(1);
    const malformed = client({...draft,approved:true});
    await expect(new BudgetedAnalyzer(config,url,{client:malformed.client}).analyze(snapshot())).rejects.toThrow();
    expect(malformed.parse).toHaveBeenCalledTimes(1);
    const duplicate = structuredClone(draft); duplicate.requirements.push(structuredClone(duplicate.requirements[0]!));
    const other = client(duplicate);
    await expect(new BudgetedAnalyzer(config,url,{client:other.client}).analyze(snapshot())).rejects.toThrow();
    expect(other.parse).toHaveBeenCalledTimes(1);
  });
  it('never retries a correction request that itself fails at the provider', async () => {
    const fake = client(); fake.parse.mockReset().mockResolvedValueOnce(response(invalid())).mockRejectedValueOnce(new Error('500 on repair'));
    const analyzer = new BudgetedAnalyzer(config,url,{client:fake.client});
    await expect(analyzer.analyze(snapshot())).rejects.toThrow('500 on repair');
    expect(fake.parse).toHaveBeenCalledTimes(2);
    expect(analyzer.usage).toMatchObject({inputTokens:100,outputTokens:20,totalTokens:120,attempts:[expect.objectContaining({inputTokens:100}),null]});
  });
  it('freezes the source so an in-flight caller mutation cannot replace the validation evidence', async () => {
    const source = snapshot(); const fake = client();
    fake.parse.mockReset().mockImplementationOnce(async () => {source.messages[0]!.text='호출 중 변경';return response(invalid());}).mockResolvedValueOnce(response(draft));
    await expect(new BudgetedAnalyzer(config,url,{client:fake.client}).analyze(source)).resolves.toEqual(draft);
    expect(JSON.parse(fake.parse.mock.calls[1]![0].input).messages[0].text).toBe('버튼을 추가한다.');
  });
});

describe('latest feedback restrictions remain source requirements', () => {
  it('instructs file allowlists and prohibitions to survive extraction and validates their real feedback evidence', async () => {
    const restriction = '변경 파일은 src/filter.css와 tests/filter.test.ts로 한정하고 Filter.tsx의 기능 코드는 수정하지 마세요.';
    const source = snapshot();
    source.messages.push({id:'latest-feedback',ts:'1795046401.000001',text:`사용자 수정 의견: ${restriction}`,author:'UBOT',editedTs:null,hasAttachments:false,
      permalink:'https://example.slack.com/archives/CONE/p1795046401000001?thread_ts=1795046400.000001&cid=CONE'});
    source.contentHash = snapshotContentHash(source);
    const revised = structuredClone(draft);
    revised.requirements.push({id:'R2',statement:restriction,decisionState:'proposed',sourceRefs:[{messageVersionId:'latest-feedback',quote:restriction}],
      supersedesIds:[],blockingQuestionIds:[],acceptanceCriteria:[]});
    const previousProposal = {analysis:{runId:'previous',revisionId:'old-revision',snapshotId:'old-snapshot',draft}};
    const fake = client(revised);
    const analyzer = new BudgetedAnalyzer(config,url,{client:fake.client,feedback:{entries:[{id:'command:latest',actor:'UAPPROVER',text:restriction,
      messageVersionId:'latest-feedback',previousRunId:'previous',previousRevisionId:'old-revision',previousPlanId:'old-plan'}],previousProposal}});
    const result = await analyzer.analyze(source);
    expect(result.requirements[1]).toMatchObject({statement:restriction,decisionState:'proposed',sourceRefs:[{messageVersionId:'latest-feedback',quote:restriction}]});
    const request = fake.parse.mock.calls[0]![0];
    expect(request.instructions).toContain('each named file path and each prohibition explicitly');
    expect(request.instructions).toContain('takes precedence over stale assumptions and proposed file targets in PreviousProposal');
    expect(request.instructions).toContain('Mentioning these constraints only in summary');
    expect(JSON.parse(request.input).userFeedback.entries[0].text).toBe(restriction);
    expect(fake.parse).toHaveBeenCalledTimes(1);
  });
});
