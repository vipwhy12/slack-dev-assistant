import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel } from '@slack/web-api';
import { configSchema } from '../src/config.js';
import { SlackJobStore } from '../src/slack-jobs.js';
import { SlackService, type SlackAnalysis, type SlackPlan, type SlackWorkflowBackend } from '../src/slack-service.js';
import { SlackSocketConnection, SlackSocketController, type SlackTransport } from '../src/slack-runtime.js';

const resources: Array<{ store: SlackJobStore; directory: string; controller: SlackSocketController }> = [];
const connections: SlackSocketConnection[] = [];
const thread = 'https://team.slack.com/archives/C1/p1795086841177069';
const commandBody = (text = `analyze ${thread}`) => ({ team_id: 'T1', api_app_id: 'A1', user_id: 'U1', channel_id: 'C1', command: '/duduk', text });
const interactiveIdentity = { team: { id: 'T1' }, api_app_id: 'A1', user: { id: 'U1' } };
function setup(blocking = false) {
  const directory = mkdtempSync(join(tmpdir(), 'slack-runtime-')), store = new SlackJobStore(join(directory, 'jobs.sqlite'), 'test');
  const config = { ...configSchema.parse({ projectId: 'test', model: 'test', slack: { workspace: 'team', channelIds: ['C1'] } }),
    slackApp: { teamId: 'T1', appId: 'A1', command: '/duduk', allowedUserIds: ['U1'], approverUserIds: ['U1'] } };
  const analysis: SlackAnalysis = { runId: 'run1', revisionId: 'rev1', snapshotId: 'snapshot1', draft: { summary: '날짜 접근성', requirements: [{
    id: 'R1', statement: '선택 상태를 표시한다.', decisionState: 'proposed', sourceRefs: [{ messageVersionId: 'm1', quote: '선택 상태' }],
    supersedesIds: [], blockingQuestionIds: blocking ? ['Q1'] : [], acceptanceCriteria: [],
  }], questions: blocking ? [{ id: 'Q1', text: '웹만 적용하나요?', blocking: true, affectedRequirementIds: ['R1'], sourceRefs: [] }] : [] } };
  const plan: SlackPlan = { planId: 'plan1', sourceRunId: 'run1', revisionId: 'review1', bindingHash: 'hash1', summary: '선택 상태 구현',
    affectedPaths: ['src/calendar.ts'], checks: ['web-tests'], blockers: [], repository: 'owner/repo', baseCommit: 'abc' };
  const backend = { save: vi.fn(async () => ({ summary: 'saved', factCount: 1 })), analyze: vi.fn(async () => structuredClone(analysis)),
    inspectAnalysis: vi.fn(() => structuredClone(analysis)), reviewAndPlan: vi.fn(async () => structuredClone(plan)),
    inspectPlan: vi.fn(() => structuredClone(plan)), approveAndImplement: vi.fn(async () => ({ runId: 'implementation1', prUrl: 'https://github.com/owner/repo/pull/1' })),
  } satisfies SlackWorkflowBackend;
  const service = new SlackService(config, store, backend);
  const transport = { ephemeral: vi.fn(async () => {}), message: vi.fn(async () => {}), modal: vi.fn(async () => {}) } satisfies SlackTransport;
  const log = vi.fn(), controller = new SlackSocketController(service, transport, log);
  resources.push({ directory, store, controller });
  return { service, store, backend, transport, log, controller, analysis, plan };
}
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.stop();
  for (const resource of resources.splice(0)) { await resource.controller.stop(); resource.store.close(); rmSync(resource.directory, { recursive: true, force: true }); }
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function analyze(fixture: ReturnType<typeof setup>) {
  const ack = vi.fn(async (_payload?: object) => {});
  await fixture.controller.command({ body: commandBody(), envelope_id: 'command1', ack });
  await fixture.controller.idle();
  const id = fixture.service.handleCommand({ teamId: 'T1', appId: 'A1', userId: 'U1', channelId: 'C1', command: '/duduk', text: `analyze ${thread}`, envelopeId: 'command1' }).jobId!;
  return { id, action: fixture.store.pendingAction(id)!, ack };
}
function submission(nonce: string, answer?: string) {
  return { ...interactiveIdentity, type: 'view_submission', view: { callback_id: 'sd_review_submit', private_metadata: nonce, state: { values: {
    req_selection: { value: { selected_options: [{ value: 'R1' }] } }, review_reason: { value: { value: '범위 확인' } },
    ...(answer ? { q_0: { value: { value: answer } } } : {}),
  } } } };
}

