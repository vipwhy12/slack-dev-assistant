import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConnection, collectSnapshot, type SlackAuthResponse } from '../src/connection.js';
import type { ProjectConfig } from '../src/config.js';
import { snapshotSchema } from '../src/domain.js';
import type { SlackApi } from '../src/slack.js';

let directory: string;
let config: ProjectConfig;
const token = 'xoxp-private-test-token';
const url = 'https://household.slack.com/archives/C123/p1732000000000001';
const validAuth: SlackAuthResponse = { ok: true, url: 'https://household.slack.com/', team_id: 'T123', user_id: 'U123' };
const authClient = (response: SlackAuthResponse) => ({ auth: { test: vi.fn(async () => response) } });
function threadClient(replyCount = 0): SlackApi {
  return {
    conversations: { replies: vi.fn(async () => ({ ok: true, messages: [{ ts: '1732000000.000001', text: 'Private household discussion', user: 'U123', reply_count: replyCount }] })) },
    chat: { getPermalink: vi.fn(async () => ({ ok: true, permalink: url })) },
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-dev-connection-'));
  config = { projectId: 'household', slack: { workspace: 'household', channelIds: ['C123'] }, storageDir: directory, model: 'fixture' };
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('connection check', () => {
  it('verifies the configured workspace and returns only non-secret identity metadata', async () => {
    const client = authClient({ ...validAuth, token } as SlackAuthResponse);
    const result = await checkConnection(config, token, client);
    expect(result).toEqual({ authenticated: true, workspace: 'household', workspaceUrl: 'https://household.slack.com/', teamId: 'T123', userId: 'U123' });
    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(existsSync(join(directory, 'history.sqlite'))).toBe(false);
  });
  it.each([
    'https://another.slack.com/', 'https://household.slack.com.evil.test/',
    'http://household.slack.com/', 'https://secret@household.slack.com/',
    'https://household.slack.com:443/', undefined,
  ])('rejects tokens whose workspace URL does not match: %s', async (workspaceUrl) => {
    await expect(checkConnection(config, token, authClient({ ...validAuth, url: workspaceUrl }))).rejects.toThrow('different workspace');
  });
  it('accepts the canonical workspace URL without a trailing slash', async () => {
    await expect(checkConnection(config, token, authClient({ ...validAuth, url: 'https://household.slack.com' }))).resolves.toMatchObject({ authenticated: true });
  });
  it('reports known authentication errors without reflecting credential-bearing SDK details', async () => {
    const client = { auth: { test: vi.fn(async () => { throw { data: { error: 'invalid_auth', token }, message: `Authorization: ${token}` }; }) } };
    await expect(checkConnection(config, token, client)).rejects.toThrow('Slack authentication failed (invalid_auth). Check SLACK_TOKEN.');
  });
  it('never returns unknown errors or missing-identity fields containing secrets', async () => {
    const client = { auth: { test: vi.fn(async () => { throw new Error(`Network error with ${token}`); }) } };
    await expect(checkConnection(config, token, client)).rejects.toThrow('Slack connection check failed. Verify the token and network connection.');
    await expect(checkConnection(config, token, authClient({ ok: false, error: token }))).rejects.toThrow('Slack connection check failed. Verify the token and network connection.');
    await expect(checkConnection(config, token, authClient({ ...validAuth, team_id: token }))).rejects.toThrow('missing a valid team or user identity');
  });
  it('rejects absent credentials before contacting Slack', async () => {
    const client = authClient(validAuth);
    await expect(checkConnection(config, ' ', client)).rejects.toThrow('SLACK_TOKEN is required');
    expect(client.auth.test).not.toHaveBeenCalled();
  });
});

describe('collection without LLM access', () => {
  it('writes a replayable snapshot with restricted permissions and returns no discussion text', async () => {
    const result = await collectSnapshot(config, url, token, threadClient());
    expect(result).toMatchObject({ status: 'complete', messageCount: 1, warningCount: 0 });
    expect(result.snapshotPath).toBe(join(directory, 'collections', result.snapshotId, 'snapshot.json'));
    const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(result.snapshotPath, 'utf8')));
    expect(snapshot.id).toBe(result.snapshotId);
    expect(snapshot.messages[0]?.text).toBe('Private household discussion');
    expect(snapshot.messages[0]?.permalink).toBe(url);
    expect(JSON.stringify(result)).not.toContain('Private household discussion');
    expect(statSync(result.snapshotPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, 'history.sqlite'))).toBe(false);
  });
  it('preserves partial collection and its warnings in the snapshot', async () => {
    const result = await collectSnapshot(config, url, token, threadClient(2));
    expect(result).toMatchObject({ status: 'partial', messageCount: 1, warningCount: 1 });
    expect(JSON.parse(readFileSync(result.snapshotPath, 'utf8')).warnings[0]).toContain('Fewer replies');
  });
  it('checks the channel allowlist before any Slack read and rejects missing credentials', async () => {
    const client = threadClient();
    await expect(collectSnapshot(config, url.replace('C123', 'C999'), token, client)).rejects.toThrow('allowlist');
    await expect(collectSnapshot(config, url, '', client)).rejects.toThrow('SLACK_TOKEN');
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });
});
