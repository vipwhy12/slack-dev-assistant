import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectThread, createSlackClient, parseThreadUrl, type SlackApi, type SlackRepliesResponse } from '../src/slack.js';
import { snapshotSchema, type SlackScope } from '../src/domain.js';

const sdk = vi.hoisted(() => ({ replies: vi.fn(), permalink: vi.fn(), construct: vi.fn() }));
vi.mock('@slack/web-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slack/web-api')>();
  return { ...actual, WebClient: class {
    constructor(token: string, options: unknown) { sdk.construct(token, options); }
    conversations = { replies: sdk.replies };
    chat = { getPermalink: sdk.permalink };
  } };
});

const scope: SlackScope = { workspace: 'acme', channelIds: ['C123'] };
const root = { ts: '1732000000.000001', text: 'Add export', user: 'U123', thread_ts: '1732000000.000001', reply_count: 2 };
const reply = { ts: '1732000001.000002', text: 'CSV first', user: 'U456', thread_ts: root.ts };
const otherReply = { ts: '1732000002.000003', text: 'Include header', bot_id: 'B123', thread_ts: root.ts };
const rootUrl = `https://acme.slack.com/archives/C123/p${root.ts.replace('.', '')}`;
const sourceLink = (ts: string) => ts === root.ts ? rootUrl :
  `https://acme.slack.com/archives/C123/p${ts.replace('.', '')}?thread_ts=${root.ts}&cid=C123`;
