'use client';

import { channelName } from '@/lib/ask-ai-welcome';
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Layers, Link as LinkIcon, ShieldAlert, Users } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

type ProviderStatus = {
  provider: string;
  connected: boolean;
  status: string;
  source: string;
};

type AssignedEmployee = { id: string; name: string; role: string };

type SkillRow = {
  id: string;
  name: string;
  version: string;
  description: string;
  requiresTools: string[];
  requiresProviders: string[];
  minAutonomyLevel: number;
  enabled: boolean;
  providerStatuses: ProviderStatus[];
  missingProviders: string[];
  assignedEmployees: AssignedEmployee[];
  computedStatus: 'ready' | 'disabled' | 'not_connected' | 'unassigned';
};

type EmployeeOption = { id: string; name: string; role: string };

function statusBadge(status: SkillRow['computedStatus']) {
  switch (status) {
    case 'ready':
      return { label: 'Ready', className: 'bg-emerald-100 text-emerald-800' };
    case 'disabled':
      return { label: 'Disabled', className: 'bg-slate-200 text-slate-700' };
    case 'not_connected':
      return { label: 'Not connected', className: 'bg-amber-100 text-amber-900' };
    case 'unassigned':
      return { label: 'Unassigned', className: 'bg-sky-100 text-sky-800' };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function SkillsView() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) throw new Error('We couldn’t load skills. Please try again.');
      const data = (await res.json()) as { skills: SkillRow[]; employees: EmployeeOption[] };
      setSkills(data.skills || []);
      setEmployees(data.employees || []);
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Failed to load skills'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchSkill = async (skillId: string, body: Record<string, unknown>) => {
    setBusyId(skillId);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'We couldn’t save that. Please try again.');
      }
      await load();
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Update failed'));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-slate-500">Loading skills…</p>;
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {skills.map((skill) => {
          const badge = statusBadge(skill.computedStatus);
          const assignedIds = new Set(skill.assignedEmployees.map((e) => e.id));
          return (
            <article
              key={skill.id}
              className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-amber-700" />
                  <h2 className="text-lg font-serif font-bold text-heading">{skill.name}</h2>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-lg ${badge.className}`}>
                    {badge.label}
                  </span>
                  <span className="text-xs font-mono font-bold bg-cream-200 text-slate-700 px-2 py-1 rounded-lg">
                    v{skill.version}
                  </span>
                </div>
              </div>

              <p className="text-sm text-slate-600">{skill.description}</p>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Connectors
                </p>
                <ul className="space-y-1.5">
                  {skill.providerStatuses.map((p) => (
                    <li key={p.provider} className="flex items-center justify-between text-sm">
                      <span className="text-xs font-medium text-slate-600">{channelName(p.provider)}</span>
                      {p.connected ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Connected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-800 text-xs font-semibold">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Not connected
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {skill.missingProviders.length > 0 ? (
                  <Link
                    href="/connectors"
                    className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:underline"
                  >
                    <LinkIcon className="w-3.5 h-3.5" />
                    Connect missing providers
                  </Link>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3 pt-1 border-t border-cream-200">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={skill.enabled}
                    disabled={busyId === skill.id}
                    onChange={() => void patchSkill(skill.id, { enabled: !skill.enabled })}
                  />
                  Enabled for org
                </label>
                <span className="text-xs text-slate-400">Autonomy ≥ {skill.minAutonomyLevel}</span>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  Assign employees
                </p>
                {employees.length === 0 ? (
                  <p className="text-xs text-slate-400">No active employees yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {employees.map((emp) => {
                      const checked = assignedIds.has(emp.id);
                      return (
                        <label
                          key={emp.id}
                          className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs cursor-pointer ${
                            checked
                              ? 'border-amber-300 bg-amber-50 text-amber-900'
                              : 'border-cream-300 bg-cream-50 text-slate-600'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="rounded border-slate-300"
                            checked={checked}
                            disabled={busyId === skill.id}
                            onChange={() => {
                              const next = checked
                                ? skill.assignedEmployees.filter((e) => e.id !== emp.id).map((e) => e.id)
                                : [...skill.assignedEmployees.map((e) => e.id), emp.id];
                              void patchSkill(skill.id, { assignedEmployeeIds: next });
                            }}
                          />
                          {emp.name}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function SkillsPageShell() {
  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">First-party skills</h1>
        <p className="text-slate-500 text-sm mt-1">
          Shows which skills are ready to use, based on the tools you have connected and what each employee is allowed to do.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Marketplace preview (design only)</p>
          <p className="mt-1">
            Third-party packs need a written review: executor-only (no raw tokens), eval-runner
            goldens, and an admin install. See{' '}
            <code className="text-xs">docs/current-working/marketplace-preview.md</code>.
          </p>
        </div>
      </div>

      <SkillsView />

      <p className="text-xs text-slate-400">
        Darex subscription billing is at{' '}
        <Link href="/billing" className="text-amber-700 font-bold">
          /billing
        </Link>
        .
      </p>
    </div>
  );
}
