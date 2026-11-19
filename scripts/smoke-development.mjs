import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configSchema } from '../dist/config.js';
import { analyzeThread, reviewRun, writeArtifact } from '../dist/workflow.js';
import { planRun, approvePlan, implementPlan } from '../dist/development.js';
import { FilePlanner, OpenAIPlanner } from '../dist/planning.js';
import { FileImplementer, OpenAIImplementer, BudgetLedger } from '../dist/generation.js';
import { DockerRunner } from '../dist/runner.js';

// Entirely synthetic local repository and discussion. No Slack messages or PRs.
// --live permits two bounded model requests; default replays fixed JSON for $0.
const live = process.argv.includes('--live');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Only --live is supported.');
const parent = resolve('.slack-dev'); mkdirSync(parent, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(join(parent, 'development-smoke-'));
const repoPath = join(directory, 'repo');
const config = configSchema.parse({ projectId: 'synthetic-development-smoke', storageDir: join(directory, 'data'), repoPath,
  slack: { workspace: 'example', channelIds: ['CDEMO12345'] }, model: 'gpt-4.1-mini',
  development: { readPaths: ['src', 'test', 'README.md'], writePaths: ['src', 'test'],
    commands: [{ id: 'test', program: 'node', args: ['--test', 'test/greet.mjs'] }], dockerImage: 'node:24-alpine', budgetUsd: 0.90 },
});
mkdirSync(join(repoPath, 'src'), { recursive: true }); mkdirSync(join(repoPath, 'test'));
const code = "export function greet(name) { return `Hello, ${name}!`; }\n";
const test = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\ntest('returns a string', () => assert.equal(typeof greet('민수'), 'string'));\n";
writeFileSync(join(repoPath, 'src/greet.mjs'), code); writeFileSync(join(repoPath, 'test/greet.mjs'), test);
writeFileSync(join(repoPath, 'README.md'), '# Synthetic greeting fixture\nUse node --test test/greet.mjs. No dependencies. Only src/greet.mjs and test/greet.mjs need changes.\n');
const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'synthetic@example.invalid');
git('add', '.'); git('commit', '-m', 'Synthetic greeting fixture');
const originalHead = git('rev-parse', 'HEAD');
const snapshot = { id: 'synthetic-source', workspace: 'example', channelId: 'CDEMO12345', rootTs: '1795046400.000001',
  collectedAt: new Date().toISOString(), status: 'complete', warnings: [], contentHash: 'normalized-on-load',
  messages: [{ id: 'synthetic-message', ts: '1795046400.000001', text: '인사 함수는 이름을 받아 안녕하세요, 이름! 형식으로 반환하도록 확정합니다. 민수는 안녕하세요, 민수!가 되어야 합니다.',
    author: 'synthetic-user', editedTs: null, hasAttachments: false, permalink: 'https://example.slack.com/archives/CDEMO12345/p1795046400000001' }] };
const draft = { summary: '한국어 인사 기능을 구현합니다.', requirements: [{ id: 'R1', statement: 'greet(name)을 한국어 인사로 변경한다.',
  decisionState: 'confirmed', sourceRefs: [{ messageVersionId: 'synthetic-message', quote: snapshot.messages[0].text }], supersedesIds: [], blockingQuestionIds: [],
  acceptanceCriteria: [{ id: 'A1', text: 'greet("민수")는 "안녕하세요, 민수!"를 반환한다.', origin: 'source', sourceRefs: [{ messageVersionId: 'synthetic-message', quote: '민수는 안녕하세요, 민수!가 되어야 합니다.' }] }] }], questions: [] };
const analyzed = await analyzeThread({ config, threadUrl: snapshot.messages[0].permalink, collect: async () => snapshot,
  analyzer: { name: 'synthetic', model: 'offline', promptVersion: 'v1', analyze: async () => draft } });