describe('SlackSocketController with durable service and fake transport', () => {
  it('acknowledges a slash command before any paid work and returns the result to its source thread', async () => {
    const fixture = setup(), events: string[] = [];
    fixture.backend.analyze.mockImplementation(async () => { events.push('analyze'); return { runId: 'empty', revisionId: 'empty', snapshotId: 'empty', draft: { summary: 'empty', requirements: [], questions: [] } }; });
    await fixture.controller.command({ body: commandBody(), envelope_id: 'event1', ack: async () => { events.push('ack'); } });
    await fixture.controller.idle();
    expect(events).toEqual(['ack', 'analyze']);
    expect(fixture.transport.message).toHaveBeenCalledWith('C1', '1795086841.177069', expect.objectContaining({ text: expect.stringContaining('awaiting_review') }));
  });
  it('acknowledges invalid commands without backend execution or posting to an unauthorized channel', async () => {
    const fixture = setup(), ack = vi.fn(async (_payload?: object) => {});
    await fixture.controller.command({ body: { ...commandBody(), channel_id: 'C9' }, envelope_id: 'event1', ack });
    await fixture.controller.idle();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral', text: expect.stringContaining('not authorized') }));
    expect(fixture.backend.analyze).not.toHaveBeenCalled();
    expect(fixture.transport.message).not.toHaveBeenCalled();
  });
  it('never reruns analysis when notification delivery fails; status recovers the approval button', async () => {
    const fixture = setup(); fixture.transport.message.mockRejectedValue(new Error('Slack unavailable'));
    const { id } = await analyze(fixture);
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining('notification failed'));
    const ack = vi.fn(async (_payload?: object) => {});
    await fixture.controller.command({ body: commandBody(`status ${id}`), envelope_id: 'status1', ack });
    await fixture.controller.idle();
    expect(fixture.backend.analyze).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ack.mock.calls)).toContain('sd_review');
  });
  it('posts to the collected true root when a command targets a reply permalink', async () => {
    const fixture = setup();
    const original = fixture.backend.analyze.getMockImplementation()!;
    fixture.backend.analyze.mockImplementation(async () => ({ ...await original(), threadTs: '1795086800.000001' }));
    await analyze(fixture);
    expect(fixture.transport.message).toHaveBeenCalledWith('C1', '1795086800.000001', expect.anything());
  });
  it('acks review buttons before opening a modal, then runs planning only after submission ack', async () => {
    const fixture = setup(), { action } = await analyze(fixture), events: string[] = [];
    fixture.transport.modal.mockImplementation(async () => { events.push('modal'); });
    await fixture.controller.interactive({ envelope_id: 'button1', ack: async () => { events.push('button-ack'); }, body: {
      ...interactiveIdentity, type: 'block_actions', channel: { id: 'C1' }, trigger_id: 'trigger1', actions: [{ action_id: 'sd_review', value: action.nonce }],
    } });
    expect(events).toEqual(['button-ack', 'modal']);
    const original = fixture.backend.reviewAndPlan.getMockImplementation()!;
    fixture.backend.reviewAndPlan.mockImplementation(async () => { events.push('plan'); return original(); });
    await fixture.controller.interactive({ envelope_id: 'view1', ack: async () => { events.push('view-ack'); }, body: submission(action.nonce) });
    await fixture.controller.idle();
    expect(events.slice(-2)).toEqual(['view-ack', 'plan']);
    expect(fixture.backend.approveAndImplement).not.toHaveBeenCalled();
  });
  it('keeps the review modal open for unresolved questions and consumes nothing', async () => {
    const fixture = setup(true), { id, action } = await analyze(fixture), ack = vi.fn(async (_payload?: object) => {});
    await fixture.controller.interactive({ envelope_id: 'view1', ack, body: submission(action.nonce) });
    await fixture.controller.idle();
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { review_reason: expect.stringContaining('blocking question') } });
    expect(fixture.store.get(id).status).toBe('awaiting_review');
    expect(fixture.store.action(action.nonce).consumedAt).toBeNull();
    expect(fixture.backend.reviewAndPlan).not.toHaveBeenCalled();
  });
  it('acknowledges forged actions but never responds to an unauthorized target', async () => {
    const fixture = setup(), { action } = await analyze(fixture), ack = vi.fn(async () => {});
    await fixture.controller.interactive({ envelope_id: 'bad1', ack, body: { ...interactiveIdentity, team: { id: 'T9' }, type: 'block_actions',
      channel: { id: 'C9' }, trigger_id: 'trigger1', actions: [{ action_id: 'sd_review', value: action.nonce }],
    } });
    expect(ack).toHaveBeenCalledOnce();
    expect(fixture.transport.modal).not.toHaveBeenCalled(); expect(fixture.transport.ephemeral).not.toHaveBeenCalled();
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
  });
  it('sends stale approval errors ephemerally to a verified user', async () => {
    const fixture = setup(), { action } = await analyze(fixture);
    fixture.backend.inspectAnalysis.mockImplementation(() => ({ runId: 'run1', revisionId: 'new-revision', snapshotId: 'snapshot1', draft: { summary: 'changed', requirements: [], questions: [] } }));
    await fixture.controller.interactive({ envelope_id: 'stale1', ack: async () => {}, body: { ...interactiveIdentity, type: 'block_actions',
      channel: { id: 'C1' }, trigger_id: 'trigger1', actions: [{ action_id: 'sd_review', value: action.nonce }],
    } });
    expect(fixture.transport.ephemeral).toHaveBeenCalledWith('C1', 'U1', { text: expect.stringContaining('Analysis changed') });
    expect(fixture.transport.modal).not.toHaveBeenCalled();
  });
});

