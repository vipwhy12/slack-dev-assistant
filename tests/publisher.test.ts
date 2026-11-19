import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { assertAllowedChanges, commitChanges, createWorktree, getRepoCommit, git } from '../src/repository.js';
import { publishDraft, type PublisherExecutor } from '../src/publisher.js';

let directory: string; let config: ProjectConfig; let worktree: { path: string; branch: string }; let bodyFile: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-dev-publisher-')); const repo = join(directory, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src/app.ts'), 'original'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Fixture']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repository.git']);
  config = configSchema.parse({ projectId: 'fixture', model: 'fixture', slack: { workspace: 'fixture', channelIds: ['CDEMO'] }, repoPath: repo, storageDir: join(directory, 'state'),
    development: { readPaths: ['.'], writePaths: ['src'], commands: [{ id: 'test', program: 'node', args: ['--test'] }], dockerImage: 'node:24' },
    github: { repository: 'example/repository', baseBranch: 'main', remote: 'origin' } });
  worktree = createWorktree(config, getRepoCommit(config), 'run-1'); writeFileSync(join(worktree.path, 'src/app.ts'), 'changed');
  assertAllowedChanges(config, worktree.path, ['src/app.ts']); commitChanges(worktree.path, 'Implement fixture');
  bodyFile = join(directory, 'body.md'); writeFileSync(bodyFile, 'Reviewed implementation.\n\nValidation: passed\n');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function fixtureExecutor(existing: unknown[] = []) {
  const calls: { program: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const executor: PublisherExecutor = async (program, args, _cwd, env) => {
    calls.push({ program, args, env });
    if (program === 'gh' && args[0] === 'repo') return 'example/repository\n';
    if (program === 'gh' && args[1] === 'list') return JSON.stringify(existing);
    if (program === 'gh' && args[1] === 'create') return 'https://github.com/example/repository/pull/7\n';
    return '';
  };
  return { calls, executor };
}

describe('reviewable draft publishing', () => {
  it('pushes only the verified branch and creates a draft with a body file', async () => {
    const { executor, calls } = fixtureExecutor();
    expect(await publishDraft(config, worktree.path, worktree.branch, bodyFile, 'Fixture change', executor)).toEqual({ url: 'https://github.com/example/repository/pull/7' });
    const push = calls.find((call) => call.program === 'git' && call.args.includes('push'))!;
    expect(push.args).toContain('--no-force'); expect(push.args).toContain(`HEAD:refs/heads/${worktree.branch}`); expect(push.args).toContain('core.hooksPath=/dev/null');
    const create = calls.find((call) => call.program === 'gh' && call.args[1] === 'create')!;
    expect(create.args).toContain('--draft'); expect(create.args).toContain('--body-file'); expect(create.args).toContain(bodyFile);
    for (const call of calls) { expect(call.env.OPENAI_API_KEY).toBeUndefined(); expect(call.env.SLACK_BOT_TOKEN).toBeUndefined(); }
  });
  it('reuses the same repository draft PR without creating a duplicate', async () => {
    const { executor, calls } = fixtureExecutor([{ url: 'https://github.com/example/repository/pull/5', headRefName: worktree.branch, baseRefName: 'main',
      headRepositoryOwner: { login: 'example' }, headRepository: { name: 'repository' }, isDraft: true }]);
    expect((await publishDraft(config, worktree.path, worktree.branch, bodyFile, 'Fixture', executor)).url).toContain('/pull/5');
    expect(calls.some((call) => call.program === 'gh' && call.args[1] === 'create')).toBe(false);
  });
  it('refuses mismatched push remotes before invoking authenticated tools', async () => {
    git(worktree.path, ['remote', 'set-url', '--push', 'origin', 'https://github.com/other/repository.git']);
    const { executor, calls } = fixtureExecutor();
    await expect(publishDraft(config, worktree.path, worktree.branch, bodyFile, 'Fixture', executor)).rejects.toThrow(/exactly match/);
    expect(calls).toHaveLength(0);
  });
  it('does not push changes to a PR that has left draft state', async () => {
    const { executor, calls } = fixtureExecutor([{ url: 'https://github.com/example/repository/pull/5', headRefName: worktree.branch, baseRefName: 'main',
      headRepositoryOwner: { login: 'example' }, headRepository: { name: 'repository' }, isDraft: false }]);
    await expect(publishDraft(config, worktree.path, worktree.branch, bodyFile, 'Fixture', executor)).rejects.toThrow(/no longer a draft/);
    expect(calls.some((call) => call.program === 'git' && call.args.includes('push'))).toBe(false);
  });
  it('rejects divergent remote branch identity without pushing', async () => {
    const mock = fixtureExecutor();
    const executor: PublisherExecutor = (program, args, cwd, env) => args.includes('ls-remote')
      ? Promise.resolve(`${'f'.repeat(40)}\trefs/heads/${worktree.branch}\n`) : mock.executor(program, args, cwd, env);
    await expect(publishDraft(config, worktree.path, worktree.branch, bodyFile, 'Fixture', executor)).rejects.toThrow(/unrelated changes/);
    expect(mock.calls.some((call) => call.args.includes('push'))).toBe(false);
  });
});
