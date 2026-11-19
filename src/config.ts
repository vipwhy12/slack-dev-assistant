import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const scopePath = z.string().min(1).refine(value => value === '.' ||
  (!value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f]/.test(value) &&
   value.split('/').every(part => part !== '' && part !== '.' && part !== '..')), 'Use a relative file or directory path without wildcards or traversal');
export const developmentSchema = z.object({
  readPaths: z.array(scopePath).min(1),
  writePaths: z.array(scopePath).min(1),
  commands: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    program: z.string().regex(/^[a-zA-Z0-9/][a-zA-Z0-9._/-]*$/),
    args: z.array(z.string().refine(value => !value.includes('\0'))).max(128),
  }).strict()).min(1).max(20).refine(commands => new Set(commands.map(command => command.id)).size === commands.length, 'Command IDs must be unique'),
  dockerImage: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
  commandTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxContextBytes: z.number().int().min(1024).max(262_144).default(98_304),
  maxFileBytes: z.number().int().min(256).max(131_072).default(32_768),
  maxFiles: z.number().int().min(1).max(100).default(30),
  maxChangedFiles: z.number().int().min(1).max(50).default(12),
  maxChangeBytes: z.number().int().min(256).max(262_144).default(98_304),
  budgetUsd: z.number().positive().max(10).default(10),
}).strict();

export const slackAppSchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]+$/),
  appId: z.string().regex(/^A[A-Z0-9]+$/),
  command: z.string().regex(/^\/[a-z0-9_-]+$/).default('/duduk'),
  allowedUserIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).min(1),
  approverUserIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).min(1),
}).strict().refine(policy => policy.approverUserIds.every(id => policy.allowedUserIds.includes(id)),
  'Every approver must also be an allowed user');

export const configSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  slack: z.object({
    workspace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    channelIds: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).min(1),
  }).strict(),
  storageDir: z.string().min(1).default('.slack-dev'),
  repoPath: z.string().min(1).optional(),
  model: z.string().min(1),
  development: developmentSchema.optional(),
  slackApp: slackAppSchema.optional(),
  github: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value => !value.includes('..') && !value.endsWith('/')).default('main'),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).default('origin'),
  }).strict().optional(),
}).strict();
export type ProjectConfig = z.infer<typeof configSchema>;
export function loadConfig(path: string): ProjectConfig {
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const base = dirname(resolve(path));
  return { ...config, storageDir: resolve(base, config.storageDir),
    ...(config.repoPath ? { repoPath: resolve(base, config.repoPath) } : {}) };
}
