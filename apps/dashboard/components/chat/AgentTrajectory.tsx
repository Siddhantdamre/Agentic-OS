'use client';

/**
 * AgentTrajectory — Darex-native mirror of TrueForge's run UI
 * (ToolCallCard + ToolApprovalBar + SubAgentCard in trueforge-ui).
 *
 * One vertical timeline per assistant turn:
 * - tool rows with running/success/error status, expandable Request/Response,
 *   and an inline approval slot when the harness paused for a decision;
 * - subagent spans rendered as nested rollout cards grouping the steps the
 *   subagent ran (TrueForge shows these as nested thread cards);
 * - a compact turn header (steps count + terminal state).
 *
 * Deny requires a reason (mirrors TrueForge's default deny option); Allow is
 * one click. Decided items show a check/cross plus the reason, read-only.
 */

import React, { useState } from 'react';
import { ConnectorSignInControl } from '@/components/chat/ConnectorSignInLink';
import { providerIdForTool, providerIdFromConnectHref } from '@/lib/integrations-catalog';
import { parseSearchView, queryFromToolLabel, unwrapToolText, type SearchHit } from '@/lib/tool-answer';
import {
  Bot,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleX,
  Code2,
  Copy,
  Database,
  Folder,
  Globe,
  Loader2,
  Mail,
  Search,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Users,
  Wrench,
  XCircle,
  Square,
} from 'lucide-react';
import { describeHeldAction } from '@/lib/approval-view';

export type TrajectoryStatus = 'running' | 'success' | 'error';

/** What the person is being asked to allow: a sentence and the call itself, when the server could read it. */
export interface ApprovalCallInfo {
  summary?: string;
  call?: { tool: string; action: string; args: Record<string, unknown> };
}

export interface ApprovalSlotData extends ApprovalCallInfo {
  sessionId: string;
  threadId: string;
  toolCallId: string;
  decided?: 'allow' | 'deny';
  reason?: string;
  resolving?: boolean;
}

export interface TrajectoryStep {
  key: string;
  tool: string;
  request?: string;
  response?: string;
  status: TrajectoryStatus;
  approval?: ApprovalSlotData | null;
  children?: TrajectoryStep[];
  /** Subagent display metadata (TrueForge agent_info + pairing). */
  subagentName?: string;
  subagentInstruction?: string;
  subagentThreadId?: string;
  durationMs?: number;
  error?: string;
}

export interface TrajectoryUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalCostInUsd?: number;
  durationMs?: number;
}

export interface TrajectoryData {
  steps: TrajectoryStep[];
  running: boolean;
  error?: string;
  usage?: TrajectoryUsage;
}

