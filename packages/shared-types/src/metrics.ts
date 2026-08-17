/** Semantic metrics, Insight cards, evals, and learning-loop contracts. */

export const METRIC_VALUE_KINDS = ['count', 'sum', 'ratio', 'currency'] as const;

export type MetricValueKind = (typeof METRIC_VALUE_KINDS)[number];

export interface MetricDefinition {
  id: string;
  description: string;
  valueKind: MetricValueKind;
  sql?: string;
  source?: string;
  insightCopy?: string;
  recommendedAction?: string;
  packId?: string;
}

export interface MetricQueryRequest {
  orgId: string;
  metricIds: string[];
  from: string;
  to: string;
}

export interface MetricPoint {
  metricId: string;
  value: number;
  from: string;
  to: string;
}

export interface MetricQueryResult {
  orgId: string;
  points: MetricPoint[];
  gaps: string[];
}

export const INSIGHT_CARD_STATUSES = ['ok', 'gap', 'stale'] as const;

export type InsightCardStatus = (typeof INSIGHT_CARD_STATUSES)[number];

export interface InsightCard {
  id: string;
  orgId: string;
  metricId: string;
  title: string;
  narrative: string;
  value: number;
  status: InsightCardStatus;
  recommendedWorkflow?: string | null;
  generatedAt: string;
}

export interface OrgCostSnapshot {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  llmTokens: number;
  estimatedCostMinor: number;
  currency: string;
}

export const EVAL_RUN_STATUSES = ['pending', 'running', 'passed', 'failed'] as const;

export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export interface GoldenConversation {
  id: string;
  packId: string;
  prompt: string;
  expectedFacts: string[];
  mustNotInvent: string[];
}

export interface EvalRun {
  id: string;
  packId: string;
  status: EvalRunStatus;
  goldenId: string;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

export type FeedbackVote = 'up' | 'down';

export interface AskAiFeedback {
  orgId: string;
  conversationId: string;
  vote: FeedbackVote;
  userId: string;
  createdAt: string;
}

export interface PlanPromotion {
  orgId: string;
  planId: string;
  playbookId: string;
  namedByUserId: string;
  createdAt: string;
}
