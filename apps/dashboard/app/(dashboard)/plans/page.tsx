'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ListChecks, RefreshCw } from 'lucide-react';
import { PlanCard, type PlanStep } from '@/components/chat/PlanCard';
import { ExecutionStrip, type StepRunStatus } from '@/components/chat/ExecutionStrip';
import { LiveRegion, StatusBadge, type StatusTone } from '@/components/a11y';

type PlanStatus =
  | 'pending'
  | 'approved'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'completed_with_errors';

interface InboxPlan {
  id: string;
  summary: string;
  steps: PlanStep[];
  status: PlanStatus;
  created_at?: string;
  updated_at?: string;
}

function mapStatus(status: string): PlanStatus {
  switch (status) {
    case 'pending':
    case 'approved':
    case 'running':
    case 'completed':
    case 'cancelled':
    case 'completed_with_errors':
      return status;
    default:
      return 'pending';
  }
}

function statusTone(status: PlanStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
    case 'approved':
      return 'info';
    case 'pending':
      return 'warning';
    case 'completed_with_errors':
      return 'danger';
    case 'cancelled':
      return 'neutral';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function normalizePlan(row: Record<string, unknown>): InboxPlan | null {
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;
  const steps = Array.isArray(row.steps) ? (row.steps as PlanStep[]) : [];
  return {
    id,
    summary: typeof row.summary === 'string' ? row.summary : '',
    steps,
    status: mapStatus(String(row.status || 'pending')),
    created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  };
}

export default function PlansPage() {
  const [plans, setPlans] = useState<InboxPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveMessage, setLiveMessage] = useState('');
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [execution, setExecution] = useState<Record<string, { running: boolean; statuses: StepRunStatus[] }>>(
    {}
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ask-ai/plan');
      if (!res.ok) {
        setPlans([]);
        return;
      }
      const data = await res.json();
      const rows = Array.isArray(data.plans) ? data.plans : data.plan ? [data.plan] : [];
      setPlans(rows.map(normalizePlan).filter((p: InboxPlan | null): p is InboxPlan => Boolean(p)));
    } catch {
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const patchPlan = (planId: string, patch: Partial<InboxPlan>) => {
    setPlans((prev) => prev.map((p) => (p.id === planId ? { ...p, ...patch } : p)));
  };

  const handleToggleStep = async (planId: string, index: number, enabled: boolean) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    const steps = plan.steps.map((s, i) => (i === index ? { ...s, enabled } : s));
    patchPlan(planId, { steps });
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          steps: steps.map((s) => ({ id: s.id, description: s.description, enabled: s.enabled })),
        }),
      });
    } catch {
      // keep optimistic steps
    }
  };

  const handleAddInstruction = async (planId: string, instruction: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    const newStep: PlanStep = {
      id: `step-${Date.now()}`,
      description: instruction,
      tool: 'user_instruction',
      action: 'note',
      enabled: true,
    };
    const steps = [...plan.steps, newStep];
    patchPlan(planId, { steps });
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          steps: steps.map((s) => ({
            id: s.id,
            description: s.description,
            tool: s.tool,
            action: s.action,
            enabled: s.enabled,
          })),
        }),
      });
    } catch {
      // keep optimistic steps
    }
  };

  const handleCancel = async (planId: string) => {
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action: 'cancel' }),
      });
    } catch {
      // still mark cancelled locally
    }
    patchPlan(planId, { status: 'cancelled' });
    setLiveMessage('Plan cancelled');
  };

  const handleApprove = async (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setExecutingId(planId);
    setErrors((prev) => ({ ...prev, [planId]: '' }));
    setLiveMessage('Approving plan');

    try {
      if (plan.status === 'pending') {
        const res = await fetch('/api/ask-ai/plan', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, action: 'approve' }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const message = typeof errBody.error === 'string' ? errBody.error : 'Failed to approve plan';
          setErrors((prev) => ({ ...prev, [planId]: message }));
          setLiveMessage(message);
          setExecutingId(null);
          return;
        }
      }

      patchPlan(planId, { status: 'running' });
      const stepIds = plan.steps.map((s) => ({ id: s.id || `step-${s.description}`, description: s.description }));
      let statuses: StepRunStatus[] = stepIds.map(() => ({ status: 'pending' as const }));
      setExecution((prev) => ({ ...prev, [planId]: { running: true, statuses } }));

      const streamRes = await fetch(`/api/ask-ai/execute?planId=${encodeURIComponent(planId)}`);
      if (!streamRes.ok || !streamRes.body) {
        const failMsg = streamRes.status === 409 ? 'This plan was already executed.' : 'Failed to open execution stream';
        setExecution((prev) => ({
          ...prev,
          [planId]: { running: false, statuses: stepIds.map(() => ({ status: 'error' as const, message: failMsg })) },
        }));
        patchPlan(planId, { status: 'approved' });
        setErrors((prev) => ({ ...prev, [planId]: failMsg }));
        setLiveMessage(failMsg);
        setExecutingId(null);
        return;
      }

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawExecutionDone = false;
      let nextStatus: PlanStatus = 'completed';

      const consumeSseChunk = (chunk: string) => {
        let eventType: string | null = null;
        let dataLine = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!eventType || !dataLine) return;
        let evt: { index?: number; message?: string; status?: string } = {};
        try {
          evt = JSON.parse(dataLine);
        } catch {
          return;
        }
        if (eventType === 'step_start' && typeof evt.index === 'number') {
          statuses = statuses.map((s, i) => (i === evt.index ? { status: 'running' as const } : s));
          setExecution((prev) => ({ ...prev, [planId]: { running: true, statuses: [...statuses] } }));
        } else if (eventType === 'step_done' && typeof evt.index === 'number') {
          statuses = statuses.map((s, i) => (i === evt.index ? { status: 'done' as const } : s));
          setExecution((prev) => ({ ...prev, [planId]: { running: true, statuses: [...statuses] } }));
        } else if (eventType === 'step_error' && typeof evt.index === 'number') {
          statuses = statuses.map((s, i) =>
            i === evt.index ? { status: 'error' as const, message: evt.message } : s
          );
          setExecution((prev) => ({ ...prev, [planId]: { running: true, statuses: [...statuses] } }));
        } else if (eventType === 'execution_done') {
          sawExecutionDone = true;
          nextStatus = evt.status === 'completed_with_errors' ? 'completed_with_errors' : 'completed';
          setExecution((prev) => ({ ...prev, [planId]: { running: false, statuses: [...statuses] } }));
          patchPlan(planId, { status: nextStatus });
          setLiveMessage(nextStatus === 'completed' ? 'Plan executed' : 'Plan finished with errors');
        } else if (eventType === 'execution_error') {
          setErrors((prev) => ({ ...prev, [planId]: evt.message || 'Execution error' }));
          patchPlan(planId, { status: 'completed_with_errors' });
          setExecution((prev) => ({ ...prev, [planId]: { running: false, statuses: [...statuses] } }));
          setLiveMessage(evt.message || 'Execution error');
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) consumeSseChunk(chunk);
      }
      if (buffer.trim()) consumeSseChunk(buffer);

      if (!sawExecutionDone) {
        patchPlan(planId, { status: 'completed_with_errors' });
        setExecution((prev) => ({ ...prev, [planId]: { running: false, statuses: [...statuses] } }));
        setLiveMessage('Execution stream ended unexpectedly');
      }
    } catch {
      setErrors((prev) => ({ ...prev, [planId]: 'Connection error during plan execution' }));
      setLiveMessage('Connection error during plan execution');
    } finally {
      setExecutingId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Plans</h1>
          <p className="text-slate-500 text-sm mt-1">
            Pending and in-flight plans. Approve here is the same confirm as Ask AI.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadPlans()}
          className="px-3 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 rounded-xl text-xs font-semibold text-slate-700 inline-flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading plans…</div>
      ) : plans.length === 0 ? (
        <div className="bg-white border border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <ListChecks className="w-10 h-10 text-slate-300 mx-auto" />
          <h2 className="font-serif font-bold text-heading">No plans in the inbox</h2>
          <p className="text-sm text-slate-500">Complex Ask AI runs create a plan here. None are waiting.</p>
        </div>
      ) : (
        <ul className="space-y-6">
          {plans.map((plan) => {
            const run = execution[plan.id];
            const canConfirm = plan.status === 'pending' || plan.status === 'approved';
            return (
              <li key={plan.id} className="bg-white border border-cream-300 rounded-3xl p-4 sm:p-5 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <StatusBadge label={plan.status.replace(/_/g, ' ')} tone={statusTone(plan.status)} />
                  {plan.created_at ? (
                    <span className="text-[10px] font-mono text-slate-400">
                      {new Date(plan.created_at).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {run ? (
                  <ExecutionStrip
                    steps={plan.steps.map((s) => ({ id: s.id, description: s.description }))}
                    statuses={run.statuses}
                    running={run.running}
                  />
                ) : canConfirm ? (
                  <PlanCard
                    planId={plan.id}
                    summary={plan.summary}
                    steps={plan.steps}
                    disabled={executingId === plan.id || plan.status === 'approved'}
                    onApprove={handleApprove}
                    onCancel={handleCancel}
                    onToggleStep={handleToggleStep}
                    onAddInstruction={handleAddInstruction}
                  />
                ) : (
                  <p className="text-sm text-slate-600">{plan.summary || 'Plan'}</p>
                )}
                {errors[plan.id] ? (
                  <p className="mt-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    {errors[plan.id]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
