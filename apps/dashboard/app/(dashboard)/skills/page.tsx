'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import Link from 'next/link';
import {
  Layers,
  ShieldAlert,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Play,
  RefreshCw,
  Search,
  Bot,
  Plug,
  Wand2,
} from 'lucide-react';
import { LiveRegion } from '@/components/a11y';

interface FirstPartySkill {
  id: string;
  name: string;
  version: string;
  description: string;
  requiresTools: string[];
  connectorId: string;
  examplePrompt: string;
}

interface IntegrationInfo {
  id: string;
  name: string;
  connected: boolean;
  status: string;
}

interface EmployeeInfo {
  id: string;
  name: string;
  role: string;
  tool_allowlist: string[] | string;
  status: string;
}

const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  {
    id: 'calendar-playbook',
    name: 'Google Calendar',
    version: '1.0.0',
    description: 'List events, schedule appointments, and coordinate free/busy windows.',
    requiresTools: ['mcp.darex.calendar_list_events', 'mcp.darex.calendar_create_event'],
    connectorId: 'google-calendar',
    examplePrompt: 'Check my Google Calendar for upcoming meetings today',
  },
  {
    id: 'gmail-playbook',
    name: 'Gmail & Email',
    version: '1.0.0',
    description: 'Fetch, triage, compose drafts, and autonomously send email replies.',
    requiresTools: ['mcp.darex.gmail_fetch', 'mcp.darex.gmail_send'],
    connectorId: 'gmail',
    examplePrompt: 'Triage my unread Gmail messages and summarize key customer action items',
  },
  {
    id: 'sheets-playbook',
    name: 'Google Sheets',
    version: '1.0.0',
    description: 'Read and append spreadsheet rows used as an operational system of record.',
    requiresTools: ['mcp.darex.sheets_read', 'mcp.darex.sheets_append_row'],
    connectorId: 'google-sheets',
    examplePrompt: 'Read the latest rows from our customer leads spreadsheet',
  },
  {
    id: 'docs-playbook',
    name: 'Google Docs',
    version: '1.0.0',
    description: 'Read, draft, and assemble structured Google Docs proposals.',
    requiresTools: ['mcp.darex.docs_create', 'mcp.darex.docs_read'],
    connectorId: 'google-docs',
    examplePrompt: 'Draft an executive project brief outline in Google Docs',
  },
  {
    id: 'drive-playbook',
    name: 'Google Drive',
    version: '1.0.0',
    description: 'Search documents and extract knowledge from shared Google Drive folders.',
    requiresTools: ['mcp.darex.drive_search', 'mcp.darex.drive_get_text'],
    connectorId: 'google-drive',
    examplePrompt: 'Search Google Drive for the latest proposal document',
  },
  {
    id: 'notion-playbook',
    name: 'Notion Knowledge',
    version: '1.0.0',
    description: 'Query company wiki databases and update Notion team documentation.',
    requiresTools: ['mcp.darex.notion_search'],
    connectorId: 'notion',
    examplePrompt: 'Search Notion workspace for onboarding and team meeting notes',
  },
  {
    id: 'sales-crm',
    name: 'Sales CRM (HubSpot)',
    version: '1.0.0',
    description: 'HubSpot contact enrichment, deal stage pipeline operations, and follow-ups.',
    requiresTools: ['mcp.darex.hubspot_create_contact', 'mcp.darex.hubspot_update_contact'],
    connectorId: 'hubspot',
    examplePrompt: 'Find the latest HubSpot contact details and recent interactions',
  },
  {
    id: 'support-tickets',
    name: 'Support Tickets (Zendesk & Intercom)',
    version: '1.0.0',
    description: 'Inbox customer ticket triage, escalation tracking, and resolutions.',
    requiresTools: ['mcp.darex.zendesk_fetch_tickets', 'mcp.darex.intercom_fetch_conversations'],
    connectorId: 'zendesk',
    examplePrompt: 'Check high priority open customer support tickets',
  },
  {
    id: 'ecommerce',
    name: 'E-commerce (Shopify)',
    version: '1.0.0',
    description: 'Live Shopify catalog queries, inventory checking, and order status updates.',
    requiresTools: ['mcp.darex.shopify_fetch_products', 'mcp.darex.shopify_fetch_orders'],
    connectorId: 'shopify',
    examplePrompt: 'List recent Shopify orders and inventory levels',
  },
  {
    id: 'payments',
    name: 'Payment Links (Stripe & Razorpay)',
    version: '1.0.0',
    description: 'Generate customer payment links for deals with strict human approval gates.',
    requiresTools: ['mcp.darex.stripe_create_payment_link', 'mcp.darex.razorpay_create_payment_link'],
    connectorId: 'stripe',
    examplePrompt: 'Create a payment link for our client invoice',
  },
  {
    id: 'nango-integrations-playbook',
    name: 'WhatsApp Business Messaging',
    version: '1.0.0',
    description: 'Customer messaging on WhatsApp, with ready-made message templates and automatic chat handling.',
    requiresTools: ['mcp.darex.whatsapp_send', 'mcp.darex.gmail_fetch'],
    connectorId: 'whatsapp',
    examplePrompt: 'Send a WhatsApp notification update to customer',
  },
];

