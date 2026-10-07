'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Users,
  Plus,
  Bot,
  Sparkles,
  CheckCircle2,
  PauseCircle,
  Trash2,
  X,
  Shield,
  Layers,
  Activity,
  MessageSquare,
} from 'lucide-react';
import { AutonomousActionConsole } from '@/components/agent/AutonomousActionConsole';
import { CrewSpawnPanel } from '@/components/agent/CrewSpawnPanel';
import { StatusBadge } from '@/components/a11y';

interface AIEmployee {
  id: string;
  name: string;
  role: string;
  persona: string;
  tool_allowlist: string[] | string;
  status: 'active' | 'paused' | string;
  created_at: string;
}

// Persona is stored as either plain text or a JSON-encoded pack descriptor
// (`{"text": "...", "packId": "...", "rosterKey": "..."}`). Show the human
// text, never the raw JSON.
function describePersona(persona: unknown): string {
  const fallback = 'Specialized AI employee for processing inquiries and handling user interactions.';
  if (!persona) return fallback;

  if (typeof persona === 'object') {
    const text = (persona as { text?: unknown }).text;
    return typeof text === 'string' && text ? text : fallback;
  }

  if (typeof persona !== 'string') return fallback;

  const trimmed = persona.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.text === 'string' && parsed.text) {
        return parsed.text;
      }
    } catch {
      // not JSON — fall through to raw text
    }
  }
  return persona;
}

