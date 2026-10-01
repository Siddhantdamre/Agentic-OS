'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Bot, ArrowLeft, Wrench, Activity } from 'lucide-react';

type Employee = {
  id: string;
  name: string;
  role: string;
  persona: unknown;
  tool_allowlist: string[] | string;
  status: string;
};

type ActivityRow = {
  id: string;
  title: string | null;
  status: string;
  priority: string | null;
  type: string | null;
  updated_at: string;
};

type Performance = {
  totalAssigned: number;
  open: number;
  completed: number;
  completedLast7d: number;
  avgResolutionHours: number | null;
  completionRate: number | null;
};

function personaText(persona: unknown): string {
  if (!persona) return '';
  if (typeof persona === 'string') {
    const t = persona.trim();
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        return typeof parsed?.text === 'string' ? parsed.text : t;
      } catch {
        return t;
      }
    }
    return t;
  }
  if (typeof persona === 'object' && persona && 'text' in persona) {
    const text = (persona as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

export default function EmployeeDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [empRes, actRes, perfRes] = await Promise.all([
          fetch(`/api/employees/${id}`),
          fetch(`/api/employees/${id}/activity?limit=25`),
          fetch(`/api/employees/${id}/metrics`),
        ]);
        if (!empRes.ok) {
          const data = await empRes.json().catch(() => ({}));
          throw new Error(typeof data.error === 'string' ? data.error : 'Employee not found');
        }
        const empData = await empRes.json();
        const actData = actRes.ok ? await actRes.json() : { activities: [] };
        const perfData = perfRes.ok ? await perfRes.json() : null;
        if (!cancelled) {
          setPerformance(perfData?.metrics ?? null);
          setEmployee(empData.employee);
          setActivities(Array.isArray(actData.activities) ? actData.activities : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const tools = Array.isArray(employee?.tool_allowlist)
    ? employee!.tool_allowlist
    : typeof employee?.tool_allowlist === 'string'
      ? employee.tool_allowlist.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6 pb-12">
      <Link href="/employees" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-heading">
        <ArrowLeft className="w-4 h-4" /> Back to employees
      </Link>

      {loading ? (
        <div className="h-40 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
      ) : error ? (
        <p className="text-sm text-amber-800">{error}</p>
      ) : !employee ? (
        <p className="text-sm text-slate-500">Employee not found.</p>
      ) : (
        <>
          <div className="flex items-center gap-4 bg-white p-6 rounded-2xl border border-cream-300">
            <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center">
              <Bot className="w-8 h-8 text-heading" />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-bold text-heading">{employee.name}</h1>
              <p className="text-sm text-slate-500">
                {employee.role} · {employee.status}
              </p>
            </div>
          </div>

          {performance && (
            <section className="bg-white p-6 rounded-2xl border border-cream-300 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              {[
                ['Assigned', String(performance.totalAssigned)],
                ['Open', String(performance.open)],
                ['Completed (7d)', String(performance.completedLast7d)],
                ['Completion rate', performance.completionRate == null ? 'No data' : `${Math.round(performance.completionRate * 100)}%`],
                ['Avg resolution', performance.avgResolutionHours == null ? 'No data' : `${performance.avgResolutionHours}h`],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="text-lg font-semibold text-heading">{value}</p>
                </div>
              ))}
            </section>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <section className="bg-white p-6 rounded-2xl border border-cream-300 space-y-3">
              <h2 className="font-semibold text-heading flex items-center gap-2">
                <Wrench className="w-4 h-4" /> Tools ({tools.length})
              </h2>
              <div className="flex flex-wrap gap-2">
                {tools.length === 0 ? (
                  <p className="text-sm text-slate-500">No tools configured.</p>
                ) : (
                  tools.map((tool) => (
                    <span key={tool} className="px-2.5 py-1 text-xs bg-cream-100 rounded-md font-mono">
                      {tool}
                    </span>
                  ))
                )}
              </div>
              <p className="text-sm text-slate-600 whitespace-pre-wrap pt-2 border-t border-cream-200">
                {personaText(employee.persona) || 'No persona text.'}
              </p>
            </section>

            <section className="bg-white p-6 rounded-2xl border border-cream-300 space-y-3">
              <h2 className="font-semibold text-heading flex items-center gap-2">
                <Activity className="w-4 h-4" /> Recent work
              </h2>
              {activities.length === 0 ? (
                <p className="text-sm text-slate-500">No assigned work items yet.</p>
              ) : (
                <ul className="space-y-2 max-h-80 overflow-y-auto">
                  {activities.map((row) => (
                    <li key={row.id} className="text-sm border border-cream-200 rounded-xl p-3">
                      <p className="font-medium text-heading">{row.title || row.type || 'Work item'}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {row.status}
                        {row.priority ? ` · ${row.priority}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
