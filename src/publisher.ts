import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { containsCredential, controllerEnvironment, git, validateWorktree } from './repository.js';

const execFileAsync = promisify(execFile);
export interface PublishResult { url: string }
export type PublisherExecutor = (program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
const execute: PublisherExecutor = async (program, args, cwd, env) => {
  const result = await execFileAsync(program, args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000 });
  return result.stdout;
};
function githubIdentity(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1]?.toLowerCase();
}
function publisherEnvironment(): NodeJS.ProcessEnv {
  const extra: NodeJS.ProcessEnv = { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) if (process.env[key]) extra[key] = process.env[key];
  return controllerEnvironment(extra);
}
/** Push only the configured repository and create/reuse an open draft PR. Never merges. */
export async function publishDraft(
  config: ProjectConfig, worktreePath: string, branch: string, bodyFile: string, title: string,
  executor: PublisherExecutor = execute,
): Promise<PublishResult> {
  const github = config.github;
  if (!github || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(github.repository)) throw new Error('A valid github.repository is required to publish.');
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(github.remote)) throw new Error('Invalid Git remote name.');
  if (!/^slack-dev\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(branch)) throw new Error('Only an implementation branch may be published.');
  if (!title.trim() || title.length > 200 || /[\r\n\0]/.test(title)) throw new Error('Invalid pull request title.');
  const body = readFileSync(bodyFile, 'utf8');
  if (Buffer.byteLength(body) > 128 * 1024 || containsCredential(body)) throw new Error('Pull request body is oversized or contains credentials.');
  git(worktreePath, ['check-ref-format', '--branch', github.baseBranch]);
  const commit = git(worktreePath, ['rev-parse', 'HEAD']).trim();
  validateWorktree(config, worktreePath, branch, commit);
  if (git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) throw new Error('Commit all reviewed changes before publishing.');
  const identity = github.repository.toLowerCase();
  for (const args of [['remote', 'get-url', '--all', github.remote], ['remote', 'get-url', '--push', '--all', github.remote]]) {
    const urls = git(worktreePath, args).trim().split('\n');
    if (urls.length !== 1 || githubIdentity(urls[0]!) !== identity) throw new Error('Git remote does not exactly match github.repository. Refusing to push.');
  }
  const env = publisherEnvironment();
  const target = (await executor('gh', ['repo', 'view', github.repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], worktreePath, env)).trim();
  if (target.toLowerCase() !== identity) throw new Error('GitHub repository identity changed.');
  const gitPrefix = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never',
    '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'credential.https://github.com.helper=!gh auth git-credential'];
  const remoteHead = (await executor('git', [...gitPrefix, 'ls-remote', '--heads', github.remote, `refs/heads/${branch}`], worktreePath, env)).trim();
  if (remoteHead) {
    const [sha, reference] = remoteHead.split(/\s+/);
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha) || reference !== `refs/heads/${branch}`) throw new Error('Unexpected remote branch identity.');
    if (sha !== commit) {
      try { git(worktreePath, ['merge-base', '--is-ancestor', sha, commit]); }
      catch { throw new Error('Remote implementation branch has unrelated changes. Refusing to overwrite it.'); }
    }
  }
  const existing = JSON.parse(await executor('gh', ['pr', 'list', '--repo', github.repository, '--head', branch, '--base', github.baseBranch,
    '--state', 'open', '--limit', '100', '--json', 'url,headRefName,headRepositoryOwner,headRepository,baseRefName,isDraft'], worktreePath, env)) as {
      url: string; headRefName: string; headRepositoryOwner: { login: string }; headRepository: { name: string }; baseRefName: string; isDraft: boolean;
    }[];
  const matching = existing.filter((pr) => pr.headRefName === branch && pr.baseRefName === github.baseBranch
    && `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`.toLowerCase() === identity);
  if (matching.length > 1) throw new Error('Multiple matching pull requests exist; manual review is required.');
  if (matching[0]) {
    if (!matching[0].isDraft) throw new Error('Existing pull request is no longer a draft; refusing to modify it.');
    if (!matching[0].url.startsWith(`https://github.com/${github.repository}/pull/`)) throw new Error('Unexpected pull request URL.');
  }
  await executor('git', [...gitPrefix, 'push', '--no-force', '--set-upstream', github.remote, `HEAD:refs/heads/${branch}`], worktreePath, env);
  if (matching[0]) return { url: matching[0].url };
  const output = await executor('gh', ['pr', 'create', '--repo', github.repository, '--base', github.baseBranch,
    '--head', branch, '--draft', '--title', title, '--body-file', bodyFile], worktreePath, env);
  const url = output.trim();
  const expectedPrefix = `https://github.com/${github.repository}/pull/`;
  if (!url.startsWith(expectedPrefix) || !/^\d+$/.test(url.slice(expectedPrefix.length))) throw new Error('GitHub returned an unexpected pull request URL.');
  return { url };
}
