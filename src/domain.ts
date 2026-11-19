import { createHash } from 'node:crypto';
import { z } from 'zod';

export const timestampSchema = z.string().regex(/^\d{10,}\.\d{6}$/);
export const messageVersionSchema = z.object({
  id: z.string().min(1), ts: timestampSchema, text: z.string(),
  author: z.string().nullable(), editedTs: timestampSchema.nullable(),
  permalink: z.url(), hasAttachments: z.boolean(),
}).strict();
export type MessageVersion = z.infer<typeof messageVersionSchema>;
export const snapshotSchema = z.object({
  id: z.string().min(1), workspace: z.string().min(1), channelId: z.string().regex(/^[CG][A-Z0-9]+$/),
  rootTs: timestampSchema, collectedAt: z.iso.datetime(),
  status: z.enum(['complete', 'partial']), messages: z.array(messageVersionSchema),
  warnings: z.array(z.string()), contentHash: z.string().min(1),
}).strict();
export type ThreadSnapshot = z.infer<typeof snapshotSchema>;
export interface SlackScope { workspace: string; channelIds: string[] }
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function snapshotContentHash(snapshot: Pick<ThreadSnapshot, 'workspace' | 'channelId' | 'rootTs' | 'messages' | 'status' | 'warnings'>): string {
  return hash({ workspace: snapshot.workspace, channelId: snapshot.channelId, rootTs: snapshot.rootTs,
    messages: snapshot.messages, status: snapshot.status, warnings: snapshot.warnings });
}
