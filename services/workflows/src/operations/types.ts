import type { EmployeeRole } from '@darex/shared-types';

export const EMPLOYEE_PRECEDENCE: Record<EmployeeRole, number> = {
  customer: 3,
  operations: 2,
  growth: 1,
};

export const OUTBOUND_DAILY_CAP = 1;
export const DEDUP_MERGE_MIN = 0.85;
export const DEDUP_QUARANTINE_MIN = 0.6;
export const COLD_START_CAP = 0.75;
export const PLAN_STEP_CAP = 5;
export const HEALTHY_BRIEF_LINE = 'Everything else is up to date.';