function mockClient(pages: SlackRepliesResponse[]) {
  let pageIndex = 0;
  const replies = vi.fn(async () => pages[pageIndex++] ?? { ok: true, messages: [] });
  const getPermalink = vi.fn(async ({ message_ts }: { channel: string; message_ts: string }) => ({ ok: true, permalink: sourceLink(message_ts) }));
  const client: SlackApi = { conversations: { replies }, chat: { getPermalink } };
  return { client, replies, getPermalink };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('Slack URL scope validation', () => {
  it('retains timestamp precision and normalizes a reply permalink to its root', () => {
    expect(parseThreadUrl(sourceLink(reply.ts), scope)).toEqual({ workspace: 'acme', channelId: 'C123', messageTs: reply.ts, rootTs: root.ts });
    expect(parseThreadUrl('https://acme.slack.com/archives/C123/p99999999999999999', scope).messageTs).toBe('99999999999.999999');
  });
  it.each([
    'http://acme.slack.com/archives/C123/p1732000000000001',
    'https://evil.slack.com/archives/C123/p1732000000000001',
    'https://acme.slack.com.evil.test/archives/C123/p1732000000000001',
    'https://acme.slack.com./archives/C123/p1732000000000001',
    'https://%61cme.slack.com/archives/C123/p1732000000000001',
    'https://someone@acme.slack.com/archives/C123/p1732000000000001',
    'https://acme.slack.com:443/archives/C123/p1732000000000001',
    'https://acme.slack.com:8443/archives/C123/p1732000000000001',
    'https://acme.slack.com/archives/C999/p1732000000000001',
    'https://acme.slack.com/archives/D123/p1732000000000001',
    'https://acme.slack.com/archives/C123/p1732000000000001?cid=C999',
    'https://acme.slack.com/archives/C123/p1732000000000001?cid=C123&cid=C999',
    'https://acme.slack.com/archives/C123/p1732000000000001?thread_ts=1732000000.1',
    'https://acme.slack.com/archives/C123/p1732000000000001?thread_ts=1732000000.000001&thread_ts=1732000001.000002',
    'https://acme.slack.com/archives/C123/p1732000000000001#secret',
    'https://acme.slack.com/archives/C123/p1',
    'not-a-url',
  ])('rejects unsafe, malformed, or out-of-scope URL: %s', (url) => {
    expect(() => parseThreadUrl(url, scope)).toThrow();
  });
  it('fails closed for invalid configured workspace slugs', () => {
    expect(() => parseThreadUrl(rootUrl, { ...scope, workspace: 'acme.slack.com' })).toThrow('bare lowercase');
  });
});

describe('thread collection', () => {
  it('follows every cursor, de-duplicates messages, preserves authors and validates the snapshot', async () => {
    const { client, replies, getPermalink } = mockClient([
      { ok: true, messages: [root, reply], response_metadata: { next_cursor: 'next' } },
      { ok: true, messages: [reply, otherReply], has_more: false },
    ]);
    const result = await collectThread(rootUrl, scope, client);
    expect(replies.mock.calls).toHaveLength(2);
    expect(replies).toHaveBeenNthCalledWith(2, { channel: 'C123', ts: root.ts, limit: 15, cursor: 'next' });
    expect(result.messages.map((message) => message.ts)).toEqual([root.ts, reply.ts, otherReply.ts]);
    expect(result.messages[2]?.author).toBe('B123');
    expect(result.status).toBe('complete');
    expect(getPermalink).toHaveBeenCalledTimes(3);
    expect(snapshotSchema.parse(result)).toEqual(result);
  });
  it('starts at thread_ts when the URL is a reply permalink', async () => {
    const { client, replies } = mockClient([{ ok: true, messages: [root, reply, otherReply] }]);
    await collectThread(sourceLink(reply.ts), scope, client);
    expect(replies).toHaveBeenCalledWith({ channel: 'C123', ts: root.ts, limit: 15 });
  });
  it('discovers the parent when a reply URL has lost its query parameters', async () => {
    const { client, replies } = mockClient([
      { ok: true, messages: [reply] },
      { ok: true, messages: [root, reply, otherReply] },
    ]);
    const snapshot = await collectThread(sourceLink(reply.ts).split('?')[0]!, scope, client);
    expect(replies).toHaveBeenNthCalledWith(1, { channel: 'C123', ts: reply.ts, limit: 15 });
    expect(replies).toHaveBeenNthCalledWith(2, { channel: 'C123', ts: root.ts, limit: 15 });
    expect(snapshot.rootTs).toBe(root.ts);
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.status).toBe('complete');
  });
  it('keeps content hashes stable across collection times, and caches successful source links', async () => {
    const { client, getPermalink } = mockClient([
      { ok: true, messages: [root, reply, otherReply] },
      { ok: true, messages: [root, reply, otherReply] },
      { ok: true, messages: [root, { ...reply, text: 'CSV and JSON', edited: { ts: '1732000020.000001' } }, otherReply] },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = await collectThread(rootUrl, scope, client);
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const same = await collectThread(rootUrl, scope, client);
    const changed = await collectThread(rootUrl, scope, client);
    expect(first.collectedAt).not.toBe(same.collectedAt);
    expect(first.contentHash).toBe(same.contentHash);
    expect(first.id).toBe(same.id);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.messages[1]?.id).not.toBe(first.messages[1]?.id);
    expect(changed.messages[1]?.editedTs).toBe('1732000020.000001');
    expect(getPermalink).toHaveBeenCalledTimes(3);
  });
  it('stops cursor loops and retains the messages as partial evidence', async () => {
    const { client, replies } = mockClient([
      { ok: true, messages: [root], response_metadata: { next_cursor: 'loop' } },
      { ok: true, messages: [reply], response_metadata: { next_cursor: 'loop' } },
    ]);
    const result = await collectThread(rootUrl, scope, client);
    expect(replies).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('partial');
    expect(result.messages).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('repeated a pagination cursor');
  });
  it('marks has_more without a cursor and missing root/reply counts as incomplete', async () => {
    const first = mockClient([{ ok: true, messages: [root], has_more: true }]);
    const snapshot = await collectThread(rootUrl, scope, first.client);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.warnings.join(' ')).toContain('without a next cursor');
    expect(snapshot.warnings.join(' ')).toContain('Fewer replies');
    const second = mockClient([{ ok: true, messages: [reply] }]);
    expect((await collectThread(sourceLink(reply.ts), scope, second.client)).warnings.join(' ')).toContain('root message');
  });
  it('preserves collected messages after a subsequent API failure and removes secrets from errors', async () => {
    const { client, replies } = mockClient([{ ok: true, messages: [root], response_metadata: { next_cursor: 'next' } }]);
    replies.mockRejectedValueOnce({ data: { error: 'invalid_auth', token: 'xoxp-secret' }, message: 'xoxp-secret' });
    await expect(collectThread(rootUrl, scope, client)).rejects.toThrow('authentication failed');
    const second = mockClient([{ ok: true, messages: [root], response_metadata: { next_cursor: 'next' } }]);
    second.replies.mockImplementationOnce(async () => ({ ok: true, messages: [root], response_metadata: { next_cursor: 'next' } }));
    second.replies.mockRejectedValueOnce({ code: 'slack_webapi_request_error', message: 'Authorization: xoxp-secret' });
    const snapshot = await collectThread(rootUrl, scope, second.client);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.warnings.join(' ')).toContain('network request failed');
    expect(JSON.stringify(snapshot)).not.toContain('xoxp-secret');
  });
  it('sanitizes unknown API errors and rejects failed response bodies', async () => {
    const bad = mockClient([{ ok: false, error: 'xoxp-secret' }]);
    await expect(collectThread(rootUrl, scope, bad.client)).rejects.toThrow('Unable to collect Slack thread. Slack API request failed.');
    const missing = mockClient([{ ok: false, error: 'missing_scope' }]);
    await expect(collectThread(rootUrl, scope, missing.client)).rejects.toThrow('required scopes');
  });
  it('retains canonical evidence links on permalink failure and retries failed links on the next run', async () => {
    const { client, getPermalink } = mockClient([
      { ok: true, messages: [{ ...root, reply_count: 0 }] },
      { ok: true, messages: [{ ...root, reply_count: 0 }] },
    ]);
    getPermalink.mockRejectedValueOnce({ data: { error: 'message_not_found' } });
    const first = await collectThread(rootUrl, scope, client);
    const second = await collectThread(rootUrl, scope, client);
    expect(first.status).toBe('partial');
    expect(first.messages[0]?.permalink).toBe(rootUrl);
    expect(second.status).toBe('complete');
    expect(getPermalink).toHaveBeenCalledTimes(2);
  });
  it('does not accept mismatched source URLs from Slack responses', async () => {
    const { client, getPermalink } = mockClient([{ ok: true, messages: [{ ...root, reply_count: 0 }] }]);
    getPermalink.mockResolvedValueOnce({ ok: true, permalink: 'https://evil.example/steal' });
    const result = await collectThread(rootUrl, scope, client);
    expect(result.status).toBe('partial');
    expect(result.messages[0]?.permalink).toBe(rootUrl);
  });
  it('accepts bare reply permalinks but rejects an explicitly mismatched thread root', async () => {
    const valid = mockClient([{ ok: true, messages: [root, reply, otherReply] }]);
    valid.getPermalink.mockImplementation(async ({ message_ts }) => ({ ok: true, permalink: sourceLink(message_ts).split('?')[0]! }));
    expect((await collectThread(rootUrl, scope, valid.client)).status).toBe('complete');
    const wrongRoot = mockClient([{ ok: true, messages: [{ ...root, reply_count: 0 }] }]);
    wrongRoot.getPermalink.mockResolvedValueOnce({ ok: true, permalink: `${rootUrl}?thread_ts=1731999999.000001` });
    expect((await collectThread(rootUrl, scope, wrongRoot.client)).status).toBe('partial');
  });
  it('skips malformed runtime payloads and marks malformed cursors as partial', async () => {
    const { client } = mockClient([{
      ok: true,
      messages: [null, { ts: 1732000000, text: 'unsafe precision' }, { ...root, reply_count: 0 }],
      response_metadata: { next_cursor: 123 },
    } as unknown as SlackRepliesResponse]);
    const snapshot = await collectThread(rootUrl, scope, client);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.warnings.join(' ')).toContain('invalid pagination cursor');
  });
  it('records attachment limitations without fetching files', async () => {
    const { client } = mockClient([{ ok: true, messages: [{ ...root, reply_count: 0, files: [{ url_private: 'https://files.slack.com/secret' }] }] }]);
    const snapshot = await collectThread(rootUrl, scope, client);
    expect(snapshot.messages[0]?.hasAttachments).toBe(true);
    expect(snapshot.warnings.join(' ')).toContain('not downloaded');
    expect(JSON.stringify(snapshot)).not.toContain('url_private');
  });
  it('excludes messages from another thread and flags mid-collection edits', async () => {
    const { client } = mockClient([
      { ok: true, messages: [root, reply], response_metadata: { next_cursor: 'next' } },
      { ok: true, messages: [{ ...reply, text: 'Updated decision' }, { ...otherReply, thread_ts: '1731999999.000001' }] },
    ]);
    const snapshot = await collectThread(rootUrl, scope, client);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]?.text).toBe('Updated decision');
    expect(snapshot.warnings.join(' ')).toContain('changed during pagination');
    expect(snapshot.warnings.join(' ')).toContain('different thread');
  });
});

