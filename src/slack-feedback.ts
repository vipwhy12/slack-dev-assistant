import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, timestampSchema } from './domain.js';

export interface FeedbackScope { teamId: string; appId: string; workspace: string; channelId: string; rootTs: string }
export interface FeedbackInput extends FeedbackScope {
  id: string; actor: string; text: string; previousRunId: string; previousRevisionId: string;
  previousPlanId: string | null; previousProposalHash: string; botUserId: string | null; botId: string | null;
}
export interface FeedbackRecord extends FeedbackInput {
  projectId: string; bindingHash: string; echoText: string; status: 'posting' | 'posted' | 'linked' | 'uncertain';
  postedTs: string | null; messageVersionId: string | null; createdAt: string; updatedAt: string; error: string | null;
}
export interface FeedbackContext {
  id: string; actor: string; text: string; messageVersionId: string;
  previousRunId: string; previousRevisionId: string; previousPlanId: string | null;
}
export interface SlackFeedbackPost { feedbackId: string; channelId: string; threadTs: string; actor: string; text: string }
export type PostSlackFeedback = (input: SlackFeedbackPost) => Promise<{ ts: string }>;
const now = () => new Date().toISOString();
export function feedbackEcho(input: Pick<FeedbackInput, 'id' | 'actor' | 'text'>): string {
  return `[사용자 피드백 · ${input.actor}]\n피드백 ID: ${input.id}\n${input.text}\n\n이 메시지는 사용자가 제출한 수정 의견의 기록입니다. 구현 승인으로 사용하지 않습니다.`;
}

/** Durable, actor-bound provenance for exactly the assistant echoes accepted as human feedback. */
export class SlackFeedbackStore {
  private readonly db: DatabaseSync;
  constructor(path: string, readonly projectId: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS slack_feedback (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, teamId TEXT NOT NULL, appId TEXT NOT NULL,
        workspace TEXT NOT NULL, channelId TEXT NOT NULL, rootTs TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL,
        previousRunId TEXT NOT NULL, previousRevisionId TEXT NOT NULL, previousPlanId TEXT, previousProposalHash TEXT NOT NULL,
        botUserId TEXT, botId TEXT, bindingHash TEXT NOT NULL, echoText TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('posting','posted','linked','uncertain')), postedTs TEXT,
        messageVersionId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT,
        UNIQUE(projectId,workspace,channelId,postedTs));
      CREATE INDEX IF NOT EXISTS slack_feedback_thread ON slack_feedback(projectId,workspace,channelId,rootTs,status);`);
  }
  get(id: string): FeedbackRecord | undefined {
    return this.db.prepare('SELECT * FROM slack_feedback WHERE id=? AND projectId=?').get(id, this.projectId) as unknown as FeedbackRecord | undefined;
  }
  begin(input: FeedbackInput): { record: FeedbackRecord; shouldPost: boolean } {
    if (!/^[A-Za-z0-9:._-]{1,520}$/.test(input.id) || !/^U[A-Z0-9]+$/.test(input.actor) || !input.text.trim() || input.text.length > 3000 || !input.botUserId && !input.botId) throw new Error('Feedback requires a stable ID, authorized Slack actor, bounded text and assistant identity.');
    timestampSchema.parse(input.rootTs);
    const bindingHash = hash(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(input.id);
      if (existing) {
        if (existing.bindingHash !== bindingHash) throw new Error('Feedback ID is already bound to a different actor, scope, text or proposal.');
        if (existing.status === 'posting' || existing.status === 'uncertain') throw new Error('Feedback delivery is uncertain; inspect the Slack thread before explicit recovery. Automatic repost is blocked.');
        this.db.exec('COMMIT'); return { record: existing, shouldPost: false };
      }
      const time = now();
      this.db.prepare(`INSERT INTO slack_feedback(id,projectId,teamId,appId,workspace,channelId,rootTs,actor,text,
        previousRunId,previousRevisionId,previousPlanId,previousProposalHash,botUserId,botId,bindingHash,echoText,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posting',?,?)`).run(input.id,this.projectId,input.teamId,input.appId,input.workspace,input.channelId,input.rootTs,
          input.actor,input.text,input.previousRunId,input.previousRevisionId,input.previousPlanId,input.previousProposalHash,
          input.botUserId,input.botId,bindingHash,feedbackEcho(input),time,time);
      this.db.exec('COMMIT'); return { record: this.get(input.id)!, shouldPost: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  posted(id: string, ts: string): FeedbackRecord {
    timestampSchema.parse(ts);
    const result = this.db.prepare("UPDATE slack_feedback SET status='posted',postedTs=?,updatedAt=? WHERE id=? AND projectId=? AND status='posting'").run(ts,now(),id,this.projectId);
    if (result.changes !== 1) throw new Error('Feedback was not waiting for its delivery receipt.');
    return this.get(id)!;
  }
  uncertain(id: string): void {
    this.db.prepare("UPDATE slack_feedback SET status='uncertain',error=?,updatedAt=? WHERE id=? AND projectId=? AND status='posting'")
      .run('Delivery did not return a valid receipt. Inspect the thread; do not automatically repost.',now(),id,this.projectId);
  }
  list(scope: FeedbackScope): FeedbackRecord[] {
    return this.db.prepare("SELECT * FROM slack_feedback WHERE projectId=? AND teamId=? AND appId=? AND workspace=? AND channelId=? AND rootTs=? AND status IN ('posted','linked') ORDER BY createdAt,id")
      .all(this.projectId,scope.teamId,scope.appId,scope.workspace,scope.channelId,scope.rootTs) as unknown as FeedbackRecord[];
  }
  linked(id: string, messageVersionId: string): void {
    const record = this.get(id);
    if (!record || !['posted','linked'].includes(record.status) || record.messageVersionId && record.messageVersionId !== messageVersionId) throw new Error('Feedback source version changed.');
    this.db.prepare("UPDATE slack_feedback SET status='linked',messageVersionId=?,updatedAt=? WHERE id=? AND projectId=?").run(messageVersionId,now(),id,this.projectId);
  }
  close(): void { this.db.close(); }
}
