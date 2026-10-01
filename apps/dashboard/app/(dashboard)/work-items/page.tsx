'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRealtimeStream } from '@/lib/use-realtime-stream';
import {
  CheckSquare,
  RefreshCw,
  Clock,
  AlertTriangle,
  CheckCircle2,
  List,
  Columns3,
} from 'lucide-react';
import { LiveRegion, StatusBadge, type StatusTone } from '@/components/a11y';

type WorkItemStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_approval'
  | 'needs_attention'
  | 'done'
  | 'cancelled'
  | string;

type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent' | string;

interface WorkItem {
  id: string;
  type: string;
  status: WorkItemStatus;
  assigneeEmployeeId: string | null;
  conversationId: string | null;
  channel: string | null;
  priority: WorkItemPriority;
  dueAt: string | null;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  temporalWorkflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

type ViewMode = 'kanban' | 'list';

const KANBAN_COLUMNS: Array<{ id: string; label: string; tone: StatusTone; match: (s: string) => boolean }> = [
  { id: 'open', label: 'Backlog', tone: 'neutral', match: (s) => s === 'open' },
  {
    id: 'in_progress',
    label: 'In Progress',
    tone: 'info',
    match: (s) => s === 'in_progress' || s === 'running',
  },
  {
    id: 'waiting_approval',
    label: 'Needs Approval',
    tone: 'warning',
    match: (s) => s === 'waiting_approval' || s === 'needs_attention',
  },
  {
    id: 'done',
    label: 'Completed',
    tone: 'success',
    match: (s) => s === 'done' || s === 'completed' || s === 'cancelled',
  },
];

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'done':
    case 'completed':
      return 'success';
    case 'in_progress':
    case 'running':
      return 'info';
    case 'waiting_approval':
    case 'needs_attention':
      return 'warning';
    case 'cancelled':
      return 'danger';
    case 'open':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function priorityTone(priority: string): StatusTone {
  switch (priority) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warning';
    case 'low':
      return 'neutral';
    case 'normal':
      return 'info';
    default:
      return 'neutral';
  }
}

function itemTitle(item: WorkItem): string {
  const meta = item.metadata || {};
  const card = meta.card && typeof meta.card === 'object' ? (meta.card as Record<string, unknown>) : null;
  const fromCard =
    (card && typeof card.summary === 'string' && card.summary) ||
    (card && typeof card.companyName === 'string' && card.companyName) ||
    (card && typeof card.title === 'string' && card.title);
  const fromMeta =
    (typeof meta.summary === 'string' && meta.summary) ||
    (typeof meta.title === 'string' && meta.title);
  const fromPayload =
    (typeof item.payload?.summary === 'string' && item.payload.summary) ||
    (typeof item.payload?.title === 'string' && item.payload.title);
  return String(fromCard || fromMeta || fromPayload || item.type || 'Work item');
}

