import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ProjectConfig } from '../src/config.js';
import { createWorktree, getRepoCommit, git } from '../src/repository.js';
import { DockerRunner, type DockerExecutor } from '../src/runner.js';

let directory: string; let config: ProjectConfig; let worktree: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-dev-runner-')); const repo = join(directory, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src/app.ts'), 'safe'); writeFileSync(join(repo, '.env'), 'SECRET=excluded');
  git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Fixture']);
  config = configSchema.parse({ projectId: 'fixture', model: 'fixture', slack: { workspace: 'fixture', channelIds: ['CDEMO'] }, repoPath: repo, storageDir: join(directory, 'state'),
    development: { readPaths: ['.'], writePaths: ['src'], commands: [{ id: 'test', program: 'node', args: ['--test'] }, { id: 'build', program: 'node', args: ['build.js'] }], dockerImage: 'node:24' } });
  worktree = createWorktree(config, getRepoCommit(config), 'run-1').path;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const ok = { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };

describe('isolated Docker verification', () => {
  it('mounts a disposable copy without Git or secrets and constrains the container', async () => {
    const calls: string[][] = []; let snapshot = '';
    const execute: DockerExecutor = async (args) => {
      calls.push(args);
      if (args[0] === 'image') return { ...ok, stdout: `sha256:${'a'.repeat(64)}` };
      if (args[0] === 'run') {
        const mount = args[args.indexOf('--mount') + 1]!; snapshot = /source=([^,]+)/.exec(mount)![1]!;
        expect(snapshot).not.toBe(worktree); expect(existsSync(join(snapshot, '.git'))).toBe(false); expect(existsSync(join(snapshot, '.env'))).toBe(false);
        writeFileSync(join(snapshot, 'src/app.ts'), 'sandbox mutation');
        expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pull', 'never']));
        expect(args).not.toContain('/var/run/docker.sock');
      }
      return ok;
    };
    const results = await new DockerRunner(execute).run(worktree, [config.development!.commands[0]!], config);
    expect(results[0]!.status).toBe('passed'); expect(readFileSync(join(worktree, 'src/app.ts'), 'utf8')).toBe('safe');
    expect(existsSync(snapshot)).toBe(false); expect(calls.some((args) => args[0] === 'rm' && args[1] === '--force')).toBe(true);
  });
  it('pins the image across baseline and changed-code runs and records the immutable ID', async () => {
    let inspections = 0; const imageId = `sha256:${'c'.repeat(64)}`;
    const execute: DockerExecutor = async (args) => {
      if (args[0] === 'image') { inspections++; return { ...ok, stdout: inspections === 1 ? imageId : `sha256:${'d'.repeat(64)}` }; }
      if (args[0] === 'run') expect(args).toContain(imageId);
      return ok;
    };
    const runner = new DockerRunner(execute);
    const baseline = await runner.run(worktree, config.development!.commands, config);
    const changed = await runner.run(worktree, config.development!.commands, config);
    expect(inspections).toBe(1); expect(baseline.every((item) => item.imageId === imageId)).toBe(true);
    expect(changed.every((item) => item.imageId === imageId)).toBe(true);
  });
  it('fails closed without Docker or a preloaded image and never falls back to host execution', async () => {
    const calls: string[][] = [];
    const unavailable: DockerExecutor = async (args) => { calls.push(args); return { ...ok, exitCode: 1 }; };
    const results = await new DockerRunner(unavailable).run(worktree, config.development!.commands, config);
    expect(results.every((item) => item.status === 'blocked')).toBe(true); expect(calls).toHaveLength(1);
    const missingImage: DockerExecutor = async (args) => args[0] === 'info' ? ok : { ...ok, exitCode: 1 };
    expect((await new DockerRunner(missingImage).run(worktree, config.development!.commands, config))[0]!.stderr).toContain('preloaded');
  });
  it('stops following commands after failure and rejects arbitrary generated commands', async () => {
    const execute: DockerExecutor = async (args) => args[0] === 'image' ? { ...ok, stdout: `sha256:${'b'.repeat(64)}` } : args[0] === 'run' ? { ...ok, exitCode: 1, stderr: 'test failed' } : ok;
    const runner = new DockerRunner(execute);
    const results = await runner.run(worktree, config.development!.commands, config);
    expect(results.map((item) => item.status)).toEqual(['failed', 'not_run']);
    await expect(runner.run(worktree, [{ id: 'test', program: 'curl', args: ['https://example.test'] }], config)).rejects.toThrow(/allowlist/);
  });
});
