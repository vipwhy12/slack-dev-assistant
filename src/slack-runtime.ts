import { join } from 'node:path';
import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel, WebClient, type ChatPostMessageArguments, type ViewsOpenArguments } from '@slack/web-api';
import { z } from 'zod';
import type { ProjectConfig } from './config.js';
import { checkConnection } from './connection.js';
import { createSlackBackend } from './slack-backend.js';
import { SlackJobStore } from './slack-jobs.js';
import { SlackService, type SlackReply } from './slack-service.js';
import { safeError } from './workflow.js';

type Ack = (payload?: object) => Promise<void>;
export interface SocketEnvelope { body: unknown; envelope_id: string; ack: Ack }
const identitySchema = z.object({ team: z.object({ id: z.string() }), api_app_id: z.string(), user: z.object({ id: z.string() }) });
const commandSchema = z.object({ team_id: z.string(), api_app_id: z.string(), user_id: z.string(), channel_id: z.string(), command: z.string(), text: z.string() });
const actionSchema = identitySchema.extend({ type: z.literal('block_actions'), channel: z.object({ id: z.string() }), trigger_id: z.string(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string() })).length(1) });
const viewSchema = identitySchema.extend({ type: z.literal('view_submission'), view: z.object({ callback_id: z.enum(['sd_review_submit', 'sd_feedback_submit']),
  private_metadata: z.string(), state: z.object({ values: z.record(z.string(), z.record(z.string(), z.object({
    value: z.string().nullable().optional(), selected_options: z.array(z.object({ value: z.string() })).optional(),
  }).passthrough())) }) }) });
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export interface SlackTransport {
  ephemeral(channel: string, user: string, reply: SlackReply): Promise<void>;
  message(channel: string, threadTs: string, reply: SlackReply): Promise<void>;
  modal(triggerId: string, view: Record<string, unknown>): Promise<void>;
}

/** A transport seam permits real queue/approval tests without a Slack connection or model calls. */
export class SlackSocketController {
  private draining?: Promise<void>;
  private stopped = false;
  constructor(private readonly service: SlackService, private readonly transport: SlackTransport,
    private readonly log: (message: string) => void = message => process.stderr.write(`${message}\n`)) {}

  async command(event: SocketEnvelope): Promise<void> {
    // Validation/enqueue is local and bounded; expensive work starts only after this acknowledgement.
    let reply: SlackReply;
    try {
      const body = commandSchema.parse(event.body);
      reply = this.service.handleCommand({ teamId: body.team_id, appId: body.api_app_id, userId: body.user_id,
        channelId: body.channel_id, command: body.command, text: body.text, envelopeId: event.envelope_id });
    } catch (error) { reply = { text: safeError(error).message }; }
    await event.ack({ response_type: 'ephemeral', mrkdwn: false, text: escape(reply.text), ...(reply.blocks ? { blocks: reply.blocks } : {}) });
    this.kick();
  }
  async interactive(event: SocketEnvelope): Promise<void> {
    const submission = viewSchema.safeParse(event.body);
    if (submission.success) {
      const body = submission.data;
      try {
        if (body.view.callback_id === 'sd_feedback_submit') {
          await this.service.handleFeedbackSubmission({ teamId: body.team.id, appId: body.api_app_id, userId: body.user.id,
            privateMetadata: body.view.private_metadata, text: body.view.state.values.feedback_text?.value?.value ?? '', envelopeId: event.envelope_id });
        } else {
          const values = this.service.parseReviewValues(body.view.private_metadata, body.view.state.values);
          await this.service.handleReviewSubmission({ teamId: body.team.id, appId: body.api_app_id, userId: body.user.id,
            privateMetadata: body.view.private_metadata, ...values });
        }
      } catch (error) {
        await event.ack({ response_action: 'errors', errors: { [body.view.callback_id === 'sd_feedback_submit' ? 'feedback_text' : 'review_reason']: safeError(error).message.slice(0, 1000) } });
        return;
      }
      await event.ack(); this.kick(); return;
    }
    // Buttons open their modal after ack so no Web API call delays Socket Mode acknowledgement.
    await event.ack();
    const parsed = actionSchema.safeParse(event.body);
    if (!parsed.success) return;
    const body = parsed.data;
    try {
      const reply = await this.service.handleAction({ teamId: body.team.id, appId: body.api_app_id, userId: body.user.id,
        channelId: body.channel.id, actionId: body.actions[0]!.action_id, value: body.actions[0]!.value });
      this.kick();
      if (reply.modal) await this.transport.modal(body.trigger_id, reply.modal);
      else await this.transport.ephemeral(body.channel.id, body.user.id, reply);
    } catch (error) {
      // Only configured identities can receive a useful error; never send to a forged payload target.
      if (this.service.canReplyTo({ teamId: body.team.id, appId: body.api_app_id, userId: body.user.id }, body.channel.id)) {
        try { await this.transport.ephemeral(body.channel.id, body.user.id, { text: safeError(error).message }); }
        catch { this.log('Slack action feedback could not be delivered; use the status command.'); }
      } else this.log('Slack action rejected: unauthorized identity or channel.');
    }
  }
  kick(): void {
    if (this.draining || this.stopped) return;
    this.draining = this.drain().catch(error => this.log(`Slack worker: ${safeError(error).message}`))
      .finally(() => { this.draining = undefined; });
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const result = await this.service.processNextJob();
      if (!result) return;
      try { await this.transport.message(result.job.channelId, result.job.threadTs, result.message); }
      catch (error) {
        // Work is already durably saved. Never repeat a paid request or PR to retry a notification.
        this.log(`Slack notification failed for ${result.job.id}; use status: ${safeError(error).message}`);
      }
    }
  }
  async idle(): Promise<void> { await this.draining; }
  async stop(): Promise<void> { this.stopped = true; await this.idle(); }
}

