/** Audit events, DSR, and actor contracts. */

import type { DataClass, RiskClass } from './risk.js';

export const AUDIT_EVENT_KINDS = [
  'tool.execute',
  'plan.approve',
  'plan.reject',
  'plan.execute',
  'connector.connect',
  'connector.disconnect',
  'memory.write',
  'memory.delete',
  'memory.correct',
  'pack.install',
  'pack.uninstall',
  'dsr.export',
  'dsr.delete',
  'role.change',
  'login',
  'confirm.override',
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export const AUDIT_RESULT_STATUSES = ['ok', 'error', 'denied'] as const;

export type AuditResultStatus = (typeof AUDIT_RESULT_STATUSES)[number];

export type AuditActor =
  | { actorType: 'user'; userId: string }
  | { actorType: 'employee'; employeeId: string }
  | { actorType: 'system'; component: string };

export const ORG_HUMAN_ROLES = ['owner', 'admin', 'member', 'auditor', 'billing'] as const;

export type OrgHumanRole = (typeof ORG_HUMAN_ROLES)[number];

/**
 * The single source of truth for which human roles may call pay tools
 * (SEC-R01): shared so every enforcement point — the direct tool route in
 * the dashboard and the pay-risk gate in the workflows executor — checks the
 * same rule instead of each keeping its own copy that can drift apart.
 */
export function canCallPayTools(role: OrgHumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

interface AuditEventBase {
  id: string;
  orgId: string;
  actor: AuditActor;
  createdAt: string;
  workItemId?: string;
  langfuseTraceId?: string;
  resultStatus: AuditResultStatus;
  dataClasses?: DataClass[];
}

export type AuditEvent =
  | (AuditEventBase & {
      kind: 'tool.execute';
      tool: string;
      action: string;
      riskClass: RiskClass;
      confirmId?: string;
      model?: string;
      promptHash?: string;
    })
  | (AuditEventBase & {
      kind: 'plan.approve';
      planId: string;
      approverUserId: string;
    })
  | (AuditEventBase & {
      kind: 'plan.reject';
      planId: string;
      actorUserId: string;
    })
  | (AuditEventBase & {
      kind: 'plan.execute';
      planId: string;
      riskClass: RiskClass;
    })
  | (AuditEventBase & {
      kind: 'connector.connect';
      connectorKey: string;
    })
  | (AuditEventBase & {
      kind: 'connector.disconnect';
      connectorKey: string;
    })
  | (AuditEventBase & {
      kind: 'memory.write';
      memoryId: string;
    })
  | (AuditEventBase & {
      kind: 'memory.delete';
      memoryId: string;
    })
  | (AuditEventBase & {
      kind: 'memory.correct';
      memoryId: string;
    })
  | (AuditEventBase & {
      kind: 'pack.install';
      packId: string;
    })
  | (AuditEventBase & {
      kind: 'pack.uninstall';
      packId: string;
    })
  | (AuditEventBase & {
      kind: 'dsr.export';
      dsrRequestId: string;
    })
  | (AuditEventBase & {
      kind: 'dsr.delete';
      dsrRequestId: string;
    })
  | (AuditEventBase & {
      kind: 'role.change';
      targetUserId: string;
      fromRole: OrgHumanRole;
      toRole: OrgHumanRole;
    })
  | (AuditEventBase & {
      kind: 'login';
      method: 'password' | 'sso' | 'invite';
    })
  | (AuditEventBase & {
      kind: 'confirm.override';
      riskClass: RiskClass;
      confirmId: string;
    });

export const DSR_KINDS = ['export', 'delete'] as const;

export type DsrKind = (typeof DSR_KINDS)[number];

export const DSR_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;

export type DsrStatus = (typeof DSR_STATUSES)[number];

export type DsrRequest =
  | {
      kind: 'export';
      id: string;
      orgId: string;
      status: DsrStatus;
      requestedByUserId: string;
      includeMemory: boolean;
      includeFiles: boolean;
      createdAt: string;
      completedAt?: string | null;
      error?: string | null;
    }
  | {
      kind: 'delete';
      id: string;
      orgId: string;
      status: DsrStatus;
      requestedByUserId: string;
      includeVectors: true;
      createdAt: string;
      completedAt?: string | null;
      error?: string | null;
    };