function formatDuration(ms?: number): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatTokens(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function isErrorResult(response?: string): boolean {
  if (!response) return false;
  const head = response.slice(0, 400);
  if (/"status"\s*:\s*"error"/.test(head) || /^(error|failed)[:\s]/i.test(response.trim())) return true;
  if (/"connected"\s*:\s*false/.test(head)) return true;
  return /not connected|not signed in/i.test(head);
}

export function shortToolName(tool: string): string {
  return tool.replace(/^mcp\.darex\./, '').replace(/__/g, '.');
}

function isWebSearchTool(tool: string): boolean {
  const clean = shortToolName(tool).toLowerCase();
  return clean === 'web_search' || clean === 'search' || clean === 'google_search';
}

function isAskUserTool(tool: string): boolean {
  const clean = shortToolName(tool).toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean === 'askuserquestion';
}

export function humanToolName(tool: string): string {
  const clean = shortToolName(tool).toLowerCase();
  const map: Record<string, string> = {
    terminal_run_command: 'Terminal Command',
    python_execute: 'Python Execution',
    web_search: 'Web Search',
    web_extract: 'Web Content Extraction',
    database_query: 'Database Query',
    file_ops: 'File Operations',
    gmail_send: 'Send Email (Gmail)',
    gmail_read: 'Read Email (Gmail)',
    google_calendar_create_event: 'Schedule Calendar Event',
    google_calendar_list_events: 'Check Calendar',
    hubspot_create_contact: 'Create HubSpot Lead',
    hubspot_get_contact: 'Retrieve HubSpot Lead',
    hubspot_list_contacts: 'List HubSpot Leads',
    subagent_start: 'Subagent Spawn',
    subagent_done: 'Subagent Complete',
    subagent_error: 'Subagent Failed',
    subagent: 'Subagent Task',
    approval_required: 'Approval Required',
  };
  if (map[clean]) return map[clean];

  return clean
    .split(/[._-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getToolIcon(tool: string) {
  const t = tool.toLowerCase();
  if (t.includes('terminal') || t.includes('bash') || t.includes('command')) return Terminal;
  if (t.includes('python') || t.includes('code') || t.includes('script')) return Code2;
  if (t.includes('web_search') || t.includes('search')) return Search;
  if (t.includes('web_extract') || t.includes('scrape') || t.includes('fetch')) return Globe;
  if (t.includes('database') || t.includes('sql') || t.includes('postgres')) return Database;
  if (t.includes('gmail') || t.includes('mail') || t.includes('email')) return Mail;
  if (t.includes('calendar') || t.includes('event')) return Calendar;
  if (t.includes('hubspot') || t.includes('contact') || t.includes('crm') || t.includes('lead')) return Users;
  if (t.includes('file') || t.includes('ops') || t.includes('fs')) return Folder;
  if (t.includes('subagent')) return Bot;
  return Wrench;
}

function readableLine(value: unknown): string | null {
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean || clean === '[object Object]') return null;
    return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return readableLine(rec.message) || readableLine(rec.query) || readableLine(rec.text);
  }
  return null;
}

function connectHref(response?: string): string | null {
  if (!response) return null;
  const head = response.slice(0, 2000);
  let url = '';
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data as Record<string, unknown>
      : parsed;
    if (data.connected === false) {
      url = typeof data.setupUrl === 'string' ? data.setupUrl : '/connectors';
    } else if (/not connected|not signed in/i.test(head)) {
      url = typeof data.setupUrl === 'string' ? data.setupUrl : '/connectors';
    }
  } catch {
    if (/not connected|not signed in/i.test(head)) url = '/connectors';
  }
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  return url;
}

function parseStepSummary(rawResponse?: string): string | null {
  if (!rawResponse || rawResponse.trim() === '[object Object]') return null;
  const response = unwrapToolText(rawResponse);
  if (!response) return null;
  const search = parseSearchView(response);
  if (search?.query) {
    const count = search.hits.length;
    return count > 0
      ? `“${search.query}” · ${count} source${count === 1 ? '' : 's'}`
      : `“${search.query}”`;
  }
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const message = readableLine(parsed.message);
      if (message) return message;
      const summary = readableLine(parsed.summary);
      if (summary) return summary;
      const output = readableLine(parsed.output);
      if (output) return output.length > 120 ? `${output.slice(0, 120)}…` : output;
      if (Array.isArray(parsed.rows)) {
        return `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} returned`;
      }
      if (Array.isArray(parsed.results)) {
        return `${parsed.results.length} result${parsed.results.length === 1 ? '' : 's'} found`;
      }
      if (typeof parsed.count === 'number') {
        return `${parsed.count} item${parsed.count === 1 ? '' : 's'} found`;
      }
      const error = readableLine(parsed.error);
      if (error) return error;
    }
  } catch {
    // not JSON
  }
  const clean = response.trim();
  if (!clean || clean.startsWith('{') || clean.startsWith('[')) return null;
  if (clean === '[object Object]') return null;
  const firstLine = clean.split('\n')[0];
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function SearchHitList({ hits }: { hits: SearchHit[] }) {
  if (hits.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {hits.map((hit) => {
        const host = hostOf(hit.url);
        const body = (
          <>
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              <Globe className="w-3 h-3 shrink-0" />
              <span className="truncate">{host || 'Source'}</span>
            </span>
            <span className="mt-1 block text-[12px] font-semibold text-slate-900 leading-snug line-clamp-2">{hit.title}</span>
            {hit.snippet ? (
              <span className="mt-1 block text-[11px] text-slate-600 leading-snug line-clamp-3">{hit.snippet}</span>
            ) : null}
          </>
        );
        const className = 'block h-full rounded-xl border border-cream-200 bg-white px-3 py-2.5 shadow-xs hover:border-amber-300 hover:bg-amber-50/50 transition-colors';
        return hit.url ? (
          <a
            key={`${hit.url}-${hit.title}`}
            href={hit.url}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {body}
          </a>
        ) : (
          <div key={hit.title} className={className}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

function SearchingPulse({ query }: { query?: string }) {
  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-900">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>{query ? `Searching for “${query}”` : 'Searching the web'}</span>
        <span className="inline-flex gap-0.5 ml-0.5" aria-hidden>
          <span className="w-1 h-1 rounded-full bg-amber-600 animate-bounce [animation-delay:0ms]" />
          <span className="w-1 h-1 rounded-full bg-amber-600 animate-bounce [animation-delay:120ms]" />
          <span className="w-1 h-1 rounded-full bg-amber-600 animate-bounce [animation-delay:240ms]" />
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="h-2 w-4/5 rounded-full bg-amber-200/80 animate-pulse" />
        <div className="h-2 w-3/5 rounded-full bg-amber-100 animate-pulse" />
      </div>
    </div>
  );
}

function StatusIcon({ status, spinning }: { status: TrajectoryStatus; spinning?: boolean }) {
  if (spinning || status === 'running') {
    return <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />;
  }
  if (status === 'error') return <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />;
  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
}

function JsonBlock({ title, content: rawContent }: { title: string; content: string }) {
  const content = unwrapToolText(rawContent) || rawContent;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  let formatted = content;
  let preview: string | null = null;
  try {
    const parsed = JSON.parse(content);
    formatted = JSON.stringify(parsed, null, 2);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      const data = rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
        ? (rec.data as Record<string, unknown>)
        : rec;
      preview =
        readableLine(rec.message) ||
        readableLine(rec.summary) ||
        readableLine(data.message) ||
        (Array.isArray(rec.results) ? `${rec.results.length} results` : null) ||
        (Array.isArray(rec.rows) ? `${rec.rows.length} rows` : null);
    }
  } catch {
    const clean = content.replace(/\s+/g, ' ').trim();
    if (clean && !clean.startsWith('{') && clean !== '[object Object]') {
      preview = clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
    }
  }

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-1.5 rounded-lg border border-cream-200 bg-cream-50/60 overflow-hidden">
      <div className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:text-slate-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-left py-0.5 flex-1 min-w-0"
        >
          {open ? <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />}
          <span className="shrink-0">{title}</span>
          {!open && preview && (
            <span className="text-[10px] text-slate-500 font-normal truncate">{preview}</span>
          )}
          {!open && !preview && (
            <span className="text-[10px] text-slate-400 font-normal">
              ({formatted.length > 200 ? `${formatted.length} chars` : 'details'})
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] font-normal text-slate-500 hover:text-slate-800 px-1.5 py-0.5 rounded hover:bg-slate-200/60 transition-colors shrink-0"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-slate-400" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
      </div>
      {open && (
        <pre className="px-2.5 pb-2 pt-1 text-[10px] font-mono text-slate-700 whitespace-pre-wrap break-words max-h-48 overflow-auto border-t border-cream-200/80 bg-white/80">
          {formatted}
        </pre>
      )}
    </div>
  );
}

export function ApprovalBar({
  toolName,
  request,
  decided,
  reason,
  resolving,
  onAllow,
  onDeny,
}: {
  toolName: string;
  /** The call being approved. Without it the card can only name the tool. */
  request?: ApprovalCallInfo | null;
  decided?: 'allow' | 'deny';
  reason?: string;
  resolving?: boolean;
  onAllow: () => void;
  onDeny: (reason: string) => void;
}) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [reasonError, setReasonError] = useState(false);

  const submitDeny = () => {
    const r = denyReason.trim();
    if (!r) {
      setReasonError(true);
      return;
    }
    onDeny(r);
  };

  const held = request?.call
    ? describeHeldAction({ id: 'chat', payload: { tool: request.call.tool, action: request.call.action, summary: request.summary, payload: request.call.args } })
    : null;

  return (
    <div className="mt-2 rounded-xl border border-amber-500/40 bg-amber-50 p-3">
      {held ? (
        <div className="mb-2 space-y-1.5">
          <p className="text-sm font-semibold text-heading">{held.title}</p>
          {held.details.length > 0 ? (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
              {held.details.map((d) => (
                <React.Fragment key={d.label}>
                  <dt className="text-slate-500">{d.label}</dt>
                  <dd className="text-heading break-words">{d.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
          {held.body ? <p className="whitespace-pre-wrap border-l-2 border-amber-300 pl-2 text-xs text-slate-700">{held.body}</p> : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
          {decided === 'allow' ? 'Tool Approved' : decided === 'deny' ? 'Tool Approval Denied' : held ? 'Needs your OK' : 'Tool Approval Required for'}
          {held ? null : (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-mono text-amber-900 border border-amber-200">
              {shortToolName(toolName)}
            </span>
          )}
          {decided === 'allow' && <Check className="w-3.5 h-3.5 text-emerald-600" />}
          {decided === 'deny' && <CircleX className="w-3.5 h-3.5 text-rose-600" />}
        </div>
        {!decided && !denyOpen && (
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={resolving}
              onClick={onAllow}
              className="px-2.5 py-1 rounded-lg bg-amber-600 text-white text-[11px] font-semibold hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1"
            >
              <ThumbsUp className="w-3 h-3" /> Approve
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={() => {
                setDenyOpen(true);
                setReasonError(false);
              }}
              className="px-2.5 py-1 rounded-lg bg-white text-slate-700 border border-slate-300 text-[11px] font-semibold hover:bg-slate-100 disabled:opacity-50 flex items-center gap-1"
            >
              <ThumbsDown className="w-3 h-3" /> Deny
            </button>
          </div>
        )}
      </div>

      {!decided && denyOpen && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input
              placeholder="Enter reason for denial (required)"
              aria-label="Reason for denial"
              value={denyReason}
              disabled={resolving}
              onChange={(e) => {
                setDenyReason(e.target.value);
                setReasonError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDeny();
              }}
              className="h-8 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <button
              type="button"
              disabled={resolving}
              onClick={submitDeny}
              className="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold hover:bg-rose-700 disabled:opacity-50"
            >
              Submit
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={() => {
                setDenyOpen(false);
                setDenyReason('');
                setReasonError(false);
              }}
              className="px-2.5 py-1 rounded-lg bg-white text-slate-600 border border-slate-300 text-[11px] font-semibold hover:bg-slate-100 disabled:opacity-50"
            >
              Back
            </button>
          </div>
          {reasonError && (
            <span className="text-[11px] text-rose-700" role="alert">
              Reason is required
            </span>
          )}
        </div>
      )}

      {decided && reason && <div className="mt-1.5 text-[11px] text-slate-600">Reason: {reason}</div>}
    </div>
  );
}

function ToolStepRow({
  step,
  isLast,
  onAllow,
  onDeny,
}: {
  step: TrajectoryStep;
  isLast: boolean;
  onAllow: (a: ApprovalSlotData) => void;
  onDeny: (a: ApprovalSlotData, reason: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasBody = !!(step.request || step.response || step.approval);
  const Icon = getToolIcon(step.tool);
  const title = humanToolName(step.tool);
  const rawName = shortToolName(step.tool);
  const isSearch = isWebSearchTool(step.tool);
  const search = isSearch ? parseSearchView(step.response) || parseSearchView(step.request) : null;
  const liveQuery = isSearch ? (search?.query || queryFromToolLabel(step.request)) : '';
  const summary = search?.query
    ? (search.hits.length > 0
      ? `${search.hits.length} source${search.hits.length === 1 ? '' : 's'} for “${search.query}”`
      : `Searched “${search.query}”`)
    : parseStepSummary(step.response);
  const connectTo = connectHref(step.response);
  const signInProvider = connectTo
    ? providerIdForTool(step.tool) || providerIdFromConnectHref(connectTo)
    : null;

  return (
    <div className="flex gap-2">
      <div className="flex shrink-0 flex-col items-center">
        <div className="min-h-[0.5rem] w-px flex-none bg-cream-300" />
        <div
          className={`my-0.5 flex h-6 w-6 items-center justify-center rounded-lg border ${
            step.status === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : step.status === 'running'
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-cream-200 bg-cream-50 text-slate-600'
          }`}
        >
          <Icon className="w-3 h-3" />
        </div>
        {!isLast && <div className="min-h-[0.75rem] w-px flex-1 bg-cream-300" />}
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <button
          type="button"
          onClick={() => hasBody && setExpanded((v) => !v)}
          className="w-full flex items-center gap-1.5 text-left group"
        >
          <StatusIcon status={step.status} />
          <span className="text-[11px] font-semibold text-slate-800 truncate" title={rawName}>{title}</span>
          {step.status === 'running' && !isSearch && (
            <span className="text-[10px] text-amber-700 animate-pulse shrink-0 font-medium">Working…</span>
          )}
          {hasBody && (
            <span className="text-slate-400 ml-auto shrink-0 group-hover:text-slate-600 transition-colors">
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
          )}
        </button>

        {isSearch && step.status === 'running' && <SearchingPulse query={liveQuery} />}

        {summary && step.status !== 'running' && !search?.hits.length && (
          <div
            className={`mt-1 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug ${
              step.status === 'error'
                ? 'bg-rose-50 border border-rose-200 text-rose-800'
                : 'bg-cream-50 border border-cream-200 text-slate-700'
            }`}
          >
            {summary}
          </div>
        )}

        {step.status !== 'running' && signInProvider && (
          <span className="mt-1.5 inline-flex flex-col items-start">
            <ConnectorSignInControl
              tool={signInProvider}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 transition-colors"
            />
          </span>
        )}

        {step.status !== 'running' && !signInProvider && connectTo && (
          <a
            href={connectTo}
            className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 transition-colors"
          >
            Connect this tool
          </a>
        )}

        {search && step.status !== 'running' && search.hits.length > 0 && (
          <SearchHitList hits={search.hits} />
        )}

        {expanded && (
          <div className="mt-1">
            {step.request && <JsonBlock title="Request" content={step.request} />}
            {step.response && <JsonBlock title="Response" content={step.response} />}
          </div>
        )}
        {step.approval && (
          <ApprovalBar
            toolName={step.tool}
            request={step.approval}
            decided={step.approval.decided}
            reason={step.approval.reason}
            resolving={step.approval.resolving}
            onAllow={() => onAllow(step.approval as ApprovalSlotData)}
            onDeny={(reason) => onDeny(step.approval as ApprovalSlotData, reason)}
          />
        )}
      </div>
    </div>
  );
}

function SubAgentCardView({
  step,
  onAllow,
  onDeny,
}: {
  step: TrajectoryStep;
  onAllow: (a: ApprovalSlotData) => void;
  onDeny: (a: ApprovalSlotData, reason: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showInstruction, setShowInstruction] = useState(false);
  const kids = step.children || [];
  const done = kids.filter((k) => k.status !== 'running').length;
  const duration = formatDuration(step.durationMs);
  const displayName = step.subagentName && step.subagentName !== 'subagent' ? step.subagentName : null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-600 shrink-0">
          <Bot className="w-3.5 h-3.5 text-white" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] font-semibold text-amber-950 truncate">
            {displayName ? displayName : 'Specialist'}
          </span>
          <span className="block text-[10px] text-amber-800/80 font-mono">
            {step.status === 'running'
              ? 'working…'
              : `${done}/${kids.length} steps done${duration ? ` · ${duration}` : ''}`}
          </span>
        </span>
        <StatusIcon status={step.status} />
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-amber-500" /> : <ChevronRight className="w-3.5 h-3.5 text-amber-500" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 ml-2 border-l-2 border-amber-200">
          {step.subagentInstruction && (
            <div className="mb-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowInstruction((v) => !v);
                }}
                className="flex items-center gap-1 text-[10px] font-semibold text-amber-800 hover:text-amber-950"
              >
                {showInstruction ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Task instruction
              </button>
              {showInstruction && (
                <div className="mt-1 rounded-md border border-amber-200 bg-white/80 p-2 text-[10px] text-slate-600 whitespace-pre-wrap break-words max-h-32 overflow-auto">
                  {step.subagentInstruction}
                </div>
              )}
            </div>
          )}
          {kids.length === 0 && <div className="text-[10px] text-amber-700/70 italic py-1">starting…</div>}
          {kids.map((k, i) =>
            k.children ? (
              <SubAgentCardView key={k.key} step={k} onAllow={onAllow} onDeny={onDeny} />
            ) : (
              <ToolStepRow key={k.key} step={k} isLast={i === kids.length - 1} onAllow={onAllow} onDeny={onDeny} />
            )
          )}
        </div>
      )}
    </div>
  );
}

export function AgentTrajectory({
  data,
  onAllow,
  onDeny,
  onStop,
}: {
  data: TrajectoryData;
  onAllow: (a: ApprovalSlotData) => void;
  onDeny: (a: ApprovalSlotData, reason: string) => void;
  onStop?: () => void;
}) {
  if (data.steps.length === 0) return null;
  const doneCount = data.steps.filter((s) => s.status !== 'running').length;
  const searchSteps = data.steps.filter((s) => isWebSearchTool(s.tool) && !s.children);
  const allSearch = searchSteps.length > 0 && searchSteps.length === data.steps.length;
  const turnLabel = allSearch
    ? (data.running ? 'Searching the web' : `Found on the web · ${searchSteps.length} search${searchSteps.length === 1 ? '' : 'es'}`)
    : `Turn · ${data.steps.length} step${data.steps.length === 1 ? '' : 's'}`;
  return (
    <div className="rounded-2xl border border-cream-300 bg-white p-3.5 shadow-sm">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {turnLabel}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-medium">
          {data.running ? (
            <span className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 text-amber-600 animate-spin" />
                <span className="text-amber-700">running</span>
              </span>
              {onStop && (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex items-center gap-1 text-[10px] font-semibold text-rose-700 hover:text-rose-900 bg-rose-50 hover:bg-rose-100 px-2 py-0.5 rounded-md border border-rose-200 transition-colors shadow-xs"
                  title="Stop agent turn"
                >
                  <Square className="w-2.5 h-2.5 fill-rose-600 text-rose-600" />
                  <span>Stop</span>
                </button>
              )}
            </span>
          ) : data.error ? (
            <>
              <XCircle className="w-3 h-3 text-rose-600" />
              <span className="text-rose-700">error</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              <span className="text-emerald-700">
                {doneCount < data.steps.length ? 'waiting' : 'done'}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {data.steps.map((s, i) =>
          s.children ? (
            <SubAgentCardView key={s.key} step={s} onAllow={onAllow} onDeny={onDeny} />
          ) : (
            <ToolStepRow key={s.key} step={s} isLast={i === data.steps.length - 1} onAllow={onAllow} onDeny={onDeny} />
          )
        )}
      </div>
      {data.usage && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-cream-200 px-1 pt-2 text-[10px] font-mono text-slate-500">
          {formatDuration(data.usage.durationMs) && <span>⏱ {formatDuration(data.usage.durationMs)}</span>}
          {formatTokens(data.usage.totalTokens) && <span>∑ {formatTokens(data.usage.totalTokens)} tokens</span>}
          {formatTokens(data.usage.inputTokens) && <span>in {formatTokens(data.usage.inputTokens)}</span>}
          {formatTokens(data.usage.outputTokens) && <span>out {formatTokens(data.usage.outputTokens)}</span>}
          {data.usage.totalCostInUsd !== undefined && Number.isFinite(data.usage.totalCostInUsd) && (
            <span>${data.usage.totalCostInUsd.toFixed(4)}</span>
          )}
        </div>
      )}
      {data.error && <div className="mt-2 text-[11px] text-rose-700 font-mono break-words">{data.error}</div>}
    </div>
  );
}

/**
 * Build trajectory nodes from a finished turn (executedSteps carry results)
 * or from live tool events (no results yet → running tail). Subagent spans
 * group everything between subagent_start and subagent_done, mirroring
 * TrueForge's nested thread cards. Approval slots align by order with the
 * approvals array from the same turn.
 */
export interface TrajectorySubagent {
  threadId: string;
  title: string;
  name: string;
  instruction: string;
  model?: string;
  status: 'started' | 'done' | 'error';
  durationMs?: number;
  createdAt: string;
  error?: string;
}

export function buildTrajectory(input: {
  executedSteps?: Array<{ step?: number; action?: string; toolUsed?: string; result?: string; threadId?: string }>;
  toolEvents?: Array<{ tool: string; label?: string }>;
  done: boolean;
  error?: string;
  approvals?: Array<{ threadId: string; toolCallId: string; toolName: string } & ApprovalCallInfo>;
  sessionId?: string;
  decided?: Record<string, 'allow' | 'deny'>;
  decidedReasons?: Record<string, string>;
  resolving?: boolean;
  subagents?: TrajectorySubagent[];
  usage?: TrajectoryUsage;
}): TrajectoryData {
  const steps: TrajectoryStep[] = [];
  let approvalIdx = 0;
  const attachApproval = (tool: string): ApprovalSlotData | null => {
    const list = input.approvals || [];
    if (!input.sessionId || approvalIdx >= list.length) return null;
    const a = list[approvalIdx];
    approvalIdx += 1;
    const key = `${a.threadId}:${a.toolCallId}`;
    void tool;
    return {
      sessionId: input.sessionId,
      threadId: a.threadId,
      toolCallId: a.toolCallId,
      summary: a.summary,
      call: a.call,
      decided: input.decided?.[key],
      reason: input.decidedReasons?.[key],
      resolving: input.resolving,
    };
  };

  // Pair open subagent spans with started/done/error lifecycle events (by order,
  // then by threadId) so cards show the real name, task instruction and duration.
  const startedList = (input.subagents || []).filter((s) => s.status === 'started');
  const doneByThread = new Map<string, TrajectorySubagent>();
  for (const s of input.subagents || []) {
    if ((s.status === 'done' || s.status === 'error') && s.threadId) doneByThread.set(s.threadId, s);
  }
  let startedIdx = 0;
  const nextStarted = (): TrajectorySubagent | undefined =>
    startedIdx < startedList.length ? startedList[startedIdx++] : undefined;

  if (input.executedSteps && input.executedSteps.length > 0) {
    const spans = new Map<string, TrajectoryStep>();
    const openIds: string[] = [];
    const push = (s: TrajectoryStep, threadId?: string) => {
      const owner = threadId ? spans.get(threadId) : undefined;
      if (owner?.children && owner.status === 'running') owner.children.push(s);
      else if (!threadId && openIds.length === 1) {
        const only = spans.get(openIds[0]);
        if (only?.children && only.status === 'running') {
          only.children.push(s);
          return;
        }
        steps.push(s);
      } else {
        steps.push(s);
      }
    };
    input.executedSteps.forEach((s, i) => {
      const stored = s as { toolUsed?: string; action?: string; result?: string; observation?: string; threadId?: string };
      const tool = stored.toolUsed || stored.action || 'tool';
      const result = stored.result || stored.observation;
      if (tool === 'subagent_start') {
        const meta = nextStarted();
        const threadId = meta?.threadId || stored.threadId;
        const span: TrajectoryStep = {
          key: `sub-${i}`,
          tool: 'subagent',
          status: 'running',
          children: [],
          subagentName: meta?.name,
          subagentInstruction: meta?.instruction,
          subagentThreadId: threadId,
          durationMs: threadId ? doneByThread.get(threadId)?.durationMs : undefined,
        };
        steps.push(span);
        if (threadId) {
          spans.set(threadId, span);
          openIds.push(threadId);
        }
        return;
      }
      if (tool === 'subagent_done' || tool === 'subagent_error') {
        const hint = (stored.threadId || result || '').trim();
        let idx = openIds.findIndex((id) => id === hint || (hint.length >= 8 && id.startsWith(hint)));
        if (idx === -1 && openIds.length > 0) idx = openIds.length - 1;
        if (idx >= 0) {
          const id = openIds[idx];
          const span = spans.get(id);
          openIds.splice(idx, 1);
          if (span) {
            const terminal = doneByThread.get(id);
            const d = terminal?.durationMs;
            if (d !== undefined) span.durationMs = d;
            if (tool === 'subagent_error' || terminal?.status === 'error') {
              span.status = 'error';
              span.error = terminal?.error || (typeof result === 'string' ? result : undefined);
            } else {
              span.status = span.children!.every((c) => c.status !== 'running') ? 'success' : 'running';
            }
          }
        }
        return;
      }
      if (tool === 'approval_required') {
        const firstToken = (result || '').split(/\s/)[0] || '';
        const approvalTool = /^[\w.:-]+$/.test(firstToken) && firstToken !== 'tool' ? firstToken : tool;
        push({
          key: `step-${i}`,
          tool: approvalTool,
          request: undefined,
          response: undefined,
          status: 'running',
          approval: attachApproval(tool),
        }, stored.threadId);
        return;
      }
      push({
        key: `step-${i}`,
        tool,
        request: s.action && s.action !== tool ? s.action : undefined,
        response: result,
        status: isErrorResult(result) ? 'error' : 'success',
      }, stored.threadId);
    });
    for (const id of openIds) {
      const span = spans.get(id);
      if (span) span.status = 'running';
    }
  } else {
    (input.toolEvents || []).forEach((e, i, arr) => {
      if (e.tool === 'subagent_start') {
        const meta = nextStarted();
        steps.push({
          key: `sub-${i}`,
          tool: 'subagent',
          status: 'running',
          children: [],
          subagentName: meta?.name,
          subagentInstruction: meta?.instruction,
          subagentThreadId: meta?.threadId,
          durationMs: meta?.threadId ? doneByThread.get(meta.threadId)?.durationMs : undefined,
        });
        return;
      }
      if (e.tool === 'subagent_done' || e.tool === 'subagent_error') {
        const open = [...steps].reverse().find((s) => s.children && s.status === 'running');
        if (open) {
          if (open.subagentThreadId) {
            const terminal = doneByThread.get(open.subagentThreadId);
            const d = terminal?.durationMs;
            if (d !== undefined) open.durationMs = d;
            if (e.tool === 'subagent_error' || terminal?.status === 'error') {
              open.status = 'error';
              open.error = terminal?.error || e.label;
            } else {
              open.status = 'success';
            }
          } else if (e.tool === 'subagent_error') {
            open.status = 'error';
            open.error = e.label;
          } else {
            open.status = 'success';
          }
        }
        return;
      }
      if (e.tool === 'approval_required') {
        steps.push({
          key: `step-${i}`,
          tool: e.tool,
          request: e.label,
          status: 'running',
          approval: attachApproval(e.tool),
        });
        return;
      }
      steps.push({
        key: `step-${i}`,
        tool: e.tool,
        request: e.label,
        status: i === arr.length - 1 && !input.done ? 'running' : 'success',
        response: undefined,
      } as TrajectoryStep);
    });
  }

  // Ensure any approvals pending on the turn are always surfaced as trajectory steps,
  // matching TrueForge's ToolApprovalBar behavior even if unattached to prior tool steps.
  while (input.approvals && approvalIdx < input.approvals.length) {
    const a = input.approvals[approvalIdx];
    const key = `${a.threadId}:${a.toolCallId}`;
    steps.push({
      key: `approval-${approvalIdx}`,
      tool: a.toolName || 'tool',
      status: 'running',
      approval: {
        sessionId: input.sessionId || '',
        threadId: a.threadId,
        toolCallId: a.toolCallId,
        summary: a.summary,
        call: a.call,
        decided: input.decided?.[key],
        reason: input.decidedReasons?.[key],
        resolving: input.resolving,
      },
    });
    approvalIdx += 1;
  }

  if (input.done) {
    const settle = (list: TrajectoryStep[]) => {
      for (const step of list) {
        if (step.children) settle(step.children);
        const waitingOnPerson = Boolean(step.approval && !step.approval.decided);
        if (step.status === 'running' && !waitingOnPerson) {
          step.status = isErrorResult(step.response) ? 'error' : 'success';
        }
      }
    };
    settle(steps);
  }

  const hideAskUser = (list: TrajectoryStep[]): TrajectoryStep[] =>
    list
      .filter((step) => !isAskUserTool(step.tool))
      .map((step) => (step.children ? { ...step, children: hideAskUser(step.children) } : step));

  return {
    steps: hideAskUser(steps),
    running: !input.done && !input.error,
    error: input.error,
    usage: input.usage,
  };
}