const AVAILABLE_TOOLS = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'google-calendar', label: 'Google Calendar' },
  { id: 'google-drive', label: 'Google Drive' },
  { id: 'google-docs', label: 'Google Docs' },
  { id: 'google-sheets', label: 'Google Sheets' },
  { id: 'hubspot', label: 'HubSpot CRM' },
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'notion', label: 'Notion' },
  { id: 'meta-ads', label: 'Meta Ads' },
  { id: 'web_search', label: 'Web search' },
];

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<AIEmployee[]>([]);
  const [connectedChannels, setConnectedChannels] = useState<string[]>([]);
  const [empStats, setEmpStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hireError, setHireError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [persona, setPersona] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>(['gmail', 'whatsapp']);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/employees');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) {
        setLoadError('We couldn’t load employees. Please try again.');
        return;
      }
      const data = await res.json();
      setEmployees(data.employees || []);
      setConnectedChannels(Array.isArray(data.connectedChannels) ? data.connectedChannels.map(String) : []);
      setLoadError(null);
      try {
        const statsRes = await fetch('/api/employees/stats');
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          setEmpStats(statsData);
        }
      } catch (err) {
        console.error('Failed to fetch employee stats:', err);
      }
    } catch (error) {
      console.error('Failed to fetch employees:', error);
      setLoadError('Failed to load employees');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmployees();
  }, []);

  const handleToggleStatus = async (id: string, currentStatus: string) => {
    const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
    const previous = employees;
    setEmployees((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: nextStatus } : e))
    );
    try {
      const res = await fetch(`/api/employees/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        setEmployees(previous);
        const err = await res.json().catch(() => ({}));
        alert(typeof err.error === 'string' ? err.error : 'Failed to update employee status');
      }
    } catch (error) {
      console.error('Failed to toggle status:', error);
      setEmployees(previous);
      alert('Network error updating employee status');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Archive this AI employee? Open tasks must be reassigned first.')) return;
    const previous = employees;
    setEmployees((prev) => prev.filter((e) => e.id !== id));
    try {
      let res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        const count = typeof err.activeTaskCount === 'number' ? err.activeTaskCount : '?';
        const others = previous.filter((e) => e.id !== id && e.status === 'active');
        if (others.length === 0) {
          setEmployees(previous);
          alert(`${err.error || 'Active tasks require reassignment'} (${count} tasks). Hire or activate another employee first.`);
          return;
        }
        const pick = window.prompt(
          `${err.error || 'Reassign tasks first'}\nEnter reassign target employee id:\n${others
            .map((e) => `${e.name}: ${e.id}`)
            .join('\n')}`,
          others[0]?.id || '',
        );
        if (!pick) {
          setEmployees(previous);
          return;
        }
        res = await fetch(`/api/employees/${id}?reassignTo=${encodeURIComponent(pick.trim())}`, {
          method: 'DELETE',
        });
      }
      if (!res.ok) {
        setEmployees(previous);
        const err = await res.json().catch(() => ({}));
        alert(typeof err.error === 'string' ? err.error : 'Failed to archive employee');
      }
    } catch (error) {
      console.error('Failed to delete employee:', error);
      setEmployees(previous);
      alert('Network error archiving employee');
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !role) return;

    try {
      setSubmitting(true);
      setHireError(null);
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          role,
          persona,
          tool_allowlist: selectedTools,
          status: 'active',
        }),
      });

      if (res.ok) {
        setIsModalOpen(false);
        setName('');
        setRole('');
        setPersona('');
        setSelectedTools(['gmail', 'whatsapp']);
        setHireError(null);
        fetchEmployees();
      } else {
        const err = await res.json().catch(() => ({}));
        setHireError(typeof err.error === 'string' ? err.error : 'Failed to hire employee');
      }
    } catch (error) {
      console.error('Failed to create employee:', error);
      setHireError('Network error hiring employee');
    } finally {
      setSubmitting(false);
    }
  };

  // Built-in, DB-backed modules (services/workflows/src/tools) with no OAuth of
  // their own — never show "· connect" for these.
  const ALWAYS_READY = new Set([
    'web_search', 'web_extract', 'database_query', 'knowledge_search', 'metrics', 'file_ops', 'code_execution',
    'customer-ops', 'operations', 'growth', 're', 'realestate', 'rera',
    'cognee', 'cognee-memory', 'daily_brief', 'daily-brief', 'billing', 'billing_usage',
  ]);

  const toolReady = (tool: string): boolean => {
    const key = tool.toLowerCase().replace(/_/g, '-');
    if (ALWAYS_READY.has(tool.toLowerCase()) || ALWAYS_READY.has(key)) return true;
    return connectedChannels.some((channel) => {
      const ch = channel.toLowerCase().replace(/_/g, '-');
      return ch === key || ch.startsWith(`${key}-`) || key.startsWith(`${ch}-`);
    });
  };

  const parseTools = (tools: any): string[] => {
    if (Array.isArray(tools)) return tools;
    if (typeof tools === 'string') {
      try {
        const parsed = JSON.parse(tools);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return tools.split(',').map((t) => t.trim());
      }
    }
    return [];
  };

  const filteredEmployees = employees.filter((emp) => {
    if (filter === 'active') return emp.status === 'active';
    if (filter === 'paused') return emp.status === 'paused';
    return true;
  });

  const activeCount = employees.filter((e) => e.status === 'active').length;

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-20 md:pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">
            AI Employee Roster
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Mention an employee in Ask AI with @Name. Whoever you mention, they share the same connected apps.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 font-semibold text-heading rounded-2xl flex items-center space-x-2 shadow-md transition-all hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        >
          <Plus className="w-4 h-4" />
          <span>Hire AI Employee</span>
        </button>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Workforce</span>
          <div className="text-3xl font-bold text-heading">{employees.length}</div>
          <span className="text-xs text-slate-500">AI employees</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Active Status</span>
          <div className="text-3xl font-bold text-emerald-600">{activeCount}</div>
          <span className="text-xs text-emerald-600 font-medium">Ready for messages</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Automation Rate</span>
          <div className="text-3xl font-bold text-heading">
            {empStats?.automationRate != null ? empStats.automationRate + '%' : '—'}
          </div>
          <span className="text-xs text-slate-500 font-medium">Conversations with an AI reply</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Resolution</span>
          <div className="text-3xl font-bold text-heading">
            {empStats && typeof empStats.avgResolutionSec === 'number'
              ? empStats.avgResolutionSec > 0
                ? empStats.avgResolutionSec.toFixed(1) + 's'
                : '0s'
              : '--'}
          </div>
          <span className="text-xs text-slate-500 font-medium">
            {empStats && !empStats.conversationsResolved
              ? 'No resolved conversations yet'
              : 'Time to conversation.resolved_at when present'}
          </span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center space-x-2 border-b border-cream-300 pb-3">
        {(['all', 'active', 'paused'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all capitalize ${
              filter === t
                ? 'bg-amber-500 text-heading shadow-sm'
                : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
            }`}
          >
            {t} ({t === 'all' ? employees.length : t === 'active' ? activeCount : employees.length - activeCount})
          </button>
        ))}
      </div>

      {/* Employee Cards Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-64 bg-cream-200/50 rounded-3xl animate-pulse border border-cream-300" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 space-y-3">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => fetchEmployees()}
            className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      ) : filteredEmployees.length === 0 ? (
        <div className="bg-white border-2 border-dashed border-cream-300 rounded-3xl p-12 text-center space-y-4">
          <Bot className="w-12 h-12 text-slate-300 mx-auto" />
          <h3 className="text-lg font-bold text-heading font-serif">No AI Employees Found</h3>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Get started by adding your first specialized AI employee to handle customer inquiries and business workflows.
          </p>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading font-semibold text-xs rounded-xl inline-flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Create AI Employee</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredEmployees.map((employee) => {
            const tools = parseTools(employee.tool_allowlist);
            const isActive = employee.status === 'active';

            return (
              <div
                key={employee.id}
                className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all flex flex-col justify-between relative space-y-5"
              >
                <div className="space-y-4">
                  {/* Card Top: Name & Role Badge */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                        <Bot className="w-6 h-6 text-amber-600" />
                      </div>
                      <div>
                        <h3 className="font-bold font-serif text-lg text-heading">
                          <Link href={`/employees/${employee.id}`} className="hover:underline">
                            {employee.name}
                          </Link>
                        </h3>
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-700">
                          {employee.role}
                        </span>
                      </div>
                    </div>

                    <StatusBadge
                      label={employee.status}
                      tone={isActive ? 'success' : 'neutral'}
                      icon={isActive ? 'check' : 'pause'}
                    />
                  </div>

                  {/* Persona description */}
                  <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">
                    {describePersona(employee.persona)}
                  </p>

                  {/* Tools allowlist badges */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center space-x-1">
                      <Shield className="w-3 h-3 text-slate-400" />
                      <span>Adds to org tools</span>
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {tools.length > 0 ? (
                        tools.map((tool) => {
                          const ready = toolReady(tool);
                          return (
                            <span
                              key={tool}
                              title={ready ? 'Ready' : 'Not connected — open Connectors'}
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-md border capitalize ${
                                ready
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-amber-50 text-amber-800 border-amber-200'
                              }`}
                            >
                              {tool}
                              {ready ? '' : ' · connect'}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-xs text-slate-400 italic">No tools assigned</span>
                      )}
                    </div>
                    {tools.some((tool) => !toolReady(tool)) ? (
                      <Link href="/connectors" className="touch-target text-[11px] font-semibold text-amber-700 hover:underline">
                        Connect missing tools
                      </Link>
                    ) : null}
                  </div>
                </div>

                {/* Bottom Actions */}
                <div className="pt-4 border-t border-cream-200 flex items-center justify-between gap-2">
                  <button
                    onClick={() => handleToggleStatus(employee.id, employee.status)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition-colors ${
                      isActive
                        ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                        : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700'
                    }`}
                  >
                    {isActive ? (
                      <>
                        <PauseCircle className="w-3.5 h-3.5 text-slate-500" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Activate</span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-1.5">
                    {isActive ? (
                      <Link
                        href={`/ask-ai?employee=${encodeURIComponent(employee.id)}&mode=single`}
                        className="px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-900 border border-amber-500/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-amber-700" />
                        <span className="truncate max-w-[9rem]">Chat with {employee.name}</span>
                      </Link>
                    ) : null}
                    <button
                      onClick={() => handleDelete(employee.id)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                      title="Delete AI Employee"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CrewSpawnPanel />

      {/* Autonomous Tool Action Console */}
      <AutonomousActionConsole />

      {/* Hire Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-cream-300 rounded-3xl p-8 max-w-lg w-full max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-cream-200 pb-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <h2 className="text-xl font-serif font-bold text-heading">Hire AI Employee</h2>
                  <p className="text-xs text-slate-500">Deploy a custom AI employee to your roster</p>
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-2 text-slate-400 hover:text-heading rounded-xl"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateEmployee} className="space-y-4">
              {hireError && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{hireError}</p>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Employee Name *
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Alex"
                  className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Role / Department *
                </label>
                <input
                  type="text"
                  required
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="e.g. Billing Specialist or Technical Support"
                  className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Persona & Knowledge Guidelines
                </label>
                <textarea
                  rows={3}
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  placeholder="Describe how this employee should behave, key answers, tone of voice, etc."
                  className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Adds to org tools
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {AVAILABLE_TOOLS.map((t) => {
                    const isChecked = selectedTools.includes(t.id);
                    return (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => {
                          setSelectedTools((prev) =>
                            isChecked ? prev.filter((item) => item !== t.id) : [...prev, t.id]
                          );
                        }}
                        className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center justify-between transition-colors ${
                          isChecked
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-800'
                            : 'bg-cream-100 border-cream-300 text-slate-600'
                        }`}
                      >
                        <span>{t.label}</span>
                        {isChecked && <CheckCircle2 className="w-3.5 h-3.5 text-amber-600" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-cream-200 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 font-semibold text-heading text-xs rounded-xl shadow-md disabled:opacity-50"
                >
                  {submitting ? 'Deploying...' : 'Deploy AI Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
