import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackFeedbackStore, feedbackEcho, type FeedbackInput, type FeedbackContext } from '../src/slack-feedback.js';
import { BudgetedAnalyzer } from '../src/budgeted-analysis.js';
import { ANALYSIS_PROMPT_VERSION, type AnalysisDraft } from '../src/analysis.js';
import { configSchema } from '../src/config.js';
import { snapshotContentHash, type ThreadSnapshot } from '../src/domain.js';
import type { GenerationClient } from '../src/generation.js';

let directory: string;
const input: FeedbackInput = { id: 'command:example-envelope-hash', teamId: 'TONE', appId: 'AONE', workspace: 'example', channelId: 'CONE', rootTs: '1795046400.000001',
  actor: 'UAPPROVER', text: '레이블만 바꾸고 동작은 유지해 주세요.', previousRunId: 'analysis1', previousRevisionId: 'revision1', previousPlanId: 'plan1', previousProposalHash: 'bound-proposal', botUserId: 'UBOT', botId: 'BBOT' };
function withStore<T>(action: (store: SlackFeedbackStore) => T, projectId = 'one') {
  const store = new SlackFeedbackStore(join(directory, 'feedback.sqlite'), projectId);
  try { return action(store); } finally { store.close(); }
}
beforeEach(() => {directory = mkdtempSync(join(tmpdir(), 'slack-feedback-'));});
afterEach(() => rmSync(directory, {recursive:true,force:true}));

describe('durable Slack feedback provenance', () => {
  it('commits a posting marker before external delivery and blocks restart replay until a valid receipt exists', () => {
    expect(withStore(store => store.begin(input))).toMatchObject({shouldPost:true,record:{status:'posting',actor:'UAPPROVER',previousRevisionId:'revision1'}});
    expect(() => withStore(store => store.begin(input))).toThrow('Automatic repost is blocked');
    expect(withStore(store => store.list(input))).toEqual([]);
    withStore(store => store.posted(input.id, '1795046401.000001'));
    expect(withStore(store => store.begin(input))).toMatchObject({shouldPost:false,record:{status:'posted',postedTs:'1795046401.000001'}});
    withStore(store => store.linked(input.id, 'REAL_SLACK_VERSION'));
    expect(withStore(store => store.get(input.id))).toMatchObject({status:'linked',messageVersionId:'REAL_SLACK_VERSION',echoText:feedbackEcho(input)});
  });
  it('binds duplicate identities to exactly the original actor/text/thread/app/previous proposal', () => {
    withStore(store => {store.begin(input);store.posted(input.id,'1795046401.000001');});
    for (const changed of [{actor:'UOTHER'},{text:'다른 요청'},{channelId:'CTWO'},{rootTs:'1795046409.000001'},{appId:'ATWO'},{previousRevisionId:'revision2'},{previousProposalHash:'new-proposal'}]) {
      expect(() => withStore(store => store.begin({...input,...changed}))).toThrow('already bound');
    }
    expect(withStore(store => store.list(input))).toHaveLength(1);
  });
  it('does not expose another project/team/app/channel/thread provenance or uncertain posts', () => {
    withStore(store => {store.begin(input);store.posted(input.id,'1795046401.000001');});
    expect(withStore(store => store.get(input.id),'foreign')).toBeUndefined();
    for (const changed of [{teamId:'TTWO'},{appId:'ATWO'},{workspace:'another'},{channelId:'CTWO'},{rootTs:'1795046409.000001'}]) expect(withStore(store => store.list({...input,...changed}))).toEqual([]);
    withStore(store => {store.begin({...input,id:'view:uncertain'});store.uncertain('view:uncertain');});
    expect(() => withStore(store => store.begin({...input,id:'view:uncertain'}))).toThrow('Automatic repost is blocked');
    expect(withStore(store => store.list(input))).toHaveLength(1);
  });
  it('requires exact source-version identity and cannot bind the same Slack receipt to two feedback commands', () => {
    withStore(store => {store.begin(input);store.posted(input.id,'1795046401.000001');store.linked(input.id,'VERSION1');store.linked(input.id,'VERSION1');});
    expect(() => withStore(store => store.linked(input.id,'VERSION2'))).toThrow('source version changed');
    withStore(store => store.begin({...input,id:'view:duplicate-receipt'}));
    expect(() => withStore(store => store.posted('view:duplicate-receipt','1795046401.000001'))).toThrow('UNIQUE');
    expect(() => withStore(store => store.posted(input.id,'1795046401.000001'))).toThrow('not waiting');
  });
  it('requires bounded feedback and a real app identity before marking a post pending', () => {
    for (const changed of [{id:'bad\nidentity'},{text:''},{text:'a'.repeat(3001)},{actor:'BOT'},{botId:null,botUserId:null},{rootTs:'1795046400.1'}]) expect(() => withStore(store => store.begin({...input,...changed}))).toThrow();
    expect(withStore(store => store.get(input.id))).toBeUndefined();
  });
});

