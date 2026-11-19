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
import { planRun, approvePlan, implementPlan } from './development.js';
import { FilePlanner, OpenAIPlanner } from './planning.js';
import { FileImplementer, OpenAIImplementer, BudgetLedger } from './generation.js';

const program = new Command().name('slack-dev').version('0.2.0')
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
program.command('plan').argument('<analyze-run-id>').addOption(configOption())
  .description('Investigate pinned repository code and create an evidence-linked implementation plan')
  .option('--requirements <ids>', 'comma-separated requirement IDs; defaults to active requirements')
  .option('--plan-file <path>', 'replay a plan draft JSON without an LLM call')
  .option('--force', 'create a new plan instead of reusing identical inputs')
  .action(async (runId: string, options: {config: string; requirements?: string; planFile?: string; force?: boolean}) => {
    const config = loadConfig(options.config);
    const planner = options.planFile ? new FilePlanner(options.planFile) : new OpenAIPlanner(config);
    json(await planRun({ config, sourceRunId: runId, planner, force: options.force,
      ...(options.requirements ? { requirementIds: options.requirements.split(',').map(id => id.trim()) } : {}) }));
  });
program.command('approve-plan').argument('<plan-id>').addOption(configOption())
  .description('Record a local execution grant for the exact reviewed specification, plan, commit and configuration')
  .requiredOption('--reason <text>', 'reason for accepting the plan and execution scope')
  .option('--actor <name>', 'local reviewer name', userInfo().username)
  .option('--allow-pr', 'also permit explicit draft PR publication for this plan')
  .action((planId: string, options: {config: string; reason: string; actor: string; allowPr?: boolean}) => {
    json(approvePlan(loadConfig(options.config), planId, options.reason, options.actor, options.allowPr));
  });
program.command('implement').argument('<plan-id>').addOption(configOption())
  .description('Apply a granted plan in an isolated worktree, verify in Docker, and optionally publish a draft PR')
  .requiredOption('--grant <id>', 'execution grant returned by approve-plan')
  .option('--changes-file <path>', 'replay validated full-file changes without an LLM call')
  .option('--publish', 'push the verified branch and create/reuse a draft PR; grant must allow PRs')
  .option('--resume <run-id>', 'resume the recorded patch/verification/publication without regenerating changes')
  .action(async (planId: string, options: {config: string; grant: string; changesFile?: string; publish?: boolean; resume?: string}) => {
    const config = loadConfig(options.config);
    // Instantiate the network adapter lazily: a completed checkpoint can resume without a key.
    let delegate: OpenAIImplementer | undefined;
    const implementer = options.changesFile ? new FileImplementer(options.changesFile) : {
      name: 'openai', model: config.model, promptVersion: 'implementation-v1',
      get usage() { return delegate?.usage; },
      async implement(input: Parameters<OpenAIImplementer['implement']>[0]) { delegate = new OpenAIImplementer(config); return delegate.implement(input); },
    };
    json(await implementPlan({ config, planId, grantId: options.grant, implementer, publish: options.publish, resumeRunId: options.resume }));
  });
program.command('budget').addOption(configOption()).description('Show cumulative planning/implementation API reservations and estimated usage')
  .action((options: {config: string}) => {
    const config = loadConfig(options.config);
    const ledger = new BudgetLedger(config.storageDir, config.development?.budgetUsd ?? 10);
    try { json(ledger.summary()); } finally { ledger.close(); }
  });
program.parseAsync().catch(error => { process.stderr.write(`Error: ${safeError(error).message}\n`); process.exitCode = 1; });
