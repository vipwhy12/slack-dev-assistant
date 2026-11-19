import { join } from 'node:path';
import { validateAnalysis } from './analysis.js';
import { BudgetedAnalyzer } from './budgeted-analysis.js';
import type { ProjectConfig } from './config.js';
import { approvePlan, implementPlan, inspectStoredPlan, planRun } from './development.js';
import { OpenAIImplementer } from './generation.js';
import { OpenAIKnowledgeExtractor } from './knowledge.js';
import { saveKnowledge } from './knowledge-workflow.js';
import { OpenAIPlanner } from './planning.js';
import { collectThread, createSlackClient } from './slack.js';
import type { SlackAnalysis, SlackPlan, SlackWorkflowBackend } from './slack-service.js';
import { RunStore } from './store.js';
import { analyzeThread, reviewRun } from './workflow.js';

export function createSlackBackend(config: ProjectConfig, readToken: string, botUserId?: string, botId?: string): SlackWorkflowBackend {
  const collect = (url: string) => collectThread(url, config.slack, createSlackClient(readToken), { excludedUserIds: botUserId ? [botUserId] : [], excludedBotIds: botId ? [botId] : [] });
  const inspectAnalysis = (runId: string): SlackAnalysis => {
    const store = new RunStore(join(config.storageDir, 'history.sqlite'), 250);
    try {
      const run = store.getRun(runId);
      if (run.project_id !== config.projectId || run.mode !== 'analyze') throw new Error('Analysis belongs to another project.');
      const snapshot = store.getSnapshot(runId), revision = store.latestRevision(runId);
      return { runId, revisionId: revision.id, snapshotId: snapshot.id, threadTs: snapshot.rootTs, draft: validateAnalysis(JSON.parse(revision.data_json), snapshot) };
    } finally { store.close(); }
  };
  const inspectPlan = (planId: string): SlackPlan => {
    const { record, plan } = inspectStoredPlan(config, planId);
    // Include the actual proposed changes and evidence in the approval view, not just a model summary.
    const details = plan.items.map(item => `${item.id} (${item.requirementIds.join(', ')})\n현재: ${item.currentBehavior}\n변경: ${item.proposedChanges}\n근거: ${item.codeRefs.map(ref => `${ref.path}: ${ref.quote}`).join('\n')}\n선행 작업: ${item.dependencies.join(', ') || '없음'}`).join('\n\n');
    return { planId, sourceRunId: record.source_run_id, revisionId: record.spec_revision_id, bindingHash: record.binding_hash,
      summary: `${plan.summary}\n\n${details}`, affectedPaths: [...new Set(plan.items.flatMap(item => item.affectedPaths))],
      checks: [...config.development!.commands.map(command => `${command.id}: ${command.program} ${command.args.join(' ')}`),
        ...plan.items.flatMap(item => item.acceptanceChecks.map(check => `${check.criterionId}: ${check.commandId ?? '수동 확인'} — ${check.testName}`))],
      blockers: plan.items.flatMap(item => item.blockers), repository: config.github?.repository ?? config.repoPath!, baseCommit: record.repo_commit_sha };
  };
  return {
    async save(threadUrl) {
      const snapshot = await collect(threadUrl);
      const result = await saveKnowledge({ config, threadUrl, collect: async () => snapshot, extractor: new OpenAIKnowledgeExtractor(config) });
      return { threadTs: snapshot.rootTs, documentId: result.knowledgeSetId, factCount: result.itemCount,
        summary: `${result.reused ? '기존 결과 재사용' : '저장 완료'} · 관계 ${result.relationshipCount}개 · 충돌 ${result.conflictCount}개\n저장한 지식은 아직 사람의 검토를 받지 않은 정보입니다.` };
    },
    async analyze(threadUrl) {
      const snapshot = await collect(threadUrl);
      const result = await analyzeThread({ config, threadUrl, collect: async () => snapshot, analyzer: new BudgetedAnalyzer(config, threadUrl) });
      if (!result.reportPath) throw new Error('Thread collection was incomplete. Resolve collection warnings before analysis.');
      return { ...inspectAnalysis(result.runId), threadTs: snapshot.rootTs };
    },
    inspectAnalysis, inspectPlan,
    async reviewAndPlan(input) {
      const reviewed = reviewRun(config, input.runId, input.draft, input.reason, 0, input.actor, input.revisionId);
      const result = await planRun({ config, sourceRunId: input.runId, planner: new OpenAIPlanner(config),
        requirementIds: input.requirementIds, expectedRevisionId: reviewed.revisionId });
      return inspectPlan(result.planId);
    },
    async approveAndImplement(input) {
      const grant = approvePlan(config, input.planId, input.reason, input.actor, true, input.bindingHash);
      return implementPlan({ config, planId: input.planId, grantId: grant.grantId, implementer: new OpenAIImplementer(config), publish: true });
    },
  };
}
