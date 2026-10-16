import { trigramSimilarity } from '../operations/dedup-engine.js';

/**
 * CE-10 Knowledge Gap Finder — dashboard clustering.
 *
 * Confidence-gate failures (activities/index.ts) already log the customer's
 * verbatim question onto agent_decision_ledger.context_payload. A founder
 * reviewing that as a flat list of hundreds of rows can't tell "same missing
 * SOP topic asked 40 times" from "40 unrelated one-off questions". This
 * groups near-duplicate questions so the dashboard can surface topics to
 * turn into FAQ/SOP entries, ranked by how often they recur.
 *
 * No embedding model required: trigramSimilarity (reused from the OE-06
 * company dedup engine) is a fast, dependency-free string-similarity score
 * that is good enough for "is this substantially the same question" —
 * simple threshold grouping, not k-means or anything ML-based.
 */

const GAP_CLUSTER_SIMILARITY = 0.35;
const MAX_EXAMPLES_PER_CLUSTER = 3;
const MAX_TOPIC_CHARS = 160;

export interface GapQuestionRow {
  question: string;
  createdAt: string;
}

export interface KnowledgeGapCluster {
  topic: string;
  count: number;
  examples: string[];
  lastSeen: string;
}

export function clusterGapQuestions(
  rows: GapQuestionRow[],
  threshold: number = GAP_CLUSTER_SIMILARITY
): KnowledgeGapCluster[] {
  const clusters: { representative: string; members: GapQuestionRow[] }[] = [];

  for (const row of rows) {
    const question = row.question.trim();
    if (!question) continue;

    let target = clusters.find(
      (cluster) => trigramSimilarity(cluster.representative, question) >= threshold
    );
    if (!target) {
      target = { representative: question, members: [] };
      clusters.push(target);
    }
    target.members.push({ ...row, question });
  }

  return clusters
    .map((cluster) => ({
      topic: cluster.representative.slice(0, MAX_TOPIC_CHARS),
      count: cluster.members.length,
      examples: Array.from(new Set(cluster.members.map((m) => m.question))).slice(
        0,
        MAX_EXAMPLES_PER_CLUSTER
      ),
      lastSeen: cluster.members.reduce(
        (max, m) => (m.createdAt > max ? m.createdAt : max),
        cluster.members[0].createdAt
      ),
    }))
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
