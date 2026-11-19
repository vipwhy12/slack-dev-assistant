import { WebClient, LogLevel } from '@slack/web-api';
import { hash, snapshotContentHash, snapshotSchema, timestampSchema, type MessageVersion, type SlackScope, type ThreadSnapshot } from './domain.js';

export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  reply_count?: number;
  edited?: { ts?: string };
  files?: unknown[];
  attachments?: unknown[];
}
export interface SlackRepliesResponse {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}
export interface SlackPermalinkResponse { ok?: boolean; error?: string; permalink?: string }
export interface SlackApi {
  conversations: { replies(args: { channel: string; ts: string; cursor?: string; limit: number }): Promise<SlackRepliesResponse> };
  chat: { getPermalink(args: { channel: string; message_ts: string }): Promise<SlackPermalinkResponse> };
}

const PAGE_LIMIT = 15;
const MAX_PAGES = 1_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 120;
const permalinkCaches = new WeakMap<SlackApi, Map<string, string>>();

/** Parse without ever converting Slack's microsecond timestamps to numbers. */
export function parseThreadUrl(input: string, scope: SlackScope): { workspace: string; channelId: string; messageTs: string; rootTs: string } {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.workspace)) {
    throw new Error('Slack workspace must be a bare lowercase workspace slug.');
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid Slack thread URL.'); }
  // Inspect the original authority too: URL removes an explicitly supplied :443.
  const authority = /^https:\/\/([^/?#]+)/.exec(input)?.[1];
  if (url.protocol !== 'https:' || authority !== `${scope.workspace}.slack.com` ||
      url.username || url.password || url.port || url.hostname !== `${scope.workspace}.slack.com` || url.hash) {
    throw new Error('Slack URL must use HTTPS and the configured workspace, without credentials, ports, or fragments.');
  }
  const match = /^\/archives\/([CG][A-Z0-9]+)\/p(\d{16,})\/?$/.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new Error('Expected a Slack message permalink under /archives/CHANNEL/pTIMESTAMP.');
  const channelId = match[1];
  if (!scope.channelIds.includes(channelId)) throw new Error('Slack channel is not in the configured channel allowlist.');
  const messageTs = `${match[2].slice(0, -6)}.${match[2].slice(-6)}`;
  const roots = url.searchParams.getAll('thread_ts');
  const channels = url.searchParams.getAll('cid');
  if (roots.length > 1 || channels.length > 1 || (channels.length === 1 && channels[0] !== channelId)) {
    throw new Error('Slack URL contains conflicting thread or channel parameters.');
  }
  const rootTs = roots[0] ?? messageTs;
  if (!timestampSchema.safeParse(messageTs).success || !timestampSchema.safeParse(rootTs).success) {
    throw new Error('Slack timestamps must retain their six-digit fractional precision.');
  }
  return { workspace: scope.workspace, channelId, messageTs, rootTs };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Only known error codes enter diagnostics: SDK error messages can contain request secrets. */
function describeError(error: unknown): string {
  const details = record(error);
  const code = record(details.data).error ?? details.error ?? details.code;
  const descriptions: Record<string, string> = {
    invalid_auth: 'Slack authentication failed (invalid_auth). Check SLACK_TOKEN.',
    not_authed: 'Slack authentication is missing (not_authed). Check SLACK_TOKEN.',
    token_revoked: 'Slack token was revoked (token_revoked). Replace SLACK_TOKEN.',
    account_inactive: 'Slack account or token is inactive (account_inactive).',
    missing_scope: 'Slack token lacks required scopes (missing_scope). Check channel history permissions.',
    not_allowed_token_type: 'Slack token type cannot read this thread (not_allowed_token_type). Check token permissions.',
    channel_not_found: 'Slack channel is unavailable (channel_not_found). Check channel ID and membership.',
    not_in_channel: 'Slack token cannot access this channel (not_in_channel).',
    thread_not_found: 'Slack thread was not found or is not accessible (thread_not_found).',
    message_not_found: 'Slack message is no longer available (message_not_found).',
    slack_webapi_rate_limited_error: 'Slack rate limit retry budget was exhausted; retry later.',
    slack_webapi_request_error: 'Slack network request failed after bounded retries.',
    slack_webapi_http_error: 'Slack HTTP request failed after bounded retries.',
  };
  return typeof code === 'string' && Object.hasOwn(descriptions, code)
    ? descriptions[code]! : 'Slack API request failed.';
}

async function withRateLimitRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request(); } catch (error) {
      const details = record(error);
      if (details.code !== 'slack_webapi_rate_limited_error') throw error;
      const retryAfter = details.retryAfter;
      if (attempt >= MAX_RATE_LIMIT_RETRIES || typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) ||
          retryAfter < 0 || retryAfter > MAX_RETRY_AFTER_SECONDS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1_000));
    }
  }
}