function parseAllowlist(tools: unknown): string[] {
  if (Array.isArray(tools)) return tools.map(String);
  if (typeof tools === 'string') {
    try {
      const parsed = JSON.parse(tools);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return tools.split(',').map((t) => t.trim());
    }
  }
  return [];
}

const SKILLS_EVENTS = ['integration_updated'] as const;

const SKILLS_LOAD_FAILED =
  'We couldn’t check which of your tools are connected, so the “ready” labels below may be out of date. Please try again in a moment.';

export default function SkillsPage() {
  const [integrations, setIntegrations] = useState<Record<string, boolean>>({});
  const [employees, setEmployees] = useState<EmployeeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'needs_setup'>('all');
  const [liveMessage, setLiveMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [integRes, empRes] = await Promise.all([
        fetch('/api/integrations'),
        fetch('/api/employees'),
      ]);

      if (!integRes.ok || !empRes.ok) {
        setLoadError(SKILLS_LOAD_FAILED);
      } else {
        setLoadError('');
      }

      if (integRes.ok) {
        const integData = await integRes.json();
        const map: Record<string, boolean> = {};
        if (Array.isArray(integData.integrations)) {
          for (const item of integData.integrations) {
            map[item.id] = Boolean(item.connected);
          }
        }
        setIntegrations(map);
      }

      if (empRes.ok) {
        const empData = await empRes.json();
        setEmployees(Array.isArray(empData.employees) ? empData.employees : []);
      }
      if (!quiet) setLiveMessage(`${FIRST_PARTY_SKILLS.length} playbooks loaded`);
    } catch (err) {
      console.error('Failed to load skills live context:', err);
      setLoadError(SKILLS_LOAD_FAILED);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useLiveRefresh({ events: SKILLS_EVENTS, refetch: () => loadData(true) });

  const isConnected = useCallback((connectorId: string): boolean => {
    if (integrations[connectorId]) return true;
    if (connectorId === 'stripe' && integrations['razorpay']) return true;
    if (connectorId === 'zendesk' && integrations['intercom']) return true;
    return false;
  }, [integrations]);

  const getAuthorizedEmployees = useCallback((connectorId: string) => {
    return employees.filter((emp) => {
      const tools = parseAllowlist(emp.tool_allowlist);
      return tools.includes(connectorId) || tools.includes('all');
    });
  }, [employees]);

  const filteredSkills = useMemo(() => {
    return FIRST_PARTY_SKILLS.filter((skill) => {
      const ready = isConnected(skill.connectorId);
      if (filter === 'ready' && !ready) return false;
      if (filter === 'needs_setup' && ready) return false;

      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q)
      );
    });
  }, [filter, search, isConnected]);

  useEffect(() => {
    if (!loading) {
      setLiveMessage(`${filteredSkills.length} playbook${filteredSkills.length === 1 ? '' : 's'} available`);
    }
  }, [filteredSkills.length, loading]);

  const readyCount = FIRST_PARTY_SKILLS.filter((s) => isConnected(s.connectorId)).length;

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20 md:pb-12">
      <LiveRegion message={liveMessage} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Playbook Skills</h1>
            <span className="text-xs font-mono font-bold bg-amber-500/20 text-amber-800 px-2 py-0.5 rounded-md border border-amber-500/30">
              Built in
            </span>
          </div>
          <p className="text-slate-500 text-sm mt-1">
            Production playbooks with strict tool isolation and Human-in-the-Loop approval gates.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadData()}
          className="self-start sm:self-auto px-4 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 text-slate-700 font-semibold rounded-2xl flex items-center space-x-2 text-xs transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Sync Status</span>
        </button>
      </div>

      {loadError && (
        <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {loadError}
        </div>
      )}

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
          <input
            type="text"
            placeholder="Search playbooks by name or capability..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-cream-300 rounded-2xl text-xs font-medium text-heading focus:outline-none focus:border-amber-500 shadow-xs"
          />
        </div>

        <div className="flex items-center space-x-2">
          {(
            [
              { key: 'all', label: `All (${FIRST_PARTY_SKILLS.length})` },
              { key: 'ready', label: `Ready to Run (${readyCount})` },
              { key: 'needs_setup', label: `Needs Setup (${FIRST_PARTY_SKILLS.length - readyCount})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all ${
                filter === tab.key
                  ? 'bg-amber-500 text-heading shadow-xs'
                  : 'bg-cream-200 hover:bg-cream-300 text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Skills Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {filteredSkills.map((skill) => {
          const ready = isConnected(skill.connectorId);
          const authorizedEmployees = getAuthorizedEmployees(skill.connectorId);

          return (
            <article
              key={skill.id}
              className="bg-white border border-cream-300 rounded-3xl p-6 shadow-xs hover:shadow-md transition-all flex flex-col justify-between space-y-4"
            >
              <div className="space-y-3">
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                      <Layers className="w-4 h-4 text-amber-700" />
                    </div>
                    <div>
                      <h2 className="text-base font-serif font-bold text-heading">{skill.name}</h2>
                      <span className="text-[10px] font-mono text-slate-400">v{skill.version}</span>
                    </div>
                  </div>

                  {ready ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      <span>Ready</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                      <AlertCircle className="w-3 h-3 text-amber-600" />
                      <span>Needs Connector</span>
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">{skill.description}</p>

                {/* Authorized AI Employees */}
                <div className="pt-2 border-t border-cream-200/80">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                    <Bot className="w-3 h-3 text-slate-400" />
                    <span>Assigned AI Employees</span>
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {authorizedEmployees.length > 0 ? (
                      authorizedEmployees.map((emp) => (
                        <span
                          key={emp.id}
                          className="text-[10px] font-semibold px-2 py-0.5 bg-cream-200 text-slate-700 rounded-md border border-cream-300"
                        >
                          @{emp.name} ({emp.role})
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-slate-400 italic">
                        Available for all employees with &lsquo;{skill.connectorId}&rsquo; tool
                      </span>
                    )}
                  </div>
                </div>

                {/* Required MCP tools list */}
                <div className="space-y-1">
                  <span className="text-[10px] font-mono text-slate-400 uppercase">Needs these tools:</span>
                  <ul className="text-[11px] font-mono text-slate-500 space-y-0.5">
                    {skill.requiresTools.map((tool) => (
                      <li key={tool} className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                        <span>{tool}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Action Bar */}
              <div className="pt-3 border-t border-cream-200 flex items-center justify-between gap-3">
                <Link
                  href={`/connectors/${skill.connectorId}`}
                  className="touch-target text-xs font-semibold text-slate-500 hover:text-amber-700 flex items-center gap-1 transition-colors"
                >
                  <Plug className="w-3.5 h-3.5" />
                  <span>Connector Settings</span>
                </Link>

                {ready ? (
                  <Link
                    href={`/ask-ai?q=${encodeURIComponent(skill.examplePrompt)}`}
                    className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-xs transition-all"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Run in Ask AI</span>
                  </Link>
                ) : (
                  <Link
                    href={`/connectors/${skill.connectorId}`}
                    className="px-3.5 py-1.5 bg-cream-200 hover:bg-amber-500 text-slate-800 hover:text-heading font-bold text-xs rounded-xl flex items-center gap-1.5 border border-cream-300 transition-all"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Connect Tool</span>
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {filteredSkills.length === 0 && (
        <div className="bg-white border-2 border-dashed border-cream-300 rounded-3xl p-12 text-center space-y-2">
          <Wand2 className="w-8 h-8 text-slate-300 mx-auto" />
          <h3 className="font-serif font-bold text-base text-heading">No matching playbooks</h3>
          <p className="text-xs text-slate-500">Try adjusting your search query or filter pills.</p>
        </div>
      )}

      {/* Safety Notice */}
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
        <div>
          <p className="font-bold">Enterprise Safety Architecture</p>
          <p className="mt-0.5 text-amber-800 leading-relaxed">
            Every skill runs in its own protected space, kept separate from other businesses. Anything that reaches outside — sending a message, charging a card — follows each employee’s approval rules and never happens without your say-so.
          </p>
        </div>
      </div>
    </div>
  );
}
