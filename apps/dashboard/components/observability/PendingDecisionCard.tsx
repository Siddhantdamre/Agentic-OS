'use client';

import React from 'react';
export interface PendingDecision { id: string; actionType: string; employeeRole: string; payload: Record<string, unknown> | null; expiresAt?: string; }
export function PendingDecisionCard({ decision, onResolve }: { decision: PendingDecision; onResolve: (id: string, status: 'approved' | 'rejected') => void }) {
  const summary = typeof decision.payload?.summary === 'string' ? decision.payload.summary : `Proposed ${decision.actionType.replace(/_/g, ' ')}`;
  return (
    <article className="rounded-2xl border border-cream-300 bg-white p-5 space-y-3 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{decision.employeeRole} · pending</p>
      <h3 className="font-serif text-lg text-heading">{summary}</h3>
      <p className="text-sm text-slate-600">Expiry never approves. Reject or approve explicitly.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onResolve(decision.id, 'approved')} className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-xs font-bold">Approve</button>
        <button type="button" onClick={() => onResolve(decision.id, 'rejected')} className="px-4 py-2 rounded-xl bg-cream-200 text-heading text-xs font-bold">Reject</button>
      </div>
    </article>
  );
}