function proposalRuntime() {
  const fixture = setup(), proposal = { analysis: fixture.analysis, plan: fixture.plan };
  const backend = Object.assign(fixture.backend, {
    prepareProposal: vi.fn(async (_thread: string, feedback?: import('../src/slack-service.js').SlackFeedbackInput) => {
      if (feedback) { proposal.analysis.revisionId = 'revision-2'; proposal.plan.bindingHash = 'binding-2'; }
      return structuredClone(proposal);
    }),
    inspectProposal: vi.fn(() => structuredClone(proposal)),
    approveProposal: vi.fn(async () => ({ runId: 'implementation2', prUrl: 'https://github.com/owner/repo/pull/2' })),
  });
  return { ...fixture, backend };
}
const proposalButton = (actionId: string, nonce: string) => ({ ...interactiveIdentity, type: 'block_actions', channel: { id: 'C1' }, trigger_id: 'trigger1', actions: [{ action_id: actionId, value: nonce }] });
const feedbackView = (nonce: string, text: string) => ({ ...interactiveIdentity, type: 'view_submission', view: { callback_id: 'sd_feedback_submit', private_metadata: nonce, state: { values: { feedback_text: { value: { value: text } } } } } });

describe('proposal Socket Mode interaction', () => {
  it('opens N feedback after acknowledgement and waits for submitted feedback acknowledgement before paid preparation', async () => {
    const fixture = proposalRuntime(), { id, action } = await analyze(fixture), events: string[] = [];
    fixture.transport.modal.mockImplementation(async () => { events.push('modal'); });
    await fixture.controller.interactive({ envelope_id: 'no-1', ack: async () => { events.push('button-ack'); }, body: proposalButton('sd_proposal_no', action.nonce) });
    await fixture.controller.idle();
    expect(events).toEqual(['button-ack', 'modal']);
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(1); expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    const feedbackNonce = fixture.store.pendingAction(id)!.nonce;
    const prepare = fixture.backend.prepareProposal.getMockImplementation()!;
    fixture.backend.prepareProposal.mockImplementation(async (...args) => { events.push('prepare'); return prepare(...args); });
    await fixture.controller.interactive({ envelope_id: 'feedback-1', ack: async () => { events.push('submission-ack'); }, body: feedbackView(feedbackNonce, '웹만 변경해 주세요.') });
    await fixture.controller.idle();
    expect(events.slice(-2)).toEqual(['submission-ack', 'prepare']);
    expect(fixture.store.get(id).status).toBe('awaiting_approval');
    expect(fixture.transport.message).toHaveBeenLastCalledWith('C1', '1795086841.177069', expect.objectContaining({ text: expect.stringContaining('기능 구현') }));
    expect(fixture.store.get(id).result).toMatchObject({ analysis: { revisionId: 'revision-2' } });
    expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
    const newNonce = fixture.store.pendingAction(id)!.nonce;
    fixture.backend.approveProposal.mockImplementation(async () => { events.push('implement'); return { runId: 'implementation2', prUrl: 'https://github.com/owner/repo/pull/2' }; });
    await fixture.controller.interactive({ envelope_id: 'yes-1', ack: async () => { events.push('yes-ack'); }, body: proposalButton('sd_proposal_yes', newNonce) });
    await fixture.controller.idle();
    expect(events.slice(-2)).toEqual(['yes-ack', 'implement']); expect(fixture.backend.approveProposal).toHaveBeenCalledTimes(1);
  });
  it('keeps invalid feedback in its modal and safely acknowledges duplicate valid submissions', async () => {
    const fixture = proposalRuntime(), { id, action } = await analyze(fixture);
    await fixture.controller.interactive({ envelope_id: 'no-1', ack: async () => {}, body: proposalButton('sd_proposal_no', action.nonce) });
    await fixture.controller.idle();
    const nonce = fixture.store.pendingAction(id)!.nonce, invalidAck = vi.fn(async (_payload?: object) => {});
    await fixture.controller.interactive({ envelope_id: 'invalid-1', ack: invalidAck, body: feedbackView(nonce, '  ') });
    expect(invalidAck).toHaveBeenCalledWith({ response_action: 'errors', errors: { feedback_text: expect.stringContaining('1–3000') } });
    expect(fixture.store.get(id).status).toBe('awaiting_feedback');
    const ack = vi.fn(async (_payload?: object) => {}), event = { envelope_id: 'feedback-1', ack, body: feedbackView(nonce, '웹만 변경') };
    await fixture.controller.interactive(event); await fixture.controller.idle();
    await fixture.controller.interactive(event); await fixture.controller.idle();
    expect(ack).toHaveBeenCalledTimes(2); expect(ack.mock.calls.every(call => call.length === 0)).toBe(true);
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(2);
  });
  it('acknowledges feedback slash commands before preparation and restores new Y/N through status after a lost notification', async () => {
    const fixture = proposalRuntime(), { id } = await analyze(fixture), events: string[] = [];
    const prepare = fixture.backend.prepareProposal.getMockImplementation()!;
    fixture.backend.prepareProposal.mockImplementation(async (...args) => { events.push('prepare'); return prepare(...args); });
    fixture.transport.message.mockRejectedValueOnce(new Error('delivery lost'));
    await fixture.controller.command({ envelope_id: 'feedback-command', ack: async () => { events.push('ack'); }, body: commandBody(`feedback ${id} 웹만 변경`) });
    await fixture.controller.idle();
    expect(events).toEqual(['ack', 'prepare']);
    const ack = vi.fn(async (_payload?: object) => {});
    await fixture.controller.command({ envelope_id: 'status2', ack, body: commandBody(`status ${id}`) });
    await fixture.controller.idle();
    expect(JSON.stringify(ack.mock.calls)).toContain('sd_proposal_yes'); expect(JSON.stringify(ack.mock.calls)).toContain('sd_proposal_no');
    expect(fixture.backend.prepareProposal).toHaveBeenCalledTimes(2); expect(fixture.backend.approveProposal).not.toHaveBeenCalled();
  });
});

