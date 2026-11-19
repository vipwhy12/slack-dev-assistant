import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const configSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  slack: z.object({
    workspace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    channelIds: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).min(1),
  }).strict(),
  storageDir: z.string().min(1).default('.slack-dev'),
  repoPath: z.string().min(1).optional(),
  model: z.string().min(1),
}).strict();
export type ProjectConfig = z.infer<typeof configSchema>;
export function loadConfig(path: string): ProjectConfig {
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const base = dirname(resolve(path));
  return { ...config, storageDir: resolve(base, config.storageDir),
    ...(config.repoPath ? { repoPath: resolve(base, config.repoPath) } : {}) };
}
