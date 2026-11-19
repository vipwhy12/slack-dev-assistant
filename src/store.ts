import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThreadSnapshot } from './domain.js';
import type { AnalysisDraft } from './analysis.js';

export type RunStatus = 'queued' | 'collecting' | 'analyzing' | 'planning' | 'implementing' | 'verifying' | 'needs_input' | 'ready' | 'review_ready' | 'failed' | 'reused' | 'stale';
export interface RunRecord {
  id: string; project_id: string; mode: string; status: RunStatus; created_at: string;
  finished_at: string | null; input_json: string; input_hash: string | null;
  snapshot_id: string | null; error_json: string | null; reused_run_id: string | null;
}
export interface PlanRecord {
  id: string; run_id: string; source_run_id: string; spec_revision_id: string; snapshot_id: string;
  repo_commit_sha: string; config_hash: string; binding_hash: string; created_at: string;
  requirement_ids_json: string; context_json: string; data_json: string;
}
export interface GrantRecord {
  id: string; plan_id: string; binding_hash: string; actor: string; reason: string; allow_pr: number; created_at: string;
}
export interface ImplementationRecord {
  run_id: string; plan_id: string; grant_id: string; checkpoint_json: string;
}
const now = () => new Date().toISOString();
export class RunStore {
  private db: DatabaseSync;
  private lockId?: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, config_json TEXT NOT NULL, config_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), mode TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, input_json TEXT NOT NULL,
        input_hash TEXT, snapshot_id TEXT, error_json TEXT, reused_run_id TEXT REFERENCES runs(id));
      CREATE INDEX IF NOT EXISTS runs_input ON runs(input_hash, status);
      CREATE TABLE IF NOT EXISTS thread_snapshots(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), content_hash TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_versions(snapshot_id TEXT NOT NULL REFERENCES thread_snapshots(id), id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(snapshot_id,id));
      CREATE TABLE IF NOT EXISTS run_steps(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, input_hash TEXT, output_path TEXT, error_json TEXT, attempt INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS spec_revisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), parent_id TEXT REFERENCES spec_revisions(id), created_at TEXT NOT NULL, origin TEXT NOT NULL, review_state TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interventions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), revision_id TEXT NOT NULL REFERENCES spec_revisions(id), created_at TEXT NOT NULL, reason TEXT NOT NULL, minutes REAL NOT NULL CHECK(minutes>=0), actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS process_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_revisions(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), source_run_id TEXT NOT NULL REFERENCES runs(id),
        spec_revision_id TEXT NOT NULL REFERENCES spec_revisions(id), snapshot_id TEXT NOT NULL,
        repo_commit_sha TEXT NOT NULL, config_hash TEXT NOT NULL, binding_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, requirement_ids_json TEXT NOT NULL, context_json TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_grants(
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plan_revisions(id), binding_hash TEXT NOT NULL,
        actor TEXT NOT NULL, reason TEXT NOT NULL, allow_pr INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS implementations(
        run_id TEXT PRIMARY KEY REFERENCES runs(id), plan_id TEXT NOT NULL REFERENCES plan_revisions(id),
        grant_id TEXT NOT NULL UNIQUE REFERENCES execution_grants(id), checkpoint_json TEXT NOT NULL);
      PRAGMA user_version=2;`);
  }
  acquireLock(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const held = this.db.prepare('SELECT owner,pid FROM process_lock WHERE id=1').get() as { owner: string; pid: number } | undefined;
      if (held) {
        let alive = true;
        try { process.kill(held.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error('Another run is active in this storage directory. Retry when it finishes.');
        this.db.prepare('DELETE FROM process_lock WHERE id=1').run();
        const interrupted = JSON.stringify({ code: 'interrupted', message: 'Previous CLI process exited before finishing.', retryable: true });
        this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error_json=? WHERE status IN ('queued','collecting','analyzing','planning','implementing','verifying')").run(now(), interrupted);
        this.db.prepare("UPDATE run_steps SET status='failed',finished_at=?,error_json=? WHERE status='running'").run(now(), interrupted);
      }
      const owner = randomUUID();
      this.db.prepare('INSERT INTO process_lock(id,owner,pid) VALUES(1,?,?)').run(owner, process.pid);
      this.db.exec('COMMIT'); this.lockId = owner;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  releaseLock(): void {
    if (this.lockId) this.db.prepare('DELETE FROM process_lock WHERE owner=?').run(this.lockId);
    this.lockId = undefined;
  }
  close(): void { this.releaseLock(); this.db.close(); }
  saveProject(id: string, config: unknown, configHash: string): void {
    this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,config_hash=excluded.config_hash').run(id, JSON.stringify(config), configHash);
  }
  createRun(projectId: string, input: unknown, mode: 'analyze' | 'plan' | 'implement' = 'analyze'): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs(id,project_id,mode,status,created_at,input_json) VALUES(?,?,?, ?,?,?)').run(id, projectId, mode, 'queued', now(), JSON.stringify(input));
    return id;
  }
  status(id: string, status: RunStatus, error?: unknown): void {
    const terminal = ['ready', 'needs_input', 'review_ready', 'failed', 'reused', 'stale'].includes(status);
    this.db.prepare('UPDATE runs SET status=?,finished_at=?,error_json=? WHERE id=?').run(status, terminal ? now() : null, error ? JSON.stringify(error) : null, id);
  }
  setInputHash(id: string, inputHash: string): void { this.db.prepare('UPDATE runs SET input_hash=? WHERE id=?').run(inputHash, id); }
  findReusable(inputHash: string, projectId: string): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE input_hash=? AND project_id=? AND status IN ('ready','needs_input') AND EXISTS(SELECT 1 FROM spec_revisions s WHERE s.run_id=runs.id) ORDER BY created_at DESC LIMIT 1").get(inputHash, projectId) as unknown as RunRecord | undefined;
  }
  reuse(id: string, previousId: string): void {
    this.db.prepare("UPDATE runs SET status='reused',finished_at=?,reused_run_id=? WHERE id=?").run(now(), previousId, id);
  }
  saveSnapshot(runId: string, snapshot: ThreadSnapshot): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO thread_snapshots VALUES(?,?,?,?)').run(snapshot.id, runId, snapshot.contentHash, JSON.stringify(snapshot));
      const insert = this.db.prepare('INSERT INTO message_versions VALUES(?,?,?)');
      for (const message of snapshot.messages) insert.run(snapshot.id, message.id, JSON.stringify(message));
      this.db.prepare('UPDATE runs SET snapshot_id=? WHERE id=?').run(snapshot.id, runId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getSnapshot(runId: string): ThreadSnapshot {
    const row = this.db.prepare('SELECT data_json FROM thread_snapshots WHERE run_id=?').get(runId) as { data_json: string } | undefined;
    if (!row) throw new Error('Run has no collected snapshot.');
    return JSON.parse(row.data_json) as ThreadSnapshot;
  }
  latestSnapshot(projectId: string, snapshot: ThreadSnapshot): ThreadSnapshot {
    const row = this.db.prepare(`SELECT s.data_json FROM thread_snapshots s JOIN runs r ON r.id=s.run_id
      WHERE r.project_id=? AND json_extract(s.data_json,'$.workspace')=? AND json_extract(s.data_json,'$.channelId')=?
      AND json_extract(s.data_json,'$.rootTs')=? ORDER BY r.rowid DESC LIMIT 1`)
      .get(projectId, snapshot.workspace, snapshot.channelId, snapshot.rootTs) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ThreadSnapshot : snapshot;
  }
  startStep(runId: string, name: string, inputHash: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO run_steps(id,run_id,name,status,started_at,input_hash) VALUES(?,?,?,?,?,?)').run(id, runId, name, 'running', now(), inputHash);
    return id;
  }
  finishStep(id: string, outputPath?: string, error?: unknown): void {
    this.db.prepare('UPDATE run_steps SET status=?,finished_at=?,output_path=?,error_json=? WHERE id=?').run(error ? 'failed' : 'completed', now(), outputPath ?? null, error ? JSON.stringify(error) : null, id);
  }
  addDraft(runId: string, draft: AnalysisDraft): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO spec_revisions VALUES(?,?,?,?,?,?,?)').run(id, runId, null, now(), 'model', 'pending', JSON.stringify(draft));
    return id;
  }
  latestRevision(runId: string): { id: string; origin: string; review_state: string; data_json: string } {
    const revision = this.db.prepare('SELECT id,origin,review_state,data_json FROM spec_revisions WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as { id: string; origin: string; review_state: string; data_json: string } | undefined;
    if (!revision) throw new Error('Run has no analysis to review.');
    return revision;
  }
  review(runId: string, draft: AnalysisDraft, reason: string, minutes: number, actor: string, id = randomUUID()): string {
    if (!reason.trim() || !actor.trim() || !Number.isFinite(minutes) || minutes < 0) throw new Error('Review requires reason, actor, and nonnegative finite minutes.');
    const parent = this.db.prepare('SELECT id FROM spec_revisions WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as {id: string} | undefined;
    if (!parent) throw new Error('Run has no analysis to review.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO spec_revisions VALUES(?,?,?,?,?,?,?)').run(id, runId, parent.id, now(), 'human', 'accepted', JSON.stringify(draft));
      this.db.prepare('INSERT INTO interventions VALUES(?,?,?,?,?,?,?)').run(randomUUID(), runId, id, now(), reason, minutes, actor);
      this.status(runId, draft.questions.some(q => q.blocking) ? 'needs_input' : 'ready');
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    return row as unknown as RunRecord;
  }
  list(projectId: string, limit = 20): RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000.');
    return this.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as unknown as RunRecord[];
  }
  savePlan(plan: Omit<PlanRecord, 'created_at'>): void {
    this.db.prepare('INSERT INTO plan_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(plan.id, plan.run_id, plan.source_run_id,
      plan.spec_revision_id, plan.snapshot_id, plan.repo_commit_sha, plan.config_hash, plan.binding_hash, now(),
      plan.requirement_ids_json, plan.context_json, plan.data_json);
  }
  getPlan(id: string): PlanRecord {
    const plan = this.db.prepare('SELECT * FROM plan_revisions WHERE id=?').get(id) as unknown as PlanRecord | undefined;
    if (!plan) throw new Error(`Plan not found: ${id}`);
    return plan;
  }
  findPlan(inputHash: string, projectId: string): PlanRecord | undefined {
    return this.db.prepare("SELECT p.* FROM plan_revisions p JOIN runs r ON r.id=p.run_id WHERE r.input_hash=? AND r.project_id=? AND r.status IN ('needs_input','ready') ORDER BY r.rowid DESC LIMIT 1").get(inputHash, projectId) as unknown as PlanRecord | undefined;
  }
  grant(planId: string, bindingHash: string, actor: string, reason: string, allowPr: boolean): GrantRecord {
    if (!actor.trim() || !reason.trim()) throw new Error('Plan approval requires an actor and a reason.');
    const grant = { id: randomUUID(), plan_id: planId, binding_hash: bindingHash, actor, reason, allow_pr: allowPr ? 1 : 0, created_at: now() };
    this.db.prepare('INSERT INTO execution_grants VALUES(?,?,?,?,?,?,?)').run(grant.id, grant.plan_id, grant.binding_hash, actor, reason, grant.allow_pr, grant.created_at);
    return grant;
  }
  getGrant(id: string): GrantRecord {
    const row = this.db.prepare('SELECT * FROM execution_grants WHERE id=?').get(id) as unknown as GrantRecord | undefined;
    if (!row) throw new Error(`Execution grant not found: ${id}`);
    return row;
  }
  startImplementation(runId: string, planId: string, grantId: string, checkpoint: unknown): void {
    this.db.prepare('INSERT INTO implementations VALUES(?,?,?,?)').run(runId, planId, grantId, JSON.stringify(checkpoint));
  }
  checkpoint(runId: string, value: unknown): void { this.db.prepare('UPDATE implementations SET checkpoint_json=? WHERE run_id=?').run(JSON.stringify(value), runId); }
  findImplementation(grantId: string): ImplementationRecord | undefined {
    return this.db.prepare('SELECT * FROM implementations WHERE grant_id=?').get(grantId) as unknown as ImplementationRecord | undefined;
  }
  detail(id: string): { run: RunRecord; steps: unknown[]; revisions: unknown[]; interventions: unknown[]; plans: unknown[]; grants: unknown[]; implementation: unknown } {
    return { run: this.getRun(id),
      steps: this.db.prepare('SELECT * FROM run_steps WHERE run_id=? ORDER BY rowid').all(id),
      revisions: this.db.prepare('SELECT * FROM spec_revisions WHERE run_id=? ORDER BY rowid').all(id),
      interventions: this.db.prepare('SELECT * FROM interventions WHERE run_id=? ORDER BY rowid').all(id),
      plans: this.db.prepare('SELECT * FROM plan_revisions WHERE run_id=? OR source_run_id=? ORDER BY rowid').all(id, id),
      grants: this.db.prepare('SELECT g.* FROM execution_grants g JOIN plan_revisions p ON p.id=g.plan_id WHERE p.run_id=? OR p.source_run_id=? ORDER BY g.rowid').all(id, id),
      implementation: this.db.prepare('SELECT * FROM implementations WHERE run_id=?').get(id) ?? null };
  }
}
