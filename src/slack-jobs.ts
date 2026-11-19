import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SlackJobKind = 'save' | 'analyze' | 'plan' | 'implement';
export type SlackJobStatus = 'queued' | 'running' | 'awaiting_review' | 'awaiting_approval' | 'completed' | 'failed' | 'needs_resume';
export interface SlackJob {
  id: string; projectId: string; scopeHash: string; envelopeId: string;
  teamId: string; appId: string; channelId: string; userId: string;
  threadUrl: string; threadTs: string; kind: SlackJobKind; status: SlackJobStatus;
  createdAt: string; updatedAt: string; input: unknown; result: unknown; error: string | null;
}
export interface SlackAction {
  nonce: string; jobId: string; kind: 'review' | 'implement'; binding: string;
  createdAt: string; consumedAt: string | null;
}
type NewJob = Pick<SlackJob, 'scopeHash' | 'envelopeId' | 'teamId' | 'appId' | 'channelId' | 'userId' | 'threadUrl' | 'threadTs'> & { kind: 'save' | 'analyze' };
type JobRow = Omit<SlackJob, 'input' | 'result'> & { inputJson: string; resultJson: string };
const now = () => new Date().toISOString();
const decode = (row: JobRow): SlackJob => {
  const { inputJson, resultJson, ...job } = row;
  return { ...job, input: JSON.parse(inputJson), result: JSON.parse(resultJson) };
};

