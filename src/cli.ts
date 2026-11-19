#!/usr/bin/env node
import 'dotenv/config';
import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { loadConfig } from './config.js';
import { OpenAIAnalyzer } from './analysis.js';
import { createSlackClient, collectThread } from './slack.js';
import { analyzeThread, FileAnalyzer, reviewRun, safeError } from './workflow.js';
import { RunStore } from './store.js';
import { checkConnection, collectSnapshot } from './connection.js';

const program = new Command().name('slack-dev').version('0.1.0')
  .description('Analyze Slack discussions into evidence-linked requirement drafts.');
const configOption = () => new Option('-c, --config <path>', 'project configuration JSON').default('slack-dev.config.json');
const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
program.command('doctor').addOption(configOption())
  .description('Verify the Slack token and configured workspace without invoking an LLM')
  .action(async (options: {config: string}) => {
    json(await checkConnection(loadConfig(options.config), process.env.SLACK_TOKEN ?? ''));
  });
program.command('collect').argument('<thread-url>').addOption(configOption())
  .description('Collect a Slack thread snapshot without invoking an LLM')
  .action(async (threadUrl: string, options: {config: string}) => {
    const config = loadConfig(options.config);
    const token = process.env.SLACK_TOKEN ?? '';
    await checkConnection(config, token);
    const result = await collectSnapshot(config, threadUrl, token);
    json(result);
    if (result.status === 'partial') process.exitCode = 2;
  });
program.command('analyze').argument('<thread-url>', 'allowed Slack thread permalink')
  .addOption(configOption()).option('--snapshot <path>', 'replay a local collected snapshot; no Slack calls')
  .option('--analysis-file <path>', 'replay a local draft; no LLM calls').option('--force', 'create a fresh analysis even if identical input was already analyzed')
  .action(async (threadUrl: string, options: {config: string; snapshot?: string; analysisFile?: string; force?: boolean}) => {
    const config = loadConfig(options.config);
    if (!options.snapshot && !process.env.SLACK_TOKEN) throw new Error('SLACK_TOKEN is required for live Slack collection.');
    if (!options.analysisFile && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for live analysis.');
    const analyzer = options.analysisFile ? new FileAnalyzer(options.analysisFile) : new OpenAIAnalyzer({ model: config.model });
    const result = await analyzeThread({ config, threadUrl, analyzer, force: options.force,
      collect: options.snapshot
        ? async () => JSON.parse(readFileSync(options.snapshot!, 'utf8'))
        : () => collectThread(threadUrl, config.slack, createSlackClient(process.env.SLACK_TOKEN!)),
    });
    json(result);
    if (!result.reportPath) process.exitCode = 2;
  });
program.command('history').addOption(configOption()).option('--limit <count>', 'maximum records (1–1000)', '20')
  .action((options: {config: string; limit: string}) => {
    const config = loadConfig(options.config); const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try { json(store.list(config.projectId, Number(options.limit))); } finally { store.close(); }
  });
program.command('show').argument('<run-id>').addOption(configOption())
  .action((runId: string, options: {config: string}) => {
    const config = loadConfig(options.config); const store = new RunStore(join(config.storageDir, 'history.sqlite'));
    try {
      const result = store.detail(runId);
      if (result.run.project_id !== config.projectId) throw new Error('Run belongs to another project.');
      json(result);
    } finally { store.close(); }
  });
program.command('review').argument('<run-id>').addOption(configOption())
  .requiredOption('--file <path>', 'reviewed analysis JSON').requiredOption('--reason <text>', 'reason for acceptance/correction')
  .requiredOption('--minutes <number>', 'actual human review minutes').option('--actor <name>', 'local reviewer name', userInfo().username)
  .action((runId: string, options: {config: string; file: string; reason: string; minutes: string; actor: string}) => {
    const config = loadConfig(options.config);
    json(reviewRun(config, runId, JSON.parse(readFileSync(options.file, 'utf8')), options.reason, Number(options.minutes), options.actor));
  });
for (const mode of ['plan', 'implement']) {
  program.command(mode).allowUnknownOption().allowExcessArguments()
    .description('Reserved for a future version')
    .action(() => { throw new Error(`${mode} is not implemented in this MVP. Use analyze; no repository changes were made.`); });
}
program.parseAsync().catch(error => { process.stderr.write(`Error: ${safeError(error).message}\n`); process.exitCode = 1; });