describe('feedback analysis provenance and cache binding', () => {
  const url = 'https://example.slack.com/archives/CONE/p1795046400000001';
  const draft: AnalysisDraft = { title:'레이블 변경',summary:'레이블만 변경',requirements:[{id:'R1',statement:input.text,decisionState:'proposed',sourceRefs:[{messageVersionId:'F1',quote:input.text}],supersedesIds:[],blockingQuestionIds:[],acceptanceCriteria:[]}],questions:[] };
  const entry: FeedbackContext = {id:input.id,actor:input.actor,text:input.text,messageVersionId:'F1',previousRunId:input.previousRunId,previousRevisionId:input.previousRevisionId,previousPlanId:input.previousPlanId};
  function snapshot(): ThreadSnapshot {
    const source: ThreadSnapshot = {id:'snapshot',workspace:'example',channelId:'CONE',rootTs:'1795046400.000001',collectedAt:'2026-11-26T03:00:00.000Z',status:'complete',warnings:[],contentHash:'pending',messages:[
      {id:'M1',ts:'1795046400.000001',text:'버튼 레이블을 바꿉니다.',author:'UREQUESTER',editedTs:null,hasAttachments:false,permalink:url},
      {id:'F1',ts:'1795046401.000001',text:feedbackEcho(input),author:'UBOT',editedTs:null,hasAttachments:false,permalink:'https://example.slack.com/archives/CONE/p1795046401000001?thread_ts=1795046400.000001&cid=CONE'},
    ]};
    return {...source,contentHash:snapshotContentHash(source)};
  }
  function fixture() {
    const config = configSchema.parse({projectId:'one',storageDir:directory,model:'gpt-4.1-mini',slack:{workspace:'example',channelIds:['CONE']}});
    const wire = {...draft,requirements:draft.requirements.map(requirement=>({...requirement,sourceRefs:[{messageVersionId:'F1',startLine:3,endLine:3}]}))};
    const parse = vi.fn<GenerationClient['responses']['parse']>().mockResolvedValue({status:'completed',output_parsed:wire,output:[],usage:{input_tokens:100,output_tokens:10,total_tokens:110}});
    return {config,parse,client:{responses:{parse}}};
  }
  it('preserves exact echo source links and separates authenticated feedback from prior generated proposals', async () => {
    const {config,parse,client} = fixture();
    const previousProposal = {analysis:{runId:'old-run',revisionId:'old-revision',snapshotId:'old-snapshot',draft}};
    const analyzer = new BudgetedAnalyzer(config,url,{client,feedback:{entries:[entry],previousProposal}});
    await expect(analyzer.analyze(snapshot())).resolves.toEqual(draft);
    const request = parse.mock.calls[0]![0];
    expect(JSON.parse(request.input).userFeedback).toEqual({entries:[entry],previousProposal});
    expect(request.instructions).toContain('earlier model draft, not source evidence or approval');
    expect(request.instructions).toContain('never treat feedback as implementation permission');
    expect(analyzer.promptVersion).toContain(ANALYSIS_PROMPT_VERSION);
  });
  it('refuses metadata that points outside the exact collected source before provider invocation', async () => {
    const {config,parse,client} = fixture();
    for (const change of [{messageVersionId:'UNKNOWN'},{text:'인용되지 않은 수정 의견'}]) {
      await expect(new BudgetedAnalyzer(config,url,{client,feedback:{entries:[{...entry,...change}]}}).analyze(snapshot())).rejects.toThrow('provenance');
    }
    expect(parse).not.toHaveBeenCalled();
  });
  it('freezes feedback metadata and binds actor, text and prior revisions into the analysis cache identity', async () => {
    const {config,parse,client} = fixture(); const feedback = {entries:[structuredClone(entry)]};
    const analyzer = new BudgetedAnalyzer(config,url,{client,feedback}); const originalVersion = analyzer.promptVersion;
    feedback.entries[0]!.actor = 'UOTHER';
    expect(new BudgetedAnalyzer(config,url,{client,feedback}).promptVersion).not.toBe(originalVersion);
    await analyzer.analyze(snapshot());
    expect(JSON.parse(parse.mock.calls[0]![0].input).userFeedback.entries[0].actor).toBe('UAPPROVER');
    expect(new BudgetedAnalyzer(config,url,{client,feedback:{entries:[]}}).promptVersion).not.toBe(originalVersion);
  });
});