describe('SDK retries', () => {
  it('configures bounded transport retries and handles 429 Retry-After without an early retry', async () => {
    vi.useFakeTimers();
    sdk.replies.mockRejectedValueOnce({ code: 'slack_webapi_rate_limited_error', retryAfter: 2 });
    sdk.replies.mockResolvedValueOnce({ ok: true, messages: [] });
    const client = createSlackClient('xoxp-test');
    const pending = client.conversations.replies({ channel: 'C123', ts: root.ts, limit: 15 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sdk.replies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true, messages: [] });
    expect(sdk.replies).toHaveBeenCalledTimes(2);
    expect(sdk.construct).toHaveBeenCalledWith('xoxp-test', expect.objectContaining({
      rejectRateLimitedCalls: true, timeout: 30_000, retryConfig: expect.objectContaining({ retries: 2 }),
    }));
  });
  it('stops after two rate-limit retries', async () => {
    vi.useFakeTimers();
    sdk.replies.mockRejectedValue({ code: 'slack_webapi_rate_limited_error', retryAfter: 1 });
    const client = createSlackClient('xoxp-test');
    const pending = client.conversations.replies({ channel: 'C123', ts: root.ts, limit: 15 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'slack_webapi_rate_limited_error' });
    await vi.runAllTimersAsync();
    await rejection;
    expect(sdk.replies).toHaveBeenCalledTimes(3);
  });
  it('does not shorten a Retry-After larger than the allowed wait or retry malformed headers', async () => {
    sdk.replies.mockRejectedValue({ code: 'slack_webapi_rate_limited_error', retryAfter: 500 });
    const client = createSlackClient('xoxp-test');
    await expect(client.conversations.replies({ channel: 'C123', ts: root.ts, limit: 15 })).rejects.toMatchObject({ retryAfter: 500 });
    expect(sdk.replies).toHaveBeenCalledTimes(1);
  });
  it('does not retry authentication failures and rejects an empty token', async () => {
    sdk.replies.mockRejectedValue({ data: { error: 'invalid_auth' } });
    const client = createSlackClient('xoxp-test');
    await expect(client.conversations.replies({ channel: 'C123', ts: root.ts, limit: 15 })).rejects.toMatchObject({ data: { error: 'invalid_auth' } });
    expect(sdk.replies).toHaveBeenCalledTimes(1);
    expect(() => createSlackClient(' ')).toThrow('SLACK_TOKEN');
  });
});
