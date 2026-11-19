import { join } from 'node:path';
import { LogLevel, WebClient } from '@slack/web-api';
import type { ProjectConfig } from './config.js';
import { collectThread, createSlackClient, type SlackApi } from './slack.js';
import { normalizeSnapshot, writeArtifact } from './workflow.js';

export interface SlackAuthResponse {
  ok?: boolean;
  error?: string;
  url?: string;
  team_id?: string;
  user_id?: string;
}
export interface SlackAuthApi { auth: { test(): Promise<SlackAuthResponse> } }
export interface ConnectionCheck {
  authenticated: true;
  workspace: string;
  workspaceUrl: string;
  teamId: string;
  userId: string;
}
export interface CollectionResult {
  snapshotId: string;
  status: 'complete' | 'partial';
  messageCount: number;
  warningCount: number;
  snapshotPath: string;
}

function createAuthClient(token: string): SlackAuthApi {
  const sdk = new WebClient(token, {
    timeout: 30_000,
    retryConfig: { retries: 2, factor: 2, minTimeout: 1_000, maxTimeout: 10_000, randomize: false },
    rejectRateLimitedCalls: true,
    maxRequestConcurrency: 1,
    logLevel: LogLevel.ERROR,
    logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} },
  });
  return { auth: { test: () => sdk.auth.test() } };
}

function authFailure(error: unknown): Error {
  const details = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const data = details.data !== null && typeof details.data === 'object' ? details.data as Record<string, unknown> : {};
  const code = data.error ?? details.error ?? details.code;
  const messages: Record<string, string> = {
    invalid_auth: 'Slack authentication failed (invalid_auth). Check SLACK_TOKEN.',
    not_authed: 'Slack authentication is missing (not_authed). Check SLACK_TOKEN.',
    token_revoked: 'Slack token was revoked (token_revoked). Replace SLACK_TOKEN.',
    token_expired: 'Slack token expired (token_expired). Replace SLACK_TOKEN.',
    account_inactive: 'Slack account or token is inactive (account_inactive).',
    missing_scope: 'Slack token lacks required scopes (missing_scope).',
    slack_webapi_rate_limited_error: 'Slack rate limit reached; retry the connection check later.',
    slack_webapi_request_error: 'Slack network request failed after bounded retries.',
    slack_webapi_http_error: 'Slack HTTP request failed after bounded retries.',
  };
  // SDK diagnostics may contain Authorization headers. Only known codes are displayed.
  return new Error(typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code]! : 'Slack connection check failed. Verify the token and network connection.');
}

/** auth.test requires no additional OAuth scopes and does not read channel contents. */
export async function checkConnection(config: ProjectConfig, token: string, client?: SlackAuthApi): Promise<ConnectionCheck> {
  if (!token.trim()) throw new Error('SLACK_TOKEN is required.');
  let response: SlackAuthResponse;
  try {
    response = await (client ?? createAuthClient(token)).auth.test();
    if (response.ok !== true) throw { error: response.error };
  } catch (error) { throw authFailure(error); }

  // Compare the unmodified response URL, so credentials, ports and lookalike hosts fail closed.
  const workspaceUrl = `https://${config.slack.workspace}.slack.com/`;
  if (response.url !== workspaceUrl && response.url !== workspaceUrl.slice(0, -1)) {
    throw new Error('Slack token belongs to a different workspace than the configured workspace. Check slack.workspace and SLACK_TOKEN.');
  }
  if (typeof response.team_id !== 'string' || !/^T[A-Z0-9]+$/.test(response.team_id) ||
      typeof response.user_id !== 'string' || !/^[UW][A-Z0-9]+$/.test(response.user_id)) {
    throw new Error('Slack authentication response is missing a valid team or user identity.');
  }
  return { authenticated: true, workspace: config.slack.workspace, workspaceUrl, teamId: response.team_id, userId: response.user_id };
}

/** Collect source evidence locally without initializing an analyzer or contacting an LLM. */
export async function collectSnapshot(config: ProjectConfig, threadUrl: string, token: string, client?: SlackApi): Promise<CollectionResult> {
  if (!token.trim()) throw new Error('SLACK_TOKEN is required.');
  const snapshot = normalizeSnapshot(await collectThread(threadUrl, config.slack, client ?? createSlackClient(token)), config, threadUrl);
  const snapshotPath = join(config.storageDir, 'collections', snapshot.id, 'snapshot.json');
  writeArtifact(snapshotPath, snapshot);
  return { snapshotId: snapshot.id, status: snapshot.status, messageCount: snapshot.messages.length,
    warningCount: snapshot.warnings.length, snapshotPath };
}
