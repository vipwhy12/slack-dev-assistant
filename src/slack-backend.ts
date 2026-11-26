import { join } from 'node:path';
import { validateAnalysis } from './analysis.js';
import { BudgetedAnalyzer } from './budgeted-analysis.js';
import type { ProjectConfig } from './config.js';
import { approvePlan, implementPlan, inspectStoredPlan, planRun } from './development.js';
import { hash, type ThreadSnapshot } from './domain.js';
import { OpenAIImplementer } from './generation.js';
import { OpenAIKnowledgeExtractor } from './knowledge.js';
import { saveKnowledge } from './knowledge-workflow.js';
import { OpenAIPlanner, type Planner } from './planning.js';
import { collectThread, createSlackClient, parseThreadUrl } from './slack.js';
import { SlackFeedbackStore, type FeedbackContext, type FeedbackScope, type PostSlackFeedback } from './slack-feedback.js';
import type { SlackAnalysis, SlackFeedbackInput, SlackPlan, SlackProposal, SlackWorkflowBackend } from './slack-service.js';
import { RunStore } from './store.js';
import { analyzeThread, normalizeSnapshot, reviewRun } from './workflow.js';

export interface SlackBackendOptions {
  postFeedback?: PostSlackFeedback;
  /** Inject a read-only collector for offline integration tests. */
  collect?: (url: string, includedMessageTs: string[]) => Promise<ThreadSnapshot>;
}
export function createSlackBackend(config: ProjectConfig, readToken: string, botUserId?: string, botId?: string, options: SlackBackendOptions = {}): SlackWorkflowBackend {
  const read = options.collect ?? ((url: string, includedMessageTs: string[]) => collectThread(url, config.slack, createSlackClient(readToken),
    { excludedUserIds: botUserId ? [botUserId] : [], excludedBotIds: botId ? [botId] : [], includedMessageTs }));
  const feedbackStore = <T>(action: (store: SlackFeedbackStore) => T): T => {
    const store = new SlackFeedbackStore(join(config.storageDir, 'feedback.sqlite'), config.projectId);
    try { return action(store); } finally { store.close(); }
  };
  const scope = (thread: { workspace: string; channelId: string; rootTs: string }): FeedbackScope => ({
    teamId: config.slackApp?.teamId ?? '', appId: config.slackApp?.appId ?? '', ...thread,
  });
  const rootUrl = (snapshot: ThreadSnapshot) => `https://${snapshot.workspace}.slack.com/archives/${snapshot.channelId}/p${snapshot.rootTs.replace('.', '')}`;
  const recordsFor = (thread: { workspace: string; channelId: string; rootTs: string }) => config.slackApp ? feedbackStore(store => store.list(scope(thread))) : [];
  const collect = async (url: string): Promise<{ snapshot: ThreadSnapshot; feedback: FeedbackContext[] }> => {
    const target = parseThreadUrl(url, config.slack);
    let records = recordsFor({ workspace: target.workspace, channelId: target.channelId, rootTs: target.rootTs });
    let snapshot = normalizeSnapshot(await read(url, records.map(record => record.postedTs!)), config, url);
    // A reply URL without thread_ts may discover its real root only on the first read.
    if (snapshot.rootTs !== target.rootTs) {
      records = recordsFor({ workspace: snapshot.workspace, channelId: snapshot.channelId, rootTs: snapshot.rootTs });
      if (records.length) snapshot = normalizeSnapshot(await read(url, records.map(record => record.postedTs!)), config, url);
    }
    const feedback: FeedbackContext[] = [];
    for (const record of records) {
      const message = snapshot.messages.find(message => message.ts === record.postedTs);
      if (!message) continue; // Deleted feedback changes the content hash and invalidates old proposals.
      if (message.text !== record.echoText || !message.author || ![record.botUserId, record.botId].includes(message.author)) throw new Error('Feedback echo does not match its authenticated delivery record.');
      feedbackStore(store => store.linked(record.id, message.id));
      feedback.push({ id: record.id, actor: record.actor, text: record.text, messageVersionId: message.id,
        previousRunId: record.previousRunId, previousRevisionId: record.previousRevisionId, previousPlanId: record.previousPlanId });
    }
    return { snapshot, feedback };
  };
  const storedAnalysis = (runId: string) => {
    const store = new RunStore(join(config.storageDir, 'history.sqlite'), 250);
    try {
      const run = store.getRun(runId);
      if (run.project_id !== config.projectId || run.mode !== 'analyze') throw new Error('Analysis belongs to another project.');
      const snapshot = store.getSnapshot(runId), revision = store.latestRevision(runId);
      const analysis: SlackAnalysis = { runId, revisionId: revision.id, snapshotId: snapshot.id, threadTs: snapshot.rootTs,
        draft: validateAnalysis(JSON.parse(revision.data_json), snapshot),
        evidence: Object.fromEntries(snapshot.messages.map(message => [message.id, { permalink: message.permalink }])) };
      return { snapshot, analysis };
    } finally { store.close(); }
  };
  const inspectAnalysis = (runId: string): SlackAnalysis => storedAnalysis(runId).analysis;
  const inspectPlan = (planId: string): SlackPlan => {
    const { record, plan } = inspectStoredPlan(config, planId);
    const details = plan.items.map(item => `${item.id} (${item.requirementIds.join(', ')})\n현재: ${item.currentBehavior}\n변경: ${item.proposedChanges}\n근거: ${item.codeRefs.map(ref => `${ref.path}: ${ref.quote}`).join('\n')}\n선행 작업: ${item.dependencies.join(', ') || '없음'}`).join('\n\n');
    return { planId, sourceRunId: record.source_run_id, revisionId: record.spec_revision_id, bindingHash: record.binding_hash,
      summary: `${plan.summary}\n\n${details}`, affectedPaths: [...new Set(plan.items.flatMap(item => item.affectedPaths))],
      overview: plan.summary, changes: plan.items.map(({ id, requirementIds, currentBehavior, proposedChanges, dependencies }) => ({ id, requirementIds, currentBehavior, proposedChanges, dependencies })),
      checks: [...config.development!.commands.map(command => `${command.id}: ${command.program} ${command.args.join(' ')}`),
        ...plan.items.flatMap(item => item.acceptanceChecks.map(check => `${check.criterionId}: ${check.commandId ?? '수동 확인'} — ${check.testName}`))],
      blockers: plan.items.flatMap(item => item.blockers), repository: config.github?.repository ?? config.repoPath!, baseCommit: record.repo_commit_sha,
      sideEffects: plan.sideEffects ?? [] };
  };
  const authorizeActor = (actor: string) => {
    if (!config.slackApp || !config.slackApp.allowedUserIds.includes(actor) || !config.slackApp.approverUserIds.includes(actor)) throw new Error('This actor is not authorized to approve or revise Slack proposals.');
  };
  const localProposal = (proposal: SlackProposal): { snapshot: ThreadSnapshot; proposal: SlackProposal } => {
    const { snapshot, analysis } = storedAnalysis(proposal.analysis.runId);
    if (hash(analysis) !== hash(proposal.analysis)) throw new Error('Analysis changed after the proposal was displayed.');
    const plan = proposal.plan ? inspectPlan(proposal.plan.planId) : undefined;
    if (plan && (plan.sourceRunId !== analysis.runId || plan.revisionId !== analysis.revisionId || hash(plan) !== hash(proposal.plan))) throw new Error('Plan changed after the proposal was displayed.');
    return { snapshot, proposal: { analysis, ...(plan ? { plan } : {}) } };
  };
  const currentSource = async (snapshot: ThreadSnapshot) => {
    const current = await collect(rootUrl(snapshot));
    if (current.snapshot.status !== 'complete' || current.snapshot.contentHash !== snapshot.contentHash) throw new Error('Slack source changed after the proposal was displayed. Analyze the current thread before approving.');
  };
  // Button/modal freshness checks must fit Slack's acknowledgement/trigger window.
  // Live source checks belong to the durable worker before paid work or execution.
  const inspectProposal = (proposal: SlackProposal): SlackProposal => localProposal(proposal).proposal;
  const appendFeedback = async (threadUrl: string, input: SlackFeedbackInput) => {
    authorizeActor(input.actor);
    if (!options.postFeedback) throw new Error('Slack feedback posting is not configured.');
    const { snapshot } = localProposal(input.previous);
    const target = parseThreadUrl(threadUrl, config.slack);
    if (target.channelId !== snapshot.channelId || target.rootTs !== snapshot.rootTs && !snapshot.messages.some(message => message.ts === target.messageTs)) throw new Error('Feedback belongs to another Slack thread.');
    const submission = { ...scope({ workspace: snapshot.workspace, channelId: snapshot.channelId, rootTs: snapshot.rootTs }),
      id: input.id, actor: input.actor, text: input.text, previousRunId: input.previous.analysis.runId,
      previousRevisionId: input.previous.analysis.revisionId, previousPlanId: input.previous.plan?.planId ?? null,
      previousProposalHash: hash(input.previous), botUserId: botUserId ?? null, botId: botId ?? null };
    if (!feedbackStore(store => store.get(input.id))) {
      await currentSource(snapshot);
      localProposal(input.previous);
    }
    const { record, shouldPost } = feedbackStore(store => store.begin(submission));
    if (shouldPost) {
      try {
        const result = await options.postFeedback({ feedbackId: record.id, channelId: record.channelId, threadTs: record.rootTs, actor: record.actor, text: record.echoText });
        feedbackStore(store => store.posted(record.id, result.ts));
      } catch {
        feedbackStore(store => store.uncertain(record.id));
        throw new Error('Feedback delivery is uncertain. Inspect the thread before explicit recovery; automatic repost is blocked.');
      }
    }
  };
  const analyze = async (threadUrl: string, previous?: SlackFeedbackInput): Promise<SlackAnalysis> => {
    if (previous) await appendFeedback(threadUrl, previous);
    const { snapshot, feedback } = await collect(threadUrl);
    if (previous && !feedback.some(entry => entry.id === previous.id)) throw new Error('Posted feedback is not yet present in the complete source snapshot. Retry only after checking its delivery receipt.');
    const result = await analyzeThread({ config, threadUrl, collect: async () => snapshot,
      analyzer: new BudgetedAnalyzer(config, threadUrl, { feedback: { entries: feedback, ...(previous ? { previousProposal: previous.previous } : {}) } }) });
    if (!result.reportPath) throw new Error('Thread collection was incomplete. Resolve collection warnings before analysis.');
    return inspectAnalysis(result.runId);
  };
  return {
    async save(threadUrl) {
      const { snapshot } = await collect(threadUrl);
      const result = await saveKnowledge({ config, threadUrl, collect: async () => snapshot, extractor: new OpenAIKnowledgeExtractor(config) });
      return { threadTs: snapshot.rootTs, documentId: result.knowledgeSetId, factCount: result.itemCount,
        summary: `${result.reused ? '기존 결과 재사용' : '저장 완료'} · 관계 ${result.relationshipCount}개 · 충돌 ${result.conflictCount}개\n저장한 지식은 아직 사람의 검토를 받지 않은 정보입니다.` };
    },
    analyze, inspectAnalysis, inspectPlan, inspectProposal,
    async prepareProposal(threadUrl, feedback) {
      const analysis = await analyze(threadUrl, feedback);
      const requirementIds = analysis.draft.requirements.filter(requirement => !['rejected', 'superseded'].includes(requirement.decisionState)).map(requirement => requirement.id);
      if (!requirementIds.length) return { analysis };
      const result = await planRun({ config, sourceRunId: analysis.runId, planner: new OpenAIPlanner(config), requirementIds, expectedRevisionId: analysis.revisionId });
      return { analysis, plan: inspectPlan(result.planId) };
    },
    async approveProposal({ proposal, actor, reason }) {
      authorizeActor(actor);
      const stored = localProposal(proposal);
      await currentSource(stored.snapshot);
      const exact = localProposal(proposal).proposal;
      if (!exact.plan) throw new Error('Proposal has no implementation plan.');
      const selected = exact.analysis.draft.requirements.filter(requirement => !['rejected', 'superseded'].includes(requirement.decisionState));
      if (!selected.length || selected.some(requirement => requirement.blockingQuestionIds.length) || exact.analysis.draft.questions.some(question => question.blocking) || exact.plan.blockers.length) throw new Error('Proposal has unresolved blocking questions or no eligible requirements.');
      const preview = inspectStoredPlan(config, exact.plan.planId);
      const requirementIds = selected.map(requirement => requirement.id);
      if (hash(preview.requirementIds) !== hash(requirementIds)) throw new Error('Plan does not cover exactly the displayed eligible requirements.');
      const draft = structuredClone(exact.analysis.draft);
      for (const requirement of draft.requirements) if (requirementIds.includes(requirement.id)) requirement.decisionState = 'confirmed';
      const reviewed = reviewRun(config, exact.analysis.runId, draft, reason, 0, actor, exact.analysis.revisionId);
      // Only rebind the displayed immutable plan to this human review. Never ask a model to change it after Y.
      const replay: Planner = { name: 'human-approved-preview', model: 'offline', promptVersion: `rebind-v1:${preview.record.binding_hash}`,
        async plan(input) {
          if (hash(input.context) !== hash(preview.context) || hash(input.requirementIds) !== hash(preview.requirementIds)) throw new Error('Repository context changed while approving the displayed plan.');
          return structuredClone(preview.plan);
        } };
      const rebound = await planRun({ config, sourceRunId: exact.analysis.runId, planner: replay, requirementIds, expectedRevisionId: reviewed.revisionId });
      const accepted = inspectStoredPlan(config, rebound.planId);
      if (hash(accepted.plan) !== hash(preview.plan) || hash(accepted.context) !== hash(preview.context)) throw new Error('Approved plan differs from the displayed preview.');
      await currentSource(accepted.snapshot);
      const grant = approvePlan(config, rebound.planId, reason, actor, true, accepted.record.binding_hash);
      return implementPlan({ config, planId: rebound.planId, grantId: grant.grantId, implementer: new OpenAIImplementer(config), publish: true });
    },
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