class FakeSocket extends EventEmitter {
  start = vi.fn(async () => { this.emit('connected'); });
  disconnect = vi.fn(async () => { this.emit('disconnected'); });
}
function managedSocket(socket = new FakeSocket()) {
  const log = vi.fn(), connection = new SlackSocketConnection(socket, log, { baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 });
  connections.push(connection);
  return { socket, connection, log };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Socket Mode reconnect ownership without network access', () => {
  it('catches DNS reconnect failures once and preserves the in-flight durable worker job', async () => {
    vi.useFakeTimers();
    const fixture = setup(), work = deferred(), { socket, connection, log } = managedSocket();
    fixture.backend.analyze.mockImplementation(async () => { await work.promise; return structuredClone(fixture.analysis); });
    await connection.start();
    socket.start.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND slack.com'), { code: 'ENOTFOUND' }));
    await fixture.controller.command({ body: commandBody(), envelope_id: 'in-flight', ack: async () => {} });
    socket.emit('disconnected'); socket.emit('disconnected'); socket.emit('disconnected');
    await vi.advanceTimersByTimeAsync(100);
    work.resolve(); await fixture.controller.idle();
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reconnect failed (1/3)'));
    expect(fixture.backend.analyze).toHaveBeenCalledTimes(1);
    expect(fixture.transport.message).toHaveBeenCalledWith('C1', '1795086841.177069', expect.objectContaining({ text: expect.stringContaining('awaiting_review') }));
    await vi.advanceTimersByTimeAsync(200); await connection.idle();
    expect(socket.start).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('Socket Mode connection restored.');
    expect(fixture.backend.analyze).toHaveBeenCalledTimes(1);
  });
  it('caps reconnect attempts and leaves the worker process available after repeated failures', async () => {
    vi.useFakeTimers(); const { socket, connection, log } = managedSocket();
    await connection.start(); socket.start.mockRejectedValue(new Error('ENOTFOUND slack.com'));
    socket.emit('disconnected'); await vi.advanceTimersByTimeAsync(500); await connection.idle();
    expect(socket.start).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Local jobs continue'));
    socket.emit('disconnected'); await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.start).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start another connection if a connected event arrives during the retry delay', async () => {
    vi.useFakeTimers(); const { socket, connection } = managedSocket();
    await connection.start(); socket.emit('disconnected'); socket.emit('connected');
    await vi.advanceTimersByTimeAsync(100); await connection.idle();
    expect(socket.start).toHaveBeenCalledTimes(1);
  });
  it('cancels pending backoff and unregisters its own listeners on idempotent stop', async () => {
    vi.useFakeTimers(); const { socket, connection } = managedSocket();
    await connection.start(); socket.emit('disconnected');
    const first = connection.stop(); expect(connection.stop()).toBe(first); await first;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.start).toHaveBeenCalledTimes(1); expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('connected')).toBe(0); expect(socket.listenerCount('disconnected')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a reconnect that succeeds after stop and waits for its cleanup', async () => {
    vi.useFakeTimers(); const { socket, connection } = managedSocket(), opening = deferred();
    await connection.start(); socket.start.mockImplementationOnce(async () => { await opening.promise; socket.emit('connected'); });
    socket.emit('disconnected'); await vi.advanceTimersByTimeAsync(100);
    let stopped = false; const stopping = connection.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    opening.resolve(); await stopping;
    expect(stopped).toBe(true); expect(socket.start).toHaveBeenCalledTimes(2); expect(socket.disconnect).toHaveBeenCalledTimes(2);
    expect(socket.listenerCount('connected')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates initial connection failure and does not schedule a background reconnect', async () => {
    vi.useFakeTimers(); const { socket, connection } = managedSocket();
    socket.start.mockRejectedValueOnce(new Error('initial DNS failure'));
    await expect(connection.start()).rejects.toThrow('initial DNS failure');
    socket.emit('disconnected'); await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.start).toHaveBeenCalledTimes(1);
  });
  it('handles the installed SDK close and refresh paths with its automatic reconnect disabled', async () => {
    vi.useFakeTimers();
    const network = vi.fn(async () => { throw new Error('Unexpected network request'); });
    const socket = new SocketModeClient({ appToken: 'xapp-offline-test', autoReconnectEnabled: false,
      logLevel: LogLevel.ERROR, clientOptions: { fetch: network, retryConfig: { retries: 0 } } });
    const start = vi.spyOn(socket, 'start').mockImplementation(async () => { socket.emit('connected'); return { ok: true }; });
    vi.spyOn(socket, 'disconnect').mockImplementation(async () => { socket.emit('disconnected'); });
    const websocket = { disconnect: () => { socket.emit('close', websocket); } };
    Object.defineProperty(socket, 'websocket', { value: websocket, writable: true });
    const log = vi.fn(), connection = new SlackSocketConnection(socket, log, { baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 });
    connections.push(connection); await connection.start();
    start.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND slack.com'));
    socket.emit('close', websocket); await vi.advanceTimersByTimeAsync(100);
    expect(start).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledWith(expect.stringContaining('reconnect failed'));
    await vi.advanceTimersByTimeAsync(200); await connection.idle(); expect(start).toHaveBeenCalledTimes(3);
    socket.emit('ws_message', JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }), false, websocket);
    await vi.advanceTimersByTimeAsync(100); await connection.idle(); expect(start).toHaveBeenCalledTimes(4);
    expect(network).not.toHaveBeenCalled();
  });
});