function normalizeItem(row: Record<string, unknown>): WorkItem | null {
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;
  return {
    id,
    type: typeof row.type === 'string' ? row.type : 'task',
    status: typeof row.status === 'string' ? row.status : 'open',
    assigneeEmployeeId: typeof row.assigneeEmployeeId === 'string' ? row.assigneeEmployeeId : null,
    conversationId: typeof row.conversationId === 'string' ? row.conversationId : null,
    channel: typeof row.channel === 'string' ? row.channel : null,
    priority: typeof row.priority === 'string' ? row.priority : 'normal',
    dueAt: typeof row.dueAt === 'string' ? row.dueAt : null,
    metadata: row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {},
    payload: row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {},
    temporalWorkflowId: typeof row.temporalWorkflowId === 'string' ? row.temporalWorkflowId : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}

interface EmployeeOption {
  id: string;
  name: string;
}

const PRIORITY_OPTIONS = ['low', 'normal', 'high', 'urgent'] as const;

async function mutate(
  url: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function decide(workItemId: string, action: 'approve' | 'reject'): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/work-items/${workItemId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function ItemControls({
  item,
  busy,
  employees,
  onPatch,
}: {
  item: WorkItem;
  busy: boolean;
  employees: EmployeeOption[];
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}) {
  const terminal = item.status === 'done' || item.status === 'completed' || item.status === 'cancelled';
  if (terminal) return null;
  return (
    <div className="flex gap-2">
      <select
        aria-label="Priority"
        value={item.priority}
        disabled={busy}
        onChange={(e) => onPatch(item.id, { priority: e.target.value })}
        className="flex-1 min-w-0 rounded-lg border border-cream-300 bg-white px-1.5 py-1 text-[11px]"
      >
        {PRIORITY_OPTIONS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        aria-label="Assignee"
        value={item.assigneeEmployeeId ?? ''}
        disabled={busy}
        onChange={(e) => onPatch(item.id, { assigneeEmployeeId: e.target.value || null })}
        className="flex-1 min-w-0 rounded-lg border border-cream-300 bg-white px-1.5 py-1 text-[11px]"
      >
        <option value="">Unassigned</option>
        {employees.map((emp) => (
          <option key={emp.id} value={emp.id}>
            {emp.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function WorkItemCard({
  item,
  busy,
  onDecide,
  employees,
  onPatch,
}: {
  item: WorkItem;
  busy: boolean;
  onDecide: (id: string, action: 'approve' | 'reject') => void;
  employees: EmployeeOption[];
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}) {
  const needsApproval = item.status === 'waiting_approval' || item.status === 'needs_attention';
  return (
    <li className="bg-white border border-cream-300 rounded-xl p-3 text-xs space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-heading leading-snug">{itemTitle(item)}</p>
        <StatusBadge label={item.priority} tone={priorityTone(item.priority)} />
      </div>
      <p className="text-slate-500 font-mono text-[10px]">{item.type}</p>
      <div className="flex flex-wrap gap-2 text-[10px] text-slate-500">
        {item.channel ? <span>{item.channel}</span> : null}
        {item.dueAt ? (
          <span className="inline-flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {new Date(item.dueAt).toLocaleDateString()}
          </span>
        ) : null}
      </div>
      <ItemControls item={item} busy={busy} employees={employees} onPatch={onPatch} />
      {needsApproval ? (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(item.id, 'approve')}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-600 text-white text-[11px] font-semibold disabled:opacity-50"
          >
            <CheckCircle2 className="w-3 h-3" /> Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(item.id, 'reject')}
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-cream-300 text-slate-600 text-[11px] font-semibold disabled:opacity-50"
          >
            <AlertTriangle className="w-3 h-3" /> Reject
          </button>
        </div>
      ) : null}
    </li>
  );
}

const WORK_ITEM_EVENTS = ['work_item_updated'] as const;

export default function WorkItemsPage() {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('kanban');
  const [liveMessage, setLiveMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<string>('normal');
  const [newAssignee, setNewAssignee] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch('/api/work-items');
      if (!res.ok) {
        if (quiet) return;
        setItems([]);
        setError(`Failed to load work items (${res.status})`);
        setLiveMessage('Failed to load work items');
        return;
      }
      const data = (await res.json()) as { workItems?: unknown[] };
      const rows = Array.isArray(data.workItems) ? data.workItems : [];
      const normalized = rows
        .map((row) => (row && typeof row === 'object' ? normalizeItem(row as Record<string, unknown>) : null))
        .filter((r): r is WorkItem => r != null);
      setItems(normalized);
      if (!quiet) {
        setLiveMessage(
          normalized.length === 0 ? 'No work items' : `${normalized.length} work items loaded`
        );
      }
    } catch {
      if (quiet) return;
      setItems([]);
      setError('Failed to load work items');
      setLiveMessage('Failed to load work items');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh; quiet so the list does not flash the loading state.
  const { fallback: streamDown } = useRealtimeStream({
    events: WORK_ITEM_EVENTS,
    onEvent: () => void load(true),
    onFallbackTick: () => void load(true),
  });

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/employees');
        if (!res.ok) return;
        const data = (await res.json()) as { employees?: Array<{ id?: unknown; name?: unknown }> };
        setEmployees(
          (data.employees ?? [])
            .filter((e) => typeof e.id === 'string' && typeof e.name === 'string')
            .map((e) => ({ id: e.id as string, name: e.name as string }))
        );
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load employees');
      }
    })();
  }, []);

  const onPatch = async (id: string, patch: Record<string, unknown>) => {
    setBusyId(id);
    setError(null);
    const result = await mutate(`/api/work-items/${id}`, 'PATCH', patch);
    setBusyId(null);
    if (!result.ok) {
      setError(result.error || 'Update failed');
      setLiveMessage(`Update failed for ${id}`);
      return;
    }
    setLiveMessage(`Work item ${id} updated`);
    await load();
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    setError(null);
    const result = await mutate('/api/work-items', 'POST', {
      title: newTitle.trim(),
      priority: newPriority,
      ...(newAssignee ? { assigneeEmployeeId: newAssignee } : {}),
    });
    setCreating(false);
    if (!result.ok) {
      setError(result.error || 'Create failed');
      return;
    }
    setNewTitle('');
    setNewPriority('normal');
    setNewAssignee('');
    setShowCreate(false);
    setLiveMessage('Work item created');
    await load();
  };

  const onDecide = async (id: string, action: 'approve' | 'reject') => {
    setBusyId(id);
    setError(null);
    const result = await decide(id, action);
    setBusyId(null);
    if (!result.ok) {
      setError(result.error || 'Decision failed');
      setLiveMessage(`Decision failed for ${id}`);
      return;
    }
    setLiveMessage(`${action} recorded for ${id}`);
    await load();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />

      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading flex items-center gap-2">
            <CheckSquare className="w-7 h-7 text-amber-700" />
            Work Items
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Live task queue from AI employees — approvals, backlog, and outcomes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-cream-300 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setView('kanban')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${
                view === 'kanban' ? 'bg-cream-100 text-heading' : 'text-slate-500'
              }`}
            >
              <Columns3 className="w-3.5 h-3.5" /> Kanban
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${
                view === 'list' ? 'bg-cream-100 text-heading' : 'text-slate-500'
              }`}
            >
              <List className="w-3.5 h-3.5" /> List
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-700 text-white text-xs font-semibold"
          >
            New item
          </button>
          {streamDown && (
            <span className="text-[10px] text-amber-700 font-mono" role="status">
              Polling fallback
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-cream-300 bg-white text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {showCreate ? (
        <form
          onSubmit={(e) => void onCreate(e)}
          className="bg-white border border-cream-300 rounded-2xl p-4 flex flex-col sm:flex-row gap-3 sm:items-end"
        >
          <label className="flex-1 text-xs font-semibold text-slate-600">
            Title
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              required
              maxLength={200}
              className="mt-1 w-full rounded-lg border border-cream-300 px-2 py-1.5 text-sm font-normal"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Priority
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              className="mt-1 w-full rounded-lg border border-cream-300 px-2 py-1.5 text-sm font-normal"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Assignee
            <select
              value={newAssignee}
              onChange={(e) => setNewAssignee(e.target.value)}
              className="mt-1 w-full rounded-lg border border-cream-300 px-2 py-1.5 text-sm font-normal"
            >
              <option value="">Unassigned</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={creating || !newTitle.trim()}
            className="px-4 py-2 rounded-xl bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading work items…</div>
      ) : items.length === 0 ? (
        <div className="bg-white border border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <CheckSquare className="w-10 h-10 text-slate-300 mx-auto" />
          <h2 className="font-serif font-bold text-heading">No work items</h2>
          <p className="text-sm text-slate-500">
            There are no work items for this org yet. Items appear when agents park tasks or need approval.
          </p>
        </div>
      ) : view === 'kanban' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {KANBAN_COLUMNS.map((col) => {
            const colItems = items.filter((item) => col.match(item.status));
            return (
              <section key={col.id} className="bg-cream-50 border border-cream-300 rounded-2xl p-3 min-h-[12rem]">
                <div className="flex items-center justify-between mb-3">
                  <StatusBadge label={col.label} tone={col.tone} />
                  <span className="text-[11px] font-mono text-slate-500">{colItems.length}</span>
                </div>
                {colItems.length === 0 ? (
                  <p className="text-xs text-slate-400 px-1">Empty</p>
                ) : (
                  <ul className="space-y-2">
                    {colItems.map((item) => (
                      <WorkItemCard
                        key={item.id}
                        item={item}
                        busy={busyId === item.id}
                        onDecide={onDecide}
                        employees={employees}
                        onPatch={(id, patch) => void onPatch(id, patch)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-cream-300 rounded-2xl overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-cream-50 text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="p-3 font-semibold">Title</th>
                <th className="p-3 font-semibold">Type</th>
                <th className="p-3 font-semibold">Priority</th>
                <th className="p-3 font-semibold">Status</th>
                <th className="p-3 font-semibold">Due</th>
                <th className="p-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {items.map((item) => {
                const needsApproval =
                  item.status === 'waiting_approval' || item.status === 'needs_attention';
                return (
                  <tr key={item.id} className="hover:bg-cream-50/60">
                    <td className="p-3 font-medium text-heading">{itemTitle(item)}</td>
                    <td className="p-3 text-slate-500 font-mono">{item.type}</td>
                    <td className="p-3">
                      <StatusBadge label={item.priority} tone={priorityTone(item.priority)} />
                    </td>
                    <td className="p-3">
                      <StatusBadge label={item.status.replace(/_/g, ' ')} tone={statusTone(item.status)} />
                    </td>
                    <td className="p-3 text-slate-500">
                      {item.dueAt ? new Date(item.dueAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="p-3 text-right">
                      {needsApproval ? (
                        <div className="inline-flex gap-1.5">
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void onDecide(item.id, 'approve')}
                            className="px-2 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-semibold disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void onDecide(item.id, 'reject')}
                            className="px-2 py-1 rounded-lg border border-cream-300 text-slate-600 text-[11px] font-semibold disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