export function createSlackClient(token: string): SlackApi {
  if (!token.trim()) throw new Error('SLACK_TOKEN is required.');
  const sdk = new WebClient(token, {
    timeout: 30_000,
    retryConfig: { retries: 2, factor: 2, minTimeout: 1_000, maxTimeout: 10_000, randomize: false },
    rejectRateLimitedCalls: true,
    maxRequestConcurrency: 1,
    // The application emits sanitized errors; avoid SDK transport diagnostics containing headers.
    logLevel: LogLevel.ERROR,
    logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} },
  });
  return {
    conversations: { replies: (args) => withRateLimitRetry(() => sdk.conversations.replies(args)) },
    chat: { getPermalink: (args) => withRateLimitRetry(() => sdk.chat.getPermalink(args)) },
  };
}

function canonicalPermalink(workspace: string, channelId: string, ts: string, rootTs: string): string {
  const base = `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  return ts === rootTs ? base : `${base}?thread_ts=${rootTs}&cid=${channelId}`;
}

/** Read one authorized thread. Incomplete collection never silently becomes a complete snapshot. */
export async function collectThread(url: string, scope: SlackScope, client: SlackApi): Promise<ThreadSnapshot> {
  const parsed = parseThreadUrl(url, scope);
  const { workspace, channelId, messageTs } = parsed;
  let rootTs = parsed.rootTs;
  let cursor: string | undefined;
  let partial = false;
  let normalized = false;
  let expectedReplies: number | undefined;
  const warnings = new Set<string>();
  const rawMessages = new Map<string, SlackMessage>();
  const seenCursors = new Set<string>();
  const warn = (message: string) => { partial = true; warnings.add(message); };

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: SlackRepliesResponse;
    try {
      response = await client.conversations.replies({ channel: channelId, ts: rootTs, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      if (response.ok !== true) throw { error: response.error };
      if (!Array.isArray(response.messages)) throw new Error('Invalid messages response');
    } catch (error) {
      if (rawMessages.size === 0) throw new Error(`Unable to collect Slack thread. ${describeError(error)}`);
      warn(`Thread collection stopped early. ${describeError(error)}`);
      break;
    }

    // Reply permalinks copied without their query string still resolve to the complete parent thread.
    const candidate = response.messages.find((message) => message && typeof message === 'object' && message.ts === messageTs) ?? response.messages[0];
    const discoveredRoot = candidate?.thread_ts;
    const needsRestart = !normalized && page === 0 && parsed.rootTs === messageTs &&
      typeof discoveredRoot === 'string' && timestampSchema.safeParse(discoveredRoot).success && discoveredRoot !== rootTs;
    if (needsRestart) { rootTs = discoveredRoot; normalized = true; }

    for (const message of response.messages) {
      if (!message || typeof message !== 'object' || !timestampSchema.safeParse(message.ts).success || typeof message.text !== 'string') {
        warn('A message had invalid or unavailable text/timestamp and was skipped.');
        continue;
      }
      if (message.thread_ts !== undefined && message.thread_ts !== rootTs) {
        warn('A message from a different thread was excluded.');
        continue;
      }
      const ts = message.ts!;
      const previous = rawMessages.get(ts);
      if (previous && hash(previous) !== hash(message)) warn('A message changed during pagination; the latest observed version was retained.');
      rawMessages.set(ts, message);
      if (ts === rootTs && Number.isSafeInteger(message.reply_count) && message.reply_count! >= 0) expectedReplies = message.reply_count;
    }
    if (needsRestart) { cursor = undefined; seenCursors.clear(); continue; }
    const rawCursor = response.response_metadata?.next_cursor;
    if (rawCursor !== undefined && typeof rawCursor !== 'string') {
      warn('Slack returned an invalid pagination cursor; collection is incomplete.');
      break;
    }
    const nextCursor = rawCursor?.trim();
    if (!nextCursor) {
      if (response.has_more) warn('Slack reported more messages without a next cursor; collection is incomplete.');
      break;
    }
    if (seenCursors.has(nextCursor)) { warn('Slack repeated a pagination cursor; collection stopped to prevent a loop.'); break; }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (page === MAX_PAGES - 1) warn('Thread collection reached its page limit and is incomplete.');
  }

  if (rawMessages.size === 0) throw new Error('Slack returned no readable messages for this thread.');
  if (!rawMessages.has(rootTs)) warn('The root message was not returned; thread context is incomplete.');
  if (expectedReplies !== undefined && rawMessages.size - 1 < expectedReplies) warn('Fewer replies were returned than the root message reported; thread context is incomplete.');
  let cache = permalinkCaches.get(client);
  if (!cache) { cache = new Map(); permalinkCaches.set(client, cache); }
  const messages: MessageVersion[] = [];
  for (const [ts, message] of [...rawMessages.entries()].sort(([a], [b]) => {
    const left = BigInt(a.replace('.', ''));
    const right = BigInt(b.replace('.', ''));
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const cacheKey = `${workspace}:${channelId}:${ts}:${rootTs}`;
    let permalink = cache.get(cacheKey);
    if (!permalink) {
      try {
        const response = await client.chat.getPermalink({ channel: channelId, message_ts: ts });
        if (response.ok !== true || !response.permalink) throw { error: response.error };
        const link = parseThreadUrl(response.permalink, scope);
        const hasExplicitRoot = new URL(response.permalink).searchParams.has('thread_ts');
        if (link.channelId !== channelId || link.messageTs !== ts || (hasExplicitRoot && link.rootTs !== rootTs)) {
          throw new Error('Permalink did not match source');
        }
        permalink = response.permalink;
        if (cache.size >= 10_000) cache.clear();
        cache.set(cacheKey, permalink);
      } catch (error) {
        permalink = canonicalPermalink(workspace, channelId, ts, rootTs);
        warn(`Permalink lookup failed for ${ts}; a canonical source link was retained. ${describeError(error)}`);
      }
    }
    const hasAttachments = Boolean(message.files?.length || message.attachments?.length);
    if (hasAttachments) warnings.add('Attachments or files are present; only message text was collected. File contents were not downloaded.');
    let editedTs: string | null = null;
    if (message.edited?.ts !== undefined) {
      if (timestampSchema.safeParse(message.edited.ts).success) editedTs = message.edited.ts;
      else warn(`Edit timestamp was invalid for ${ts}; source version may be incomplete.`);
    }
    const author = typeof message.user === 'string' ? message.user : typeof message.bot_id === 'string' ? message.bot_id : null;
    const source = { ts, text: message.text!, author, editedTs, hasAttachments };
    messages.push({ id: hash({ workspace, channelId, ...source }), ...source, permalink });
  }
  const content = { workspace, channelId, rootTs, messages, status: partial ? 'partial' as const : 'complete' as const, warnings: [...warnings].sort() };
  const contentHash = snapshotContentHash(content);
  return snapshotSchema.parse({ id: hash({ workspace, channelId, rootTs, contentHash }), ...content, contentHash, collectedAt: new Date().toISOString() });
}
