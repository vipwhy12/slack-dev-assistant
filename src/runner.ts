import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ProjectConfig } from './config.js';
import { assertAllowedChanges, containsCredential, controllerEnvironment, git, isSensitivePath, type DevelopmentCommand } from './repository.js';

export interface VerificationResult {
  commandId: string;
  program: string;
  args: string[];
  status: 'passed' | 'failed' | 'not_run' | 'blocked';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Immutable local Docker image used for this command; absent for injected non-Docker test runners. */
  imageId?: string;
}
export interface VerificationRunner {
  run(worktreePath: string, commands: DevelopmentCommand[], config: ProjectConfig): Promise<VerificationResult[]>;
}
interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut?: boolean }
export type DockerExecutor = (args: string[], timeoutMs: number) => Promise<ProcessResult>;
const OUTPUT_LIMIT = 128 * 1024;
async function executeDocker(args: string[], timeoutMs: number): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn('docker', args, { env: controllerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = ''; let total = 0; let timedOut = false; let limited = false; let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, OUTPUT_LIMIT - total);
      const text = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += text; else stderr += text;
      total += chunk.length;
      if (total > OUTPUT_LIMIT && !limited) { limited = true; stderr += '\nOutput limit exceeded.'; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    const finish = (exitCode: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut) stderr += '\nCommand timed out.';
      resolveResult({ exitCode: limited && exitCode === 0 ? 1 : exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };
    child.once('error', () => { stderr += 'Docker is unavailable. Install and start Docker, and preload the configured verification image.'; finish(null); });
    child.once('close', (code) => finish(code));
  });
}
function result(command: DevelopmentCommand, status: VerificationResult['status'], stderr: string, process?: ProcessResult): VerificationResult {
  return { commandId: command.id, program: command.program, args: [...command.args], status,
    exitCode: process?.exitCode ?? null, durationMs: process?.durationMs ?? 0, stdout: process?.stdout ?? '', stderr };
}
function copyVerificationSnapshot(worktreePath: string, snapshotPath: string, config: ProjectConfig): void {
  const settings = config.development!;
  assertAllowedChanges(config, worktreePath, settings.writePaths);
  const paths = [...new Set([
    ...git(worktreePath, ['ls-files', '-z']).split('\0'),
    ...git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  let total = 0;
  for (const path of paths) {
    if (isSensitivePath(path)) continue;
    const source = resolve(worktreePath, path);
    if (!existsSync(source)) continue; // Approved deletions are absent from the verification copy.
    const segments = path.split('/');
    let current = worktreePath;
    let allowed = true;
    for (const segment of segments) {
      current = resolve(current, segment);
      if (lstatSync(current).isSymbolicLink()) { allowed = false; break; }
    }
    if (!allowed || !lstatSync(source).isFile()) continue;
    const size = lstatSync(source).size;
    if (size > 16 * 1024 * 1024 || (total += size) > 128 * 1024 * 1024) throw new Error('Repository is too large for the bounded verification snapshot.');
    const content = readFileSync(source);
    if (containsCredential(content.toString('utf8'))) throw new Error(`Credential-bearing file cannot enter the verification sandbox: ${path}`);
    const destination = resolve(snapshotPath, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o111 ? 0o700 : 0o600);
  }
}
/** Runs only in a preloaded, network-disabled Docker image over a disposable code copy. */
export class DockerRunner implements VerificationRunner {
  private readonly images = new Map<string, string>();
  constructor(private readonly execute: DockerExecutor = executeDocker) {}
  async run(worktreePath: string, commands: DevelopmentCommand[], config: ProjectConfig): Promise<VerificationResult[]> {
    const settings = config.development;
    if (!settings) throw new Error('development configuration is required for verification.');
    if (!commands.length) return [];
    if (commands.some((command) => !settings.commands.some((approved) => approved.id === command.id && approved.program === command.program && JSON.stringify(approved.args) === JSON.stringify(command.args)))) {
      throw new Error('Verification command is not in the configured command allowlist.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(settings.dockerImage)) throw new Error('Invalid Docker image reference.');
    const daemon = await this.execute(['info', '--format', '{{.ServerVersion}}'], 10_000);
    if (daemon.exitCode !== 0) return commands.map((command) => result(command, 'blocked', 'Docker is unavailable. Start Docker before verification.'));
    let imageId = this.images.get(settings.dockerImage);
    if (!imageId) {
      const image = await this.execute(['image', 'inspect', '--format', '{{.Id}}', settings.dockerImage], 10_000);
      imageId = image.stdout.trim();
      if (image.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) return commands.map((command) => result(command, 'blocked', 'The configured Docker image is not preloaded. Build or pull it explicitly; automatic image pulls are disabled.'));
      this.images.set(settings.dockerImage, imageId);
    }
    const snapshotPath = mkdtempSync(resolve(tmpdir(), 'slack-dev-verify-'));
    const results: VerificationResult[] = [];
    try {
      copyVerificationSnapshot(worktreePath, snapshotPath, config);
      for (const command of commands) {
        if (results.some((item) => item.status !== 'passed')) { results.push({ ...result(command, 'not_run', 'An earlier verification command did not pass.'), imageId }); continue; }
        const name = `slack-dev-verify-${randomUUID()}`;
        const args = ['run', '--rm', '--pull', 'never', '--name', name,
          '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--ipc', 'none',
          '--user', `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--env', 'HOME=/tmp', '--env', 'CI=1',
          '--mount', `type=bind,source=${snapshotPath},target=/workspace`, '--workdir', '/workspace',
          '--entrypoint', command.program, imageId, ...command.args];
        let execution: ProcessResult;
        try { execution = await this.execute(args, settings.commandTimeoutMs); }
        finally {
          // Killing the Docker client alone does not stop its container.
          await this.execute(['rm', '--force', name], 10_000);
        }
        const passed = execution.exitCode === 0 && !execution.timedOut;
        results.push({ ...result(command, passed ? 'passed' : 'failed', execution.stderr, execution), imageId });
      }
      return results;
    } finally { rmSync(snapshotPath, { recursive: true, force: true }); }
  }
}