reviewRun(config, analyzed.runId, draft, 'Synthetic test fixture; no real user requirements approved', 0, 'synthetic-test');
const planFile = join(directory, 'plan-input.json'); const changesFile = join(directory, 'changes-input.json');
writeArtifact(planFile, { summary: '한국어 인사와 테스트', items: [{ id: 'P1', requirementIds: ['R1'], currentBehavior: '영어 인사를 반환한다.',
  codeRefs: [{ path: 'src/greet.mjs', quote: code.trim() }], proposedChanges: '한국어 인사를 반환하고 이름 보존을 검증한다.',
  affectedPaths: ['src/greet.mjs', 'test/greet.mjs'], dependencies: [], acceptanceChecks: [{ criterionId: 'A1', commandId: 'test', testName: 'Korean greeting' }], blockers: [] }], excludedRequirements: [] });
writeArtifact(changesFile, { summary: '한국어 인사 구현', files: [{ path: 'src/greet.mjs', content: "export function greet(name) { return `안녕하세요, ${name}!`; }\n" },
  { path: 'test/greet.mjs', content: test + "test('Korean greeting', () => assert.equal(greet('민수'), '안녕하세요, 민수!'));\n" }] });
console.log(JSON.stringify({ stage: 'planning', live, directory, maxNewApiCostUsd: live ? 0.90 : 0 }));
const planned = await planRun({ config, sourceRunId: analyzed.runId, planner: live ? new OpenAIPlanner(config) : new FilePlanner(planFile) });
const grant = approvePlan(config, planned.planId, 'Synthetic test plan only', 'synthetic-test');
console.log(JSON.stringify({ stage: 'implementing', planId: planned.planId }));
const completed = await implementPlan({ config, planId: planned.planId, grantId: grant.grantId,
  implementer: live ? new OpenAIImplementer(config) : new FileImplementer(changesFile), runner: new DockerRunner() });
assert.equal(completed.status, 'review_ready'); assert.equal(completed.prUrl, null);
assert.equal(git('rev-parse', 'HEAD'), originalHead); assert.equal(git('status', '--porcelain'), '');
assert.equal(readFileSync(join(repoPath, 'src/greet.mjs'), 'utf8'), code);
assert(readFileSync(completed.diffPath, 'utf8').includes('안녕하세요'));
// Independent black-box assertion runs in the same Docker isolation, not the host.
const externalConfig = { ...config, development: { ...config.development, commands: [{ id: 'independent-acceptance', program: 'node',
  args: ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import { greet } from './src/greet.mjs'; assert.equal(greet('민수'), '안녕하세요, 민수!'); assert.equal(greet('지영'), '안녕하세요, 지영!');"] }] } };
const independent = await new DockerRunner().run(completed.worktreePath, externalConfig.development.commands, externalConfig);
assert(independent.every(result => result.status === 'passed'));
const configPath = join(directory, 'project.json'); writeArtifact(configPath, config);
const resumed = JSON.parse(execFileSync(process.execPath, [resolve('dist/cli.js'), 'implement', planned.planId, '--config', configPath,
  '--grant', grant.grantId, '--resume', completed.runId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, OPENAI_API_KEY: '', SLACK_TOKEN: '', DOTENV_CONFIG_QUIET: 'true' } }));
assert.equal(resumed.commitSha, completed.commitSha); assert.equal(resumed.status, 'review_ready');
const ledger = new BudgetLedger(config.storageDir, 0.90); const budget = ledger.summary(); ledger.close();
assert(budget.requests <= (live ? 2 : 0)); assert(budget.reservedOrSpentUsd <= 0.90);
writeArtifact(join(directory, 'result.json'), { passed: true, live, testedAt: new Date().toISOString(), ...completed, independent, cliResumeVerified: true, budget });
console.log(JSON.stringify({ passed: true, live, ...completed, independentAcceptance: 'passed', cliResumeVerified: true, budget, resultPath: join(directory, 'result.json') }, null, 2));
