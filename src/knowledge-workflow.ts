import { join } from 'node:path';
import type { ProjectConfig } from './config.js';
import { hash, type ThreadSnapshot } from './domain.js';
import { renderKnowledgeReport, validateKnowledge, type KnowledgeExtractor } from './knowledge.js';
import { KnowledgeStore, type KnowledgeSearchResult } from './knowledge-store.js';
import { parseThreadUrl } from './slack.js';
import { normalizeSnapshot, safeError, writeArtifact } from './workflow.js';

export interface SaveKnowledgeOptions { config: ProjectConfig; threadUrl: string; collect: () => Promise<ThreadSnapshot>; extractor: KnowledgeExtractor }
export interface SaveKnowledgeResult {
  snapshotId: string; knowledgeSetId: string; reused: boolean; status: 'unreviewed';
  itemCount: number; relationshipCount: number; conflictCount: number; reportPath: string;
}
export async function saveKnowledge(options: SaveKnowledgeOptions): Promise<SaveKnowledgeResult> {
  const { config, extractor } = options;
  parseThreadUrl(options.threadUrl, config.slack);
  const store = new KnowledgeStore(join(config.storageDir, 'knowledge.sqlite'));
  let knowledgeSetId: string | undefined;
  try {
    store.acquireLock();
    const snapshot = normalizeSnapshot(await options.collect(), config, options.threadUrl);
    const { snapshotId, threadId } = store.observe(config.projectId, snapshot);
    if (snapshot.status !== 'complete') throw new Error('Knowledge requires a complete thread snapshot; resolve collection warnings before saving');
    const inputHash = hash({ projectId: config.projectId, workspace: snapshot.workspace, channelId: snapshot.channelId,
      rootTs: snapshot.rootTs, contentHash: snapshot.contentHash, schema: 'domain-knowledge-v1',
      extractor: { name: extractor.name, model: extractor.model, promptVersion: extractor.promptVersion } });
    const previous = store.find(inputHash);
    if (previous && previous.status !== 'complete') throw new Error('Previous knowledge extraction did not complete. Automatic retry is blocked to prevent duplicate API charges; inspect the saved extraction before explicit recovery.');
    const reused = Boolean(previous);
    let draft;
    if (previous) {
      knowledgeSetId = previous.id; draft = store.getDraft(previous.id); store.activate(previous.id);
    } else {
      knowledgeSetId = store.claim(inputHash, snapshotId, threadId, extractor);
      draft = validateKnowledge(await extractor.extract(snapshot), snapshot);
      store.complete(knowledgeSetId, draft, extractor.usage);
    }
    const rows = store.query(config, '', 200, knowledgeSetId);
    const conflictCount = rows.filter(row => row.state === 'conflicting').length;
    const directory = join(config.storageDir, 'knowledge', knowledgeSetId);
    const reportPath = join(directory, 'report.md');
    const savedSnapshot = store.getSnapshot(snapshotId);
    writeArtifact(join(directory, 'snapshot.json'), savedSnapshot);
    writeArtifact(join(directory, 'knowledge.json'), draft);
    writeArtifact(reportPath, renderKnowledgeReport(draft, savedSnapshot, conflictCount), true);
    return { snapshotId, knowledgeSetId, reused, status: 'unreviewed', itemCount: draft.items.length,
      relationshipCount: draft.relationships.length, conflictCount, reportPath };
  } catch (error) {
    const failure = safeError(error);
    if (knowledgeSetId) store.fail(knowledgeSetId, failure, extractor.usage);
    throw new Error(failure.message);
  } finally { store.close(); }
}
export function queryKnowledge(config: ProjectConfig, query = '', limit = 20): KnowledgeSearchResult[] {
  const store = new KnowledgeStore(join(config.storageDir, 'knowledge.sqlite'));
  try { return store.query(config, query, limit); } finally { store.close(); }
}
