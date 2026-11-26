import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { assertAllowedChanges, commitChanges, controllerEnvironment, createDiff, createWorktree, getRepoCommit, git, inspectRepository, pathAllowed, validateWorktree } from '../src/repository.js';

let directory: string; let repo: string; let config: ProjectConfig;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-dev-repository-')); repo = join(directory, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src/app.ts'), 'export const answer = 1;\n');
  writeFileSync(join(repo, 'README.md'), '# Fixture\n'); writeFileSync(join(repo, '.gitignore'), '.env\ncache/\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Initial fixture']);
  config = configSchema.parse({ projectId: 'fixture', model: 'fixture', slack: { workspace: 'fixture', channelIds: ['CDEMO'] }, repoPath: repo,
    storageDir: join(directory, 'state'), development: { readPaths: ['.'], writePaths: ['src', 'tests'], commands: [{ id: 'test', program: 'node', args: ['--test'] }], dockerImage: 'node:24' } });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('repository boundaries', () => {
  it('reads bounded committed text while ignoring local secrets and excluding symlinks/credentials', () => {
    symlinkSync('/etc/passwd', join(repo, 'src/link')); writeFileSync(join(repo, 'src/secret.txt'), `token=sk-proj-${'a'.repeat(30)}`);
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Unsafe fixture files']); writeFileSync(join(repo, '.env'), 'OPENAI_API_KEY=not-read');
    const context = inspectRepository(config);
    expect(context.files.map((file) => file.path)).toContain('src/app.ts');
    expect(context.files.map((file) => file.path)).not.toContain('.env');
    expect(context.omittedPaths).toEqual(expect.arrayContaining(['src/link', 'src/secret.txt']));
    expect(JSON.stringify(context)).not.toContain('OPENAI_API_KEY');
    config.development!.maxFiles = 1;
    expect(inspectRepository(config).files).toHaveLength(1);
  });
  it('requires a clean pinned repository and rejects unsafe scope paths', () => {
    writeFileSync(join(repo, 'src/app.ts'), 'dirty');
    expect(() => inspectRepository(config)).toThrow(/clean/);
    for (const path of ['../escape', '/etc/passwd', 'src/../secret', 'src\\escape', '.env', '.github/workflows/test.yml', 'node_modules/a', 'a/.git/config', 'secret.key']) expect(pathAllowed(path, ['.'])).toBe(false);
    expect(pathAllowed('src/app.ts', ['src'])).toBe(true);
    expect(pathAllowed('src-other/app.ts', ['src'])).toBe(false);
  });
  it('isolates edits and commits including new files and deletions from the original checkout', () => {
    const base = getRepoCommit(config); const worktree = createWorktree(config, base, 'run-1');
    validateWorktree(config, worktree.path, worktree.branch, base);
    expect(createWorktree(config, base, 'run-1')).toEqual(worktree);
    writeFileSync(join(worktree.path, 'src/new.ts'), 'export const result = 2;\n'); rmSync(join(worktree.path, 'src/app.ts'));
    expect(assertAllowedChanges(config, worktree.path, ['src/app.ts', 'src/new.ts'])).toEqual(['src/app.ts', 'src/new.ts']);
    const diff = createDiff(worktree.path); expect(diff).toContain('new file mode'); expect(diff).toContain('deleted file mode');
    const commit = commitChanges(worktree.path, 'Implement fixture'); expect(commit).not.toBe(base);
    expect(getRepoCommit(config)).toBe(base); expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toContain('answer = 1');
    validateWorktree(config, worktree.path, worktree.branch, commit);
  });
  it('blocks unapproved paths, ignored additions, symlinks, and wrong worktree identity', () => {
    const base = getRepoCommit(config); const worktree = createWorktree(config, base, 'run-2');
    writeFileSync(join(worktree.path, 'README.md'), 'Changed');
    expect(() => assertAllowedChanges(config, worktree.path, ['.'])).toThrow(/scope/);
    git(worktree.path, ['restore', 'README.md']); writeFileSync(join(worktree.path, '.env'), 'secret');
    expect(() => assertAllowedChanges(config, worktree.path, ['src'])).toThrow(/Ignored/);
    rmSync(join(worktree.path, '.env')); symlinkSync('/tmp', join(worktree.path, 'src/link'));
    expect(() => assertAllowedChanges(config, worktree.path, ['src'])).toThrow(/regular files/);
    expect(() => validateWorktree(config, worktree.path, 'slack-dev/wrong', base)).toThrow(/path or branch/);
  });
  it('rechecks changes before commit and enforces file/byte limits', () => {
    const worktree = createWorktree(config, getRepoCommit(config), 'run-3');
    writeFileSync(join(worktree.path, 'src/app.ts'), 'changed'); assertAllowedChanges(config, worktree.path, ['src/app.ts']);
    mkdirSync(join(worktree.path, 'tests')); writeFileSync(join(worktree.path, 'tests/unapproved.ts'), 'test');
    expect(() => commitChanges(worktree.path, 'Unexpected addition')).toThrow(/scope/);
    rmSync(join(worktree.path, 'tests/unapproved.ts')); config.development!.maxChangeBytes = 2;
    expect(() => assertAllowedChanges(config, worktree.path, ['src'])).toThrow(/maxChangeBytes/);
  });
  it('revalidates and commits a saved worktree in a fresh process without in-memory approval state', () => {
    const base = getRepoCommit(config); const worktree = createWorktree(config, base, 'resume-run');
    writeFileSync(join(worktree.path, 'src/app.ts'), 'export const answer = 2;\n');
    assertAllowedChanges(config, worktree.path, ['src/app.ts']); const diff = createDiff(worktree.path);
    const script = `
      const { validateWorktree, assertAllowedChanges, createDiff, commitChanges } = await import(process.argv[1]);
      const { config, worktree, base, diff } = JSON.parse(process.argv[2]);
      validateWorktree(config, worktree.path, worktree.branch, base);
      assertAllowedChanges(config, worktree.path, ['src/app.ts']);
      if (createDiff(worktree.path) !== diff) throw new Error('Saved patch changed');
      console.log(commitChanges(worktree.path, 'Resume reviewed implementation'));
    `;
    const commit = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script,
      pathToFileURL(join(process.cwd(), 'src/repository.ts')).href, JSON.stringify({ config, worktree, base, diff })],
      { cwd: process.cwd(), encoding: 'utf8', env: controllerEnvironment(), timeout: 20_000 }).trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/); expect(commit).not.toBe(base); expect(getRepoCommit(config)).toBe(base);
  });
  it('never forwards ambient API keys into controller processes', () => {
    const env = controllerEnvironment(); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.SLACK_BOT_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});