/** The queue stores identifiers and validated task data, never Slack tokens or response URLs. */
export class SlackJobStore {
  private readonly db: DatabaseSync;
  private workerOwner?: string;
  constructor(path: string, readonly projectId: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS slack_jobs (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, scopeHash TEXT NOT NULL, envelopeId TEXT NOT NULL,
        teamId TEXT NOT NULL, appId TEXT NOT NULL, channelId TEXT NOT NULL, userId TEXT NOT NULL,
        threadUrl TEXT NOT NULL, threadTs TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, inputJson TEXT NOT NULL DEFAULT '{}',
        resultJson TEXT NOT NULL DEFAULT 'null', error TEXT,
        UNIQUE(projectId, envelopeId));
      CREATE INDEX IF NOT EXISTS slack_jobs_queue ON slack_jobs(projectId,status,createdAt);
      CREATE TABLE IF NOT EXISTS slack_actions (
        nonce TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES slack_jobs(id), kind TEXT NOT NULL,
        binding TEXT NOT NULL, createdAt TEXT NOT NULL, consumedAt TEXT);
      CREATE TABLE IF NOT EXISTS slack_worker_lock (
        projectId TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  enqueue(input: NewJob): { job: SlackJob; reused: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM slack_jobs WHERE projectId=? AND envelopeId=?').get(this.projectId, input.envelopeId) as JobRow | undefined;
      if (existing) {
        const job = decode(existing);
        // The collector may resolve a reply permalink to its true root after enqueue.
        // The original URL is immutable and fully binds the target across retries.
        for (const key of ['scopeHash', 'teamId', 'appId', 'channelId', 'userId', 'threadUrl'] as const) {
          if (job[key] !== input[key]) throw new Error('Envelope identity does not match the original request.');
        }
        // kind advances as the workflow runs; the immutable command is retained in input.
        if ((job.input as { command?: string }).command !== input.kind) throw new Error('Envelope command does not match the original request.');
        this.db.exec('COMMIT'); return { job, reused: true };
      }
      const id = randomUUID(), time = now();
      this.db.prepare(`INSERT INTO slack_jobs(id,projectId,scopeHash,envelopeId,teamId,appId,channelId,userId,
        threadUrl,threadTs,kind,status,createdAt,updatedAt,inputJson) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`)
        .run(id, this.projectId, input.scopeHash, input.envelopeId, input.teamId, input.appId, input.channelId,
          input.userId, input.threadUrl, input.threadTs, input.kind, time, time, JSON.stringify({ command: input.kind }));
      this.db.exec('COMMIT'); return { job: this.get(id), reused: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): SlackJob {
    const row = this.db.prepare('SELECT * FROM slack_jobs WHERE id=? AND projectId=?').get(id, this.projectId) as JobRow | undefined;
    if (!row) throw new Error('Slack job was not found in this project.');
    return decode(row);
  }
  action(nonce: string): SlackAction {
    const row = this.db.prepare('SELECT a.* FROM slack_actions a JOIN slack_jobs j ON j.id=a.jobId WHERE a.nonce=? AND j.projectId=?')
      .get(nonce, this.projectId) as unknown as SlackAction | undefined;
    if (!row) throw new Error('Approval action was not found in this project.');
    return row;
  }
  pendingAction(jobId: string): SlackAction | undefined {
    this.get(jobId);
    return this.db.prepare('SELECT * FROM slack_actions WHERE jobId=? AND consumedAt IS NULL ORDER BY rowid DESC LIMIT 1')
      .get(jobId) as unknown as SlackAction | undefined;
  }
  updateThreadTs(id: string, rootTs: string): void {
    if (!/^\d{10,}\.\d{6}$/.test(rootTs)) throw new Error('A valid Slack thread root timestamp is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(id);
      const lock = this.db.prepare('SELECT owner FROM slack_worker_lock WHERE projectId=?').get(this.projectId) as { owner: string } | undefined;
      if (job.status !== 'running' || !this.workerOwner || lock?.owner !== this.workerOwner) throw new Error('Only the claiming worker may update the thread root.');
      this.db.prepare('UPDATE slack_jobs SET threadTs=?,updatedAt=? WHERE id=?').run(rootTs, now(), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Atomically claims one job. A crashed execution is never automatically replayed. */
  claimNext(): SlackJob | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db.prepare('SELECT owner,pid FROM slack_worker_lock WHERE projectId=?').get(this.projectId) as { owner: string; pid: number } | undefined;
      if (lock) {
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) { this.db.exec('COMMIT'); return undefined; }
        this.db.prepare("UPDATE slack_jobs SET status='needs_resume',updatedAt=?,error=? WHERE projectId=? AND status='running'")
          .run(now(), 'Worker stopped during execution. Inspect the persisted run before manually resuming; this task will not be replayed.', this.projectId);
        this.db.prepare('DELETE FROM slack_worker_lock WHERE projectId=?').run(this.projectId);
      }
      const row = this.db.prepare("SELECT * FROM slack_jobs WHERE projectId=? AND status='queued' ORDER BY createdAt,rowid LIMIT 1")
        .get(this.projectId) as JobRow | undefined;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      const owner = randomUUID();
      this.db.prepare('INSERT INTO slack_worker_lock VALUES(?,?,?)').run(this.projectId, owner, process.pid);
      this.db.prepare("UPDATE slack_jobs SET status='running',updatedAt=? WHERE id=?").run(now(), row.id);
      this.db.exec('COMMIT'); this.workerOwner = owner; return this.get(row.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id: string, status: Exclude<SlackJobStatus, 'queued' | 'running'>, result: unknown, error: string | null = null,
    action?: Pick<SlackAction, 'kind' | 'binding'>): SlackAction | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(id);
      const lock = this.db.prepare('SELECT owner FROM slack_worker_lock WHERE projectId=?').get(this.projectId) as { owner: string } | undefined;
      if (job.status !== 'running' || !this.workerOwner || lock?.owner !== this.workerOwner) throw new Error('Only the claiming worker may finish a running job.');
      this.db.prepare('UPDATE slack_jobs SET status=?,resultJson=?,error=?,updatedAt=? WHERE id=?').run(status, JSON.stringify(result), error, now(), id);
      let created: SlackAction | undefined;
      if (action) {
        created = { nonce: randomUUID(), jobId: id, ...action, createdAt: now(), consumedAt: null };
        this.db.prepare('INSERT INTO slack_actions VALUES(?,?,?,?,?,NULL)').run(created.nonce, id, action.kind, action.binding, created.createdAt);
      }
      this.db.prepare('DELETE FROM slack_worker_lock WHERE projectId=? AND owner=?').run(this.projectId, this.workerOwner);
      this.db.exec('COMMIT'); this.workerOwner = undefined; return created;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Consume the approval and queue its exact inputs in the same transaction. */
  queueAction(nonce: string, binding: string, input: unknown): SlackJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const action = this.action(nonce), job = this.get(action.jobId);
      const expected = action.kind === 'review' ? 'awaiting_review' : 'awaiting_approval';
      if (action.consumedAt || action.binding !== binding || job.status !== expected) throw new Error('Approval is stale or has already been used.');
      this.db.prepare('UPDATE slack_actions SET consumedAt=? WHERE nonce=?').run(now(), nonce);
      this.db.prepare("UPDATE slack_jobs SET kind=?,status='queued',inputJson=?,updatedAt=? WHERE id=?")
        .run(action.kind === 'review' ? 'plan' : 'implement', JSON.stringify({ ...Object(input), command: (job.input as { command: string }).command }), now(), job.id);
      this.db.exec('COMMIT'); return this.get(job.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void {
    // Graceful shutdown of an in-flight worker also requires explicit recovery.
    if (this.workerOwner) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE slack_jobs SET status='needs_resume',updatedAt=?,error=? WHERE projectId=? AND status='running'")
          .run(now(), 'Worker closed during execution. Inspect the persisted run before manually resuming.', this.projectId);
        this.db.prepare('DELETE FROM slack_worker_lock WHERE projectId=? AND owner=?').run(this.projectId, this.workerOwner);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.close();
  }
}
