/** Ask AI classify + plan-confirm-execute types. */

export type ClassifyType = 'simple' | 'complex';

export interface ClassifyResult {
  type: ClassifyType;
  confidence: number;
  usedFallback: boolean;
  model?: string;
  /** Named pack playbook when the matcher/classifier is confident (O6). */
  playbookId?: string | null;
}

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  action: string;
  payload?: Record<string, any>;
  enabled: boolean;
}

export interface GeneratedPlan {
  reasoning: string;
  steps: PlanStep[];
  draft: string;
  summary: string;
}

export type AgentPlanStatus =
  | 'pending'
  | 'approved'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'failed';