export async function serveSlack(config: ProjectConfig): Promise<{ stop(): Promise<void> }> {
  if (!config.slackApp) throw new Error('slackApp configuration is required. See docs/slack-commands.md.');
  const readToken = process.env.SLACK_TOKEN, botToken = process.env.SLACK_BOT_TOKEN, appToken = process.env.SLACK_APP_TOKEN;
  if (!readToken || !botToken?.startsWith('xoxb-') || !appToken?.startsWith('xapp-')) {
    throw new Error('Set SLACK_TOKEN (collection), SLACK_BOT_TOKEN (xoxb), and SLACK_APP_TOKEN (xapp) in the local ignored .env.');
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };
  const client = new WebClient(botToken, { logger, logLevel: LogLevel.ERROR, retryConfig: { retries: 0 }, timeout: 15_000, rejectRateLimitedCalls: true });
  const [readAuth, botAuth] = await Promise.all([checkConnection(config, readToken), checkConnection(config, botToken, client)]);
  if ([readAuth.teamId, botAuth.teamId].some(id => id !== config.slackApp!.teamId)) throw new Error('Slack tokens do not match slackApp.teamId.');
  const store = new SlackJobStore(join(config.storageDir, 'slack-jobs.sqlite'), config.projectId);
  const service = new SlackService(config, store, createSlackBackend(config, readToken, botAuth.userId, botAuth.botId, {
    async postFeedback(input) {
      const posted = await client.chat.postMessage({ channel: input.channelId, thread_ts: input.threadTs, text: input.text,
        parse: 'none', mrkdwn: false, unfurl_links: false, unfurl_media: false });
      if (!posted.ts) throw new Error('Slack feedback delivery did not return a message timestamp. Inspect the thread before resuming.');
      return { ts: posted.ts };
    },
  }));
  const controller = new SlackSocketController(service, {
    async ephemeral(channel, user, reply) {
      await client.chat.postEphemeral({ channel, user, text: escape(reply.text), blocks: reply.blocks as unknown as Extract<ChatPostMessageArguments, { blocks: unknown }>['blocks'], parse: 'none' });
    },
    async message(channel, threadTs, reply) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: escape(reply.text), blocks: reply.blocks as unknown as Extract<ChatPostMessageArguments, { blocks: unknown }>['blocks'],
        parse: 'none', mrkdwn: false, unfurl_links: false, unfurl_media: false });
    },
    async modal(triggerId, view) { await client.views.open({ trigger_id: triggerId, view: view as unknown as ViewsOpenArguments['view'] }); },
  });
  const socket = new SocketModeClient({ appToken, logger, logLevel: LogLevel.ERROR,
    clientOptions: { retryConfig: { retries: 0 }, timeout: 15_000 } });
  const logError = (error: unknown) => process.stderr.write(`Slack: ${safeError(error).message}\n`);
  socket.on('slash_commands', (event: SocketEnvelope) => { void controller.command(event).catch(logError); });
  socket.on('interactive', (event: SocketEnvelope) => { void controller.interactive(event).catch(logError); });
  socket.on('error', logError);
  try { await socket.start(); } catch (error) { await socket.disconnect(); store.close(); throw new Error(`Socket Mode connection failed: ${safeError(error).message}`); }
  controller.kick();
  const interval = setInterval(() => controller.kick(), 1000);
  let stopping: Promise<void> | undefined;
  return { stop() {
    stopping ??= (async () => { clearInterval(interval); await socket.disconnect(); await controller.stop(); store.close(); })();
    return stopping;
  } };
}
