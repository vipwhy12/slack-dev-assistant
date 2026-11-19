import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SlackJobStore } from '../src/slack-jobs.js';

const directories: string[] = [];
const stores: SlackJobStore[] = [];
function setup(project = 'test', path?: string) {
  if (!path) { const directory = mkdtempSync(join(tmpdir(), 'slack-jobs-')); directories.push(directory); path = join(directory, 'jobs.sqlite'); }
  const store = new SlackJobStore(path, project); stores.push(store); return { store, path };
}
const request = (envelopeId = 'event-1') => ({ scopeHash: 'scope', envelopeId, teamId: 'T1', appId: 'A1', channelId: 'C1', userId: 'U1',
  threadUrl: 'https://team.slack.com/archives/C1/p1795086841177069', threadTs: '1795086841.177069', kind: 'analyze' as const });
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('SlackJobStore', () => {
  it('deduplicates an envelope while binding all request identities', () => {
    const { store, path } = setup();
    const first = store.enqueue(request());
    expect(first.reused).toBe(false);
    expect(store.enqueue(request())).toMatchObject({ reused: true, job: { id: first.job.id } });
    expect(() => store.enqueue({ ...request(), userId: 'U2' })).toThrow(/identity/);
    expect(() => store.enqueue({ ...request(), kind: 'save' })).toThrow(/command/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('permits only one worker and isolates queue/action reads by project', () => {
    const { store, path } = setup();
    const second = setup('test', path).store, foreign = setup('foreign', path).store;
    const first = store.enqueue(request()).job;
    store.enqueue(request('event-2'));
    expect(store.claimNext()?.id).toBe(first.id);
    expect(second.claimNext()).toBeUndefined();
    expect(() => second.finish(first.id, 'completed', {})).toThrow(/claiming worker/);
    expect(() => foreign.get(first.id)).toThrow(/project/);
    const action = store.finish(first.id, 'awaiting_review', { runId: 'run' }, null, { kind: 'review', binding: 'analysis' })!;
    expect(() => foreign.action(action.nonce)).toThrow(/project/);
    const next = second.claimNext()!;
    second.finish(next.id, 'completed', {});
  });
  it('consumes action and queues inputs atomically, preserving envelope deduplication', () => {
    const { store } = setup();
    const job = store.enqueue(request()).job;
    store.claimNext();
    const action = store.finish(job.id, 'awaiting_review', {}, null, { kind: 'review', binding: 'analysis' })!;
    expect(() => store.queueAction(action.nonce, 'wrong', { actor: 'U1' })).toThrow(/stale/);
    expect(store.action(action.nonce).consumedAt).toBeNull();
    const queued = store.queueAction(action.nonce, 'analysis', { actor: 'U1' });
    expect(queued).toMatchObject({ kind: 'plan', status: 'queued', input: { actor: 'U1', command: 'analyze' } });
    expect(() => store.queueAction(action.nonce, 'analysis', {})).toThrow(/already/);
    expect(store.enqueue(request()).reused).toBe(true);
    expect(store.pendingAction(job.id)).toBeUndefined();
  });
  it('does not replay an interrupted running operation when a worker died', () => {
    const { store, path } = setup();
    const interrupted = store.enqueue(request()).job;
    store.claimNext();
    const pending = store.enqueue(request('event-2')).job;
    const db = new DatabaseSync(path); db.prepare('UPDATE slack_worker_lock SET pid=?').run(2147483647); db.close();
    const restarted = setup('test', path).store;
    expect(restarted.claimNext()?.id).toBe(pending.id);
    expect(restarted.get(interrupted.id)).toMatchObject({ status: 'needs_resume' });
    restarted.finish(pending.id, 'completed', {});
    expect(restarted.claimNext()).toBeUndefined();
  });
  it('only lets the claiming worker resolve the root, retaining retries of the original reply URL', () => {
    const { store, path } = setup(), other = setup('test', path).store;
    const job = store.enqueue(request()).job;
    expect(() => store.updateThreadTs(job.id, '1795086800.000001')).toThrow(/claiming worker/);
    store.claimNext();
    expect(() => store.updateThreadTs(job.id, 'invalid')).toThrow(/timestamp/);
    expect(() => other.updateThreadTs(job.id, '1795086800.000001')).toThrow(/claiming worker/);
    store.updateThreadTs(job.id, '1795086800.000001');
    expect(store.enqueue(request())).toMatchObject({ reused: true, job: { id: job.id, threadTs: '1795086800.000001' } });
    expect(store.get(job.id).threadUrl).toBe(request().threadUrl);
    store.finish(job.id, 'completed', {});
  });
});
