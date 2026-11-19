import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { ProjectConfig } from './config.js';

export interface RepositoryContext {
  repoPath: string;
  commitSha: string;
  files: { path: string; content: string }[];
  omittedPaths: string[];
}
export interface DevelopmentCommand { id: string; program: string; args: string[] }

/** Never propagate API credentials to Git, Docker, or generated-code processes. */
export function controllerEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}
export function git(directory: string, args: string[], maxBuffer = 4 * 1024 * 1024): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], {
    cwd: directory, env: controllerEnvironment(), encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
}
function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.split('/').some((part) => !part || part === '.' || part === '..') && !path.includes(':');
}
export function isSensitivePath(path: string): boolean {
  if (!safePath(path)) return true;
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  return parts.some((part) => ['.git', '.slack-dev', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'secrets', 'credentials'].includes(part)
    || part === '.env' || part.startsWith('.env.') || /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(part)
    || ['.npmrc', '.netrc', '.gitconfig', '.gitmodules', '.gitattributes', '.pypirc'].includes(part))
    || /\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)$/.test(lower)
    || lower.startsWith('.github/workflows/') || lower.startsWith('.git/hooks/')
    || /(^|\/)(credentials?|secrets?)(\.[^/]*)?$/.test(lower);
}
/** Scopes are exact paths or directory prefixes, never shell globs. '.' means the repository. */
export function pathAllowed(path: string, scopes: readonly string[]): boolean {
  if (isSensitivePath(path)) return false;
  return scopes.some((scope) => scope === '.' || (safePath(scope.replace(/\/$/, '')) && (path === scope.replace(/\/$/, '') || path.startsWith(`${scope.replace(/\/$/, '')}/`))));
}
export function containsCredential(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b/.test(content);
}
function repoRoot(config: ProjectConfig): string {
  if (!config.repoPath) throw new Error('repoPath is required for plan and implement.');
  const path = realpathSync(config.repoPath);
  const root = realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim());
  if (root !== path) throw new Error('repoPath must point to the Git repository root.');
  return root;
}
export function getRepoCommit(config: ProjectConfig): string {
  return git(repoRoot(config), ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
}
function development(config: ProjectConfig) {
  if (!config.development) throw new Error('development configuration is required for plan and implement.');
  return config.development;
}
function assertClean(root: string): void {
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) {
    throw new Error('Repository must be clean before planning or creating an implementation worktree. Commit or stash your changes first.');
  }
}
function treeFiles(root: string, commit: string): { path: string; mode: string; size: number }[] {
  return git(root, ['ls-tree', '-r', '-z', '-l', commit], 16 * 1024 * 1024).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, , , size] = entry.slice(0, tab).trim().split(/\s+/);
    return { path: entry.slice(tab + 1), mode: mode ?? '', size: Number(size) };
  });
}
function contentPriority(path: string, keywords: string[]): number {
  const lower = path.toLowerCase();
  let priority = /(^|\/)(readme(?:\.[^/]*)?|agents\.md|package\.json|tsconfig[^/]*|vitest\.config[^/]*|jest\.config[^/]*)$/.test(lower) ? 100 : 0;
  if (lower.startsWith('src/')) priority += 10;
  if (/(^|\/)(tests?|__tests__)\//.test(lower)) priority += 5;
  for (const word of keywords.filter((word) => word.length > 2).slice(0, 50)) if (lower.includes(word.toLowerCase())) priority += 20;
  return priority;
}
export function inspectRepository(config: ProjectConfig, keywords: string[] = []): RepositoryContext {
  const settings = development(config);
  const root = repoRoot(config);
  assertClean(root);
  const commitSha = getRepoCommit(config);
  const files: RepositoryContext['files'] = [];
  const omittedPaths: string[] = [];
  let totalBytes = 0;
  const entries = treeFiles(root, commitSha).sort((a, b) => contentPriority(b.path, keywords) - contentPriority(a.path, keywords) || a.path.localeCompare(b.path));
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode) || !pathAllowed(entry.path, settings.readPaths)
      || !Number.isFinite(entry.size) || entry.size > settings.maxFileBytes || totalBytes + entry.size > settings.maxContextBytes || files.length >= settings.maxFiles) {
      omittedPaths.push(entry.path); continue;
    }
    const content = git(root, ['show', `${commitSha}:${entry.path}`], Math.max(settings.maxFileBytes + 1024, 4096));
    if (content.includes('\0') || content.includes('\uFFFD') || containsCredential(content)) { omittedPaths.push(entry.path); continue; }
    files.push({ path: entry.path, content });
    totalBytes += Buffer.byteLength(content);
  }
  return { repoPath: root, commitSha, files, omittedPaths };
}
export function createWorktree(config: ProjectConfig, commitSha: string, runId: string): { path: string; branch: string } {
  const root = repoRoot(config);
  development(config);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(runId) || !/^[0-9a-f]{40,64}$/.test(commitSha)) throw new Error('Invalid run ID or pinned commit.');
  assertClean(root);
  if (getRepoCommit(config) !== commitSha) throw new Error('Repository HEAD changed since the plan was created. Generate a fresh plan.');
  const path = resolve(config.storageDir, 'worktrees', runId);
  const branch = `slack-dev/${runId}`;
  if (existsSync(path)) {
    validateWorktree(config, path, branch, commitSha);
    assertClean(path);
    return { path, branch };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  git(root, ['worktree', 'add', '-b', branch, path, commitSha]);
  return { path, branch };
}
interface CheckedWorktree { config: ProjectConfig; allowedPaths: string[]; gitFileHash: string }
const checked = new Map<string, CheckedWorktree>();
function gitFileFingerprint(worktreePath: string): string {
  const file = resolve(worktreePath, '.git');
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Implementation worktree Git control file changed.');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function assertWorktree(config: ProjectConfig, worktreePath: string): void {
  const path = realpathSync(worktreePath);
  const root = repoRoot(config);
  const common = realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()));
  const control = resolve(path, '.git');
  if (!lstatSync(control).isFile() || lstatSync(control).isSymbolicLink()) throw new Error('Expected an isolated linked Git worktree.');
  const text = readFileSync(control, 'utf8');
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text);
  if (!match?.[1]) throw new Error('Invalid worktree Git control file.');
  const gitDir = realpathSync(resolve(path, match[1]));
  const commonWorktrees = resolve(common, 'worktrees');
  if (!gitDir.startsWith(`${commonWorktrees}${sep}`) || dirname(gitDir) !== commonWorktrees) throw new Error('Worktree does not belong to the configured repository.');
  if (realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim()) !== path
    || realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir']).trim())) !== common) throw new Error('Worktree repository identity changed.');
  const prior = checked.get(path);
  if (prior && prior.gitFileHash !== gitFileFingerprint(path)) throw new Error('Worktree Git control file changed.');
}
function assertRegularPath(root: string, path: string): void {
  let current = root;
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) {
      // existsSync follows links; detect dangling symlinks as well.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Only regular files may be changed: ${path}`);
  }
}
export function assertAllowedChanges(config: ProjectConfig, worktreePath: string, allowedPaths: string[]): string[] {
  const settings = development(config);
  const root = realpathSync(worktreePath);
  assertWorktree(config, root);
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (ignored.length) throw new Error('Ignored files appeared in the implementation worktree; refusing to commit.');
  const paths = [...new Set([
    ...git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', 'HEAD']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
  if (paths.length > settings.maxChangedFiles) throw new Error('Changed file count exceeds development.maxChangedFiles.');
  let totalBytes = 0;
  for (const path of paths) {
    if (!pathAllowed(path, settings.writePaths) || !pathAllowed(path, allowedPaths) || /(^|\/)AGENTS\.md$/i.test(path)) throw new Error(`Change is outside the approved file scope: ${path}`);
    assertRegularPath(root, path);
    const file = resolve(root, path);
    if (existsSync(file)) {
      const size = lstatSync(file).size;
      if (size > settings.maxFileBytes) throw new Error(`Changed file is too large: ${path}`);
      const content = readFileSync(file);
      if (content.includes(0) || containsCredential(content.toString('utf8'))) throw new Error(`Binary or credential-bearing content cannot be committed: ${path}`);
      totalBytes += content.length;
    } else {
      totalBytes += Number(git(root, ['cat-file', '-s', `HEAD:${path}`]).trim());
    }
  }
  if (totalBytes > settings.maxChangeBytes) throw new Error('Changed content exceeds development.maxChangeBytes.');
  checked.set(root, { config, allowedPaths: [...allowedPaths], gitFileHash: gitFileFingerprint(root) });
  return paths;
}
function approvedChanges(worktreePath: string): string[] {
  const root = realpathSync(worktreePath);
  const state = checked.get(root);
  if (!state) throw new Error('Call assertAllowedChanges before creating a diff or committing.');
  return assertAllowedChanges(state.config, root, state.allowedPaths);
}
export function createDiff(worktreePath: string): string {
  const paths = approvedChanges(worktreePath);
  if (!paths.length) return '';
  const newFiles = git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (newFiles.length) git(worktreePath, ['add', '--intent-to-add', '--', ...newFiles]);
  return git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', ...paths], 8 * 1024 * 1024);
}
export function commitChanges(worktreePath: string, message: string): string {
  const paths = approvedChanges(worktreePath);
  if (!paths.length) throw new Error('There are no implementation changes to commit.');
  if (!message.trim() || message.includes('\0')) throw new Error('A valid commit message is required.');
  git(worktreePath, ['add', '-A', '--', ...paths]);
  const identity: string[] = [];
  for (const [key, fallback] of [['user.name', 'Slack Dev Assistant'], ['user.email', 'slack-dev-assistant@users.noreply.github.com']]) {
    try { if (!git(worktreePath, ['config', '--get', key!]).trim()) identity.push('-c', `${key}=${fallback}`); }
    catch { identity.push('-c', `${key}=${fallback}`); }
  }
  git(worktreePath, [...identity, '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return git(worktreePath, ['rev-parse', 'HEAD']).trim();
}

export function validateWorktree(config: ProjectConfig, worktreePath: string, branch: string, expectedCommit: string): void {
  const path = realpathSync(worktreePath);
  const storageRoot = realpathSync(resolve(config.storageDir, 'worktrees'));
  if (dirname(path) !== storageRoot || basename(path) !== branch.slice('slack-dev/'.length) || !/^slack-dev\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(branch)) throw new Error('Unexpected implementation worktree path or branch.');
  assertWorktree(config, path);
  if (git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() !== branch) throw new Error('Implementation worktree branch changed.');
  if (!/^[0-9a-f]{40,64}$/.test(expectedCommit) || git(path, ['rev-parse', 'HEAD']).trim() !== expectedCommit) throw new Error('Implementation worktree commit changed.');
  const registrations = git(repoRoot(config), ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
  if (!registrations.some((entry) => entry.split('\0').includes(`worktree ${path}`) && entry.split('\0').includes(`branch refs/heads/${branch}`))) throw new Error('Implementation worktree is not registered to the expected repository.');
}
