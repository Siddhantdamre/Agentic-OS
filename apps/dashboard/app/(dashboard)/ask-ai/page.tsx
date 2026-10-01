'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Bot,
  User,
  Zap,
  RefreshCw,
  Copy,
  Check,
  Brain,
  ShieldAlert,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  BookmarkPlus,
  Square,
  History,
  Plus,
  PanelLeft,
} from 'lucide-react';
import { AskAiHistoryDrawer, ConversationItem } from '@/components/ask-ai/AskAiHistoryDrawer';
import { FormattedMarkdownResponse } from '@/components/chat/FormattedMarkdownResponse';
import { visibleAnswer } from '@/lib/tool-answer';
import { ActionPermissionCard, ProposedActionData } from '@/components/chat/ActionPermissionCard';
import { ReasoningStrip } from '@/components/chat/ReasoningStrip';
import { PlanCard, PlanStep } from '@/components/chat/PlanCard';
import { ExecutionStrip, StepRunStatus } from '@/components/chat/ExecutionStrip';
import { DraftPanel, DraftState } from '@/components/chat/DraftPanel';
import { CitationChips } from '@/components/ask-ai/CitationChips';
import { AgentTrajectory, buildTrajectory, humanToolName } from '@/components/chat/AgentTrajectory';
import {
  AskModeLockStrip,
  AskRoutingChip,
  EmployeeModeSelector,
  type AskEmployeeOption,
  type AskMode,
  type AskRouting,
} from '@/components/chat/EmployeeModeSelector';
import { parseEmployeeMentions, type MentionableEmployee } from '@/lib/employee-mentions';
import {
  deriveToolCount,
  employeeIdsForRequest,
  normalizeAskMode,
  parseAskRouting,
} from '@/lib/ask-mode-selection';
import { LiveRegion, StatusBadge } from '@/components/a11y';

function formatToolStatusLine(tool: string, label?: string): string {
  const human = humanToolName(tool);
  if (!label) return `Executing ${human}…`;
  try {
    const parsed = JSON.parse(label);
    if (parsed && typeof parsed === 'object') {
      const summary = parsed.query || parsed.command || parsed.sql || parsed.url || parsed.to || parsed.title;
      if (summary) return `${human}: ${summary}`;
    }
  } catch {
    // not JSON
  }
  const clean = label.trim();
  const snippet = clean.length > 55 ? `${clean.slice(0, 55)}…` : clean;
  return `${human}: ${snippet}`;
}

function findEmployeeByRole(
  employees: AskEmployeeOption[],
  toRole: string,
): AskEmployeeOption | undefined {
  const target = toRole.toLowerCase().trim();
  const exact = employees.find((e) => e.role.toLowerCase() === target);
  if (exact) return exact;
  const includes = employees.find(
    (e) =>
      e.role.toLowerCase().includes(target) ||
      target.includes(e.role.toLowerCase()) ||
      e.name.toLowerCase() === target,
  );
  return includes;
}

/** Switches Pick one to the matching role — does not send until the user clicks Send. */
function HandoffOfferControl({
  toRole,
  reason,
  employees,
  onHandTo,
}: {
  toRole: string;
  reason: string;
  employees: AskEmployeeOption[];
  onHandTo: (employeeId: string) => void;
}) {
  const match = findEmployeeByRole(employees, toRole);
  const label = match ? `Hand to ${match.name}` : `Hand to ${toRole}`;
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <p className="text-xs text-slate-600">{reason}</p>
      <button
        type="button"
        disabled={!match}
        aria-label={label}
        title={
          match
            ? `Switch Pick one to ${match.name} (${match.role}). Does not send until you click Send.`
            : `No roster employee with role ${toRole}`
        }
        onClick={() => {
          if (match) onHandTo(match.id);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && match) {
            e.preventDefault();
            onHandTo(match.id);
          }
        }}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-amber-500/40 bg-amber-50 text-amber-950 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {label}
      </button>
    </div>
  );
}

interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  provider?: string;
  handledBy?: string;
  routing?: AskRouting;
  handoff?: { toRole: string; reason: string };
  timestamp: string;
  suggestedActions?: Array<{ label: string; tool: string; action: string }>;
  proposedAction?: ProposedActionData;
  error?: string;
  retryable?: boolean;
  retryPrompt?: string;
  partialReply?: string;
  type?: 'simple' | 'complex' | 'reasoning' | 'plan' | 'draft';
  reasoning?: { text: string; durationMs?: number | null };
  statusLine?: string;
  usedTools?: string[];
  toolEvents?: Array<{ tool: string; label?: string }>;
  planCard?: {
    planId: string;
    summary: string;
    steps: PlanStep[];
    status: 'pending' | 'approved' | 'running' | 'completed' | 'cancelled' | 'completed_with_errors';
  };
  planId?: string;
  draftBox?: DraftState;
  approvalBox?: {
    sessionId: string;
    approvals: Array<{ threadId: string; toolCallId: string; toolName: string }>;
    decided?: Record<string, 'allow' | 'deny'>;
    decidedReasons?: Record<string, string>;
    resolving?: boolean;
    /** 'all' or `${threadId}:${toolCallId}` — which item the deny-reason input is open for. */
    denyFor?: string | null;
    denyReason?: string;
    denyError?: boolean;
  };
  trajectory?: Array<{ step?: number; action?: string; toolUsed?: string; result?: string }>;
  streamDone?: boolean;
  sessionId?: string;
  subagents?: Array<{
    threadId: string;
    title: string;
    name: string;
    instruction: string;
    model?: string;
    status: 'started' | 'done' | 'error';
    durationMs?: number;
    createdAt: string;
    error?: string;
  }>;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    totalCostInUsd?: number;
    durationMs?: number;
  };
  execution?: {
    running: boolean;
    statuses: StepRunStatus[];
  };
  vote?: 'up' | 'down';
  stopped?: boolean;
}

const DEFAULT_SUGGESTIONS: Array<{ label: string; prompt: string; requires?: string[] }> = [
  { label: 'Ask about our Darex data', prompt: 'How many conversations and messages are in our workspace right now?' },
  { label: '📊 Analyze Google Ads & Meta Ads Performance', prompt: 'Summarize our active advertising metrics, CTR, and ROAS across Google Ads and Meta Ads.', requires: ['google-ads', 'meta-ads'] },
  { label: '📅 Book Sales Demo on Google Calendar', prompt: 'Can you schedule a product demo call on Google Calendar for tomorrow at 2:00 PM?', requires: ['google-calendar'] },
  { label: '🗃️ Log Lead into HubSpot CRM', prompt: 'Log a new qualified sales lead into HubSpot CRM with contact email lead@company.com.', requires: ['hubspot'] },
  { label: '📧 Dispatch Email Follow-Up via Gmail', prompt: 'Draft and dispatch a follow-up email to customer@company.com thanking them for their inquiry.', requires: ['gmail'] },
];

const formatTs = (raw?: string) => {
  if (!raw) return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const mapPlanStatus = (
  status: string
): NonNullable<Message['planCard']>['status'] => {
  switch (status) {
    case 'pending':
    case 'approved':
    case 'running':
    case 'completed':
    case 'cancelled':
    case 'completed_with_errors':
      return status;
    case 'failed':
      return 'completed_with_errors';
    default:
      return 'pending';
  }
};

const buildWelcome = (name: string, channels: string[]): Message => ({
  id: 'welcome',
  sender: 'ai',
  text:
    channels.length > 0
      ? `### Hello from DareX Executive

I can answer questions about **${name}** and act on the connectors that are actually connected:

${channels.map((c) => `- \`${c}\``).join('\n')}

Core tools (no OAuth): \`database_query\`, \`web_search\`, \`web_extract\`, \`file_ops\`.

If a connector is missing I will say so and point you to \`/connectors\` — I will not invent results.`
      : `### Hello from DareX Executive

I can answer questions about **${name}** and query your Darex data.

No OAuth connectors are connected yet. I will not invent Gmail, Calendar, CRM, or ads data. Connect tools at \`/connectors\` when you want me to act on them.

Always available: \`database_query\`, \`web_search\`, \`web_extract\`, \`file_ops\`.`,
  provider: 'TrueForge',
  timestamp: 'Just now',
});

function parseThreadMessages(
  thread: any,
  fallbackOrgName: string,
  fallbackChannels: string[]
): Message[] {
  const plans = Array.isArray(thread.plans) ? thread.plans : [];
  const planById = new Map(plans.map((p: any) => [p.id, p]));
  const serverMsgs: Message[] = (thread.messages || []).map((row: any) => {
    const tc = row.toolCalls || {};
    if (row.role === 'user') {
      return {
        id: row.id,
        sender: 'user' as const,
        text: row.content || '',
        timestamp: formatTs(row.createdAt),
      };
    }
    if (tc.type === 'complex' && tc.planId) {
      const plan = planById.get(tc.planId) as any;
      const status = mapPlanStatus(plan?.status || 'pending');
      const steps = (plan?.steps || tc.steps || []) as PlanStep[];
      const draftSrc = plan?.draft || (tc.draft ? { content: tc.draft, version: 1 } : null);
      const currentStep = Number(plan?.current_step || 0);
      const inferStatuses: StepRunStatus[] = steps.map((_, i) => {
        if (status === 'running' || status === 'completed' || status === 'completed_with_errors') {
          if (i < currentStep) return { status: 'done' };
          if (status === 'running' && i === currentStep) return { status: 'running' };
        }
        return { status: 'pending' };
      });
      return {
        id: row.id,
        sender: 'ai' as const,
        text: row.content || '',
        provider: 'TrueForge',
        timestamp: formatTs(row.createdAt),
        type: 'complex' as const,
        reasoning: { text: tc.reasoning || plan?.reasoning?.text || '', durationMs: null },
        planCard: {
          planId: tc.planId,
          summary: plan?.summary || tc.summary || '',
          steps,
          status,
        },
        draftBox: draftSrc?.content
          ? { content: String(draftSrc.content), version: Number(draftSrc.version || 1) }
          : undefined,
        execution:
          status === 'running' || status === 'completed' || status === 'completed_with_errors'
            ? { running: status === 'running', statuses: inferStatuses }
            : undefined,
      };
    }
    return {
      id: row.id,
      sender: 'ai' as const,
      text: row.content || '',
      provider: 'TrueForge',
      timestamp: formatTs(row.createdAt),
      usedTools: Array.isArray(tc.usedTools) ? tc.usedTools : undefined,
      trajectory: Array.isArray(tc.trajectory)
        ? tc.trajectory
        : Array.isArray(tc.executedSteps)
          ? tc.executedSteps
          : undefined,
      error: tc.error || undefined,
      retryable: Boolean(tc.retryable),
      streamDone: true,
    };
  });

  const seenPlanIds = new Set(
    serverMsgs.map((m) => m.planCard?.planId).filter(Boolean) as string[]
  );
  for (const plan of plans) {
    if (!plan?.id || seenPlanIds.has(plan.id)) continue;
    if (!['pending', 'approved', 'running'].includes(plan.status)) continue;
    serverMsgs.push({
      id: `plan_${plan.id}`,
      sender: 'ai',
      text: '',
      provider: 'TrueForge',
      timestamp: formatTs(plan.created_at),
      type: 'complex',
      reasoning: { text: plan.reasoning?.text || '', durationMs: null },
      planCard: {
        planId: plan.id,
        summary: plan.summary || '',
        steps: Array.isArray(plan.steps) ? plan.steps : [],
        status: mapPlanStatus(plan.status),
      },
      draftBox: plan.draft?.content
        ? { content: String(plan.draft.content), version: Number(plan.draft.version || 1) }
        : undefined,
    });
  }

  if (serverMsgs.length > 0) {
    const orphan = plans.find((p: any) => p.status === 'running');
    if (orphan?.id) {
      serverMsgs.push({
        id: `resume-${orphan.id}`,
        sender: 'ai',
        text:
          'A previous plan execution was interrupted by a reload. Review the plan and press Execute to resume — nothing was auto-run.',
        timestamp: formatTs(new Date().toISOString()),
        planId: orphan.id,
      });
    }
    return serverMsgs;
  }

  return [buildWelcome(thread.orgName || fallbackOrgName, thread.connectedChannels || fallbackChannels)];
}

export default function AskAiPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: `### Hello from DareX Executive

I can answer questions and query your Darex data. Connector actions only run for tools that are actually connected — I will not invent results.`,
      provider: 'TrueForge',
      timestamp: 'Just now',
    },
  ]);

  const [inputPrompt, setInputPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [executingTool, setExecutingTool] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('user@company.com');
  const [conversationId, setConversationId] = useState<string>('');
  const [connectedChannels, setConnectedChannels] = useState<string[]>([]);
  const [orgName, setOrgName] = useState<string>('Your Business');
  const [roster, setRoster] = useState<MentionableEmployee[]>([]);
  const [askEmployees, setAskEmployees] = useState<AskEmployeeOption[]>([]);
  const [askMode, setAskMode] = useState<AskMode>('auto');
  const [askEmployeeIds, setAskEmployeeIds] = useState<string[]>([]);
  const [modePickerRequestOpen, setModePickerRequestOpen] = useState(false);
  const [modePickerRequestMode, setModePickerRequestMode] = useState<AskMode | undefined>(undefined);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [lockedName, setLockedName] = useState<string | null>(null);
  const askModeRef = useRef<AskMode>('auto');
  const askEmployeeIdsRef = useRef<string[]>([]);
  const deepLinkAppliedRef = useRef(false);

  // Side Tab / History Drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [conversationsList, setConversationsList] = useState<ConversationItem[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [switchingConversationId, setSwitchingConversationId] = useState<string | null>(null);
  const [conversationActionError, setConversationActionError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const conversationIdRef = useRef<string>('');
  const queryBootstrapped = useRef(false);
  const turnAbortControllerRef = useRef<AbortController | null>(null);
  const executionAbortControllerRef = useRef<AbortController | null>(null);

  const storageKey = useRef<string>('askAiMessages');
  const sessionUserIdRef = useRef<string>('anon');
  const sessionOrgIdRef = useRef<string | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageNamespace = (userId: string, orgId?: string, convId?: string) =>
    `askAiMessages:${orgId || 'no-org'}:${userId || 'anon'}:${convId || 'active'}`;

  // Default sidebar open on desktop screens
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSidebarOpen(window.innerWidth >= 1024);
    }
  }, []);

  const fetchConversationsList = async () => {
    setLoadingConversations(true);
    setConversationActionError(null);
    try {
      const res = await fetch('/api/ask-ai/conversations');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.conversations)) {
          setConversationsList(data.conversations);
        }
      } else {
        setConversationActionError('Could not load chat history.');
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      setConversationActionError('Could not load chat history.');
    } finally {
      setLoadingConversations(false);
    }
  };

  const handleNewChat = async () => {
    if (turnAbortControllerRef.current) {
      turnAbortControllerRef.current.abort();
      turnAbortControllerRef.current = null;
    }
    if (executionAbortControllerRef.current) {
      executionAbortControllerRef.current.abort();
      executionAbortControllerRef.current = null;
    }
    setLoading(false);
    setInputPrompt('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    try {
      const res = await fetch('/api/ask-ai/conversations', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const newConv = data.conversation;
        setConversationId(newConv.id);
        conversationIdRef.current = newConv.id;
        storageKey.current = storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, newConv.id);
        resetAskModeToAuto();
        setMessages([buildWelcome(orgName, connectedChannels)]);
        setConversationsList((prev) => [
          {
            id: newConv.id,
            summary: newConv.summary || 'New Chat',
            created_at: newConv.created_at,
            updated_at: newConv.updated_at,
            message_count: 0,
          },
          ...prev.filter((c) => c.id !== newConv.id),
        ]);
        window.history.replaceState({}, '', `/ask-ai?c=${newConv.id}`);
      } else {
        const localId = crypto.randomUUID();
        setConversationId(localId);
        conversationIdRef.current = localId;
        storageKey.current = storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, localId);
        resetAskModeToAuto();
        setMessages([buildWelcome(orgName, connectedChannels)]);
        window.history.replaceState({}, '', `/ask-ai?c=${localId}`);
      }
    } catch {
      const localId = crypto.randomUUID();
      setConversationId(localId);
      conversationIdRef.current = localId;
      storageKey.current = storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, localId);
      resetAskModeToAuto();
      setMessages([buildWelcome(orgName, connectedChannels)]);
      window.history.replaceState({}, '', `/ask-ai?c=${localId}`);
    }
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const handleSelectConversation = async (id: string) => {
    if (id === conversationId || switchingConversationId) return;
    if (turnAbortControllerRef.current) {
      turnAbortControllerRef.current.abort();
      turnAbortControllerRef.current = null;
    }
    if (executionAbortControllerRef.current) {
      executionAbortControllerRef.current.abort();
      executionAbortControllerRef.current = null;
    }
    setLoading(false);
    setInputPrompt('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setSwitchingConversationId(id);
    setConversationActionError(null);
    try {
      const threadRes = await fetch(`/api/ask-ai?conversationId=${encodeURIComponent(id)}`);
      if (threadRes.ok) {
        const thread = await threadRes.json();
        if (thread.conversationId) {
          setConversationId(thread.conversationId);
          conversationIdRef.current = thread.conversationId;
          storageKey.current = storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, thread.conversationId);
        } else {
          storageKey.current = storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, id);
        }
        if (Array.isArray(thread.connectedChannels)) setConnectedChannels(thread.connectedChannels);
        if (thread.orgName) setOrgName(thread.orgName);
        applyConversationAskMode(thread);
        const parsed = parseThreadMessages(
          thread,
          thread.orgName || orgName,
          thread.connectedChannels || connectedChannels
        );
        messagesRef.current = parsed;
        setMessages(parsed);
        window.history.replaceState({}, '', `/ask-ai?c=${thread.conversationId || id}`);
      } else if (threadRes.status === 404) {
        setConversationActionError('That chat was not found or you do not have access.');
      } else {
        setConversationActionError('Could not open that chat. Try again.');
      }
    } catch (err) {
      console.error('Failed to switch conversation:', err);
      setConversationActionError('Could not open that chat. Try again.');
    } finally {
      setSwitchingConversationId(null);
      if (typeof window !== 'undefined' && window.innerWidth < 1024) {
        setSidebarOpen(false);
      }
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  };

  const handleRenameConversation = async (id: string, newSummary: string) => {
    setConversationActionError(null);
    try {
      const res = await fetch('/api/ask-ai/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, summary: newSummary }),
      });
      if (res.ok) {
        setConversationsList((prev) =>
          prev.map((c) => (c.id === id ? { ...c, summary: newSummary } : c))
        );
      } else {
        setConversationActionError('Could not rename that chat.');
      }
    } catch (err) {
      console.error('Failed to rename conversation:', err);
      setConversationActionError('Could not rename that chat.');
    }
  };

  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat from history?')) return;
    setConversationActionError(null);
    try {
      const res = await fetch(`/api/ask-ai/conversations?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        try {
          localStorage.removeItem(
            storageNamespace(sessionUserIdRef.current, sessionOrgIdRef.current, id)
          );
        } catch {
          // ignore
        }
        setConversationsList((prev) => prev.filter((c) => c.id !== id));
        if (id === conversationId) {
          handleNewChat();
        }
      } else {
        setConversationActionError('Could not delete that chat.');
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      setConversationActionError('Could not delete that chat.');
    }
  };

  // Keyboard shortcut listener: Cmd/Ctrl+Shift+H for history, Cmd/Ctrl+Shift+N for new chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    askModeRef.current = askMode;
  }, [askMode]);

  useEffect(() => {
    askEmployeeIdsRef.current = askEmployeeIds;
  }, [askEmployeeIds]);

  const applyConversationAskMode = (thread: {
    ask_mode?: unknown;
    ask_employee_ids?: unknown;
    askMode?: unknown;
    askEmployeeIds?: unknown;
  }) => {
    const rawMode = thread.ask_mode ?? thread.askMode;
    const rawIds = thread.ask_employee_ids ?? thread.askEmployeeIds;
    const mode = normalizeAskMode(rawMode);
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    setAskMode(mode);
    askModeRef.current = mode;
    const nextIds =
      mode === 'auto' ? [] : mode === 'single' ? ids.slice(0, 1) : ids.slice(0, 3);
    setAskEmployeeIds(nextIds);
    askEmployeeIdsRef.current = nextIds;
  };

  const resetAskModeToAuto = () => {
    setAskMode('auto');
    askModeRef.current = 'auto';
    setAskEmployeeIds([]);
    askEmployeeIdsRef.current = [];
  };

  // Hydrate from the server thread (messages + plans). localStorage is a cache only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let userId = 'anon';
      let orgId: string | undefined;
      try {
        const res = await fetch('/api/auth/session');
        const data = await res.json();
        if (!cancelled && data.userId) userId = data.userId;
        if (!cancelled && data.orgId) orgId = data.orgId;
        if (data.email) setCurrentUserEmail(data.email);
      } catch (e) { console.error('session fetch failed:', e); }
      if (cancelled) return;
      sessionUserIdRef.current = userId;
      sessionOrgIdRef.current = orgId;
      const searchParams = new URLSearchParams(window.location.search);
      const initialConvId = searchParams.get('c');
      const key = storageNamespace(userId, orgId, initialConvId || undefined);
      storageKey.current = key;
      let hydratedConversationId = '';
      let deepLinkedMode = false;

      // Deep link from Employees "Chat with": ?employee=<id>&mode=single — apply once, then strip.
      if (!deepLinkAppliedRef.current) {
        const empParam = searchParams.get('employee');
        const modeParam = searchParams.get('mode');
        if (empParam && empParam.trim() && (modeParam === 'single' || !modeParam)) {
          deepLinkAppliedRef.current = true;
          deepLinkedMode = true;
          const mode: AskMode = 'single';
          const ids = [empParam.trim()];
          setAskMode(mode);
          askModeRef.current = mode;
          setAskEmployeeIds(ids);
          askEmployeeIdsRef.current = ids;
          searchParams.delete('employee');
          searchParams.delete('mode');
          const qs = searchParams.toString();
          window.history.replaceState({}, '', qs ? `/ask-ai?${qs}` : '/ask-ai');
        } else {
          deepLinkAppliedRef.current = true;
        }
      }

      // Fetch conversation history list for side tab
      void fetchConversationsList();

      const fetchUrl = initialConvId
        ? `/api/ask-ai?conversationId=${encodeURIComponent(initialConvId)}`
        : '/api/ask-ai';

      try {
        const threadRes = await fetch(fetchUrl);
        if (threadRes.ok) {
          const thread = await threadRes.json();
          if (cancelled) return;
          if (thread.conversationId) {
            hydratedConversationId = thread.conversationId;
            conversationIdRef.current = thread.conversationId;
            setConversationId(thread.conversationId);
            storageKey.current = storageNamespace(userId, orgId, thread.conversationId);
            if (!initialConvId && typeof window !== 'undefined' && !window.location.search.includes('q=')) {
              const keep = new URLSearchParams(window.location.search);
              keep.set('c', thread.conversationId);
              window.history.replaceState({}, '', `/ask-ai?${keep.toString()}`);
            }
          }
          if (Array.isArray(thread.connectedChannels)) setConnectedChannels(thread.connectedChannels);
          if (thread.orgName) setOrgName(thread.orgName);
          if (!deepLinkedMode) applyConversationAskMode(thread);

          const serverMsgs = parseThreadMessages(
            thread,
            thread.orgName || 'Your Business',
            thread.connectedChannels || []
          );
          messagesRef.current = serverMsgs;
          setMessages(serverMsgs);
        } else {
          if (threadRes.status === 404 && initialConvId) {
            setConversationActionError('That chat was not found or you do not have access.');
            try {
              const fallbackRes = await fetch('/api/ask-ai');
              if (fallbackRes.ok) {
                const thread = await fallbackRes.json();
                if (!cancelled && thread.conversationId) {
                  hydratedConversationId = thread.conversationId;
                  conversationIdRef.current = thread.conversationId;
                  setConversationId(thread.conversationId);
                  storageKey.current = storageNamespace(userId, orgId, thread.conversationId);
                  window.history.replaceState({}, '', `/ask-ai?c=${thread.conversationId}`);
                  if (Array.isArray(thread.connectedChannels)) setConnectedChannels(thread.connectedChannels);
                  if (thread.orgName) setOrgName(thread.orgName);
                  if (!deepLinkedMode) applyConversationAskMode(thread);
                  const serverMsgs = parseThreadMessages(
                    thread,
                    thread.orgName || 'Your Business',
                    thread.connectedChannels || []
                  );
                  messagesRef.current = serverMsgs;
                  setMessages(serverMsgs);
                }
              }
            } catch (fallbackErr) {
              console.error('Ask AI fallback hydrate failed:', fallbackErr);
            }
          }
          if (!hydratedConversationId) {
            const saved = localStorage.getItem(key);
            if (saved) {
              try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
              } catch (e) {
                console.error('Failed to parse saved messages', e);
              }
            }
          }
        }
      } catch {
        const saved = localStorage.getItem(key);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
          } catch (e) {
            console.error('Failed to parse saved messages', e);
          }
        }
      }

      if (!cancelled && !queryBootstrapped.current) {
        queryBootstrapped.current = true;
        const q = new URLSearchParams(window.location.search).get('q');
        if (q?.trim()) {
          const keepC = new URLSearchParams(window.location.search).get('c');
          window.history.replaceState({}, '', keepC ? `/ask-ai?c=${keepC}` : '/ask-ai');
          const prompt = q.trim();
          const userMessage: Message = {
            id: `user_${Date.now()}`,
            sender: 'user',
            text: prompt,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          setMessages((prev) => [...prev.filter((m) => m.id !== 'welcome' || prev.length === 1), userMessage]);
          void sendRequest(prompt, hydratedConversationId || undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch('/api/employees')
      .then((res) => (res.ok ? res.json() : { employees: [] }))
      .then((data) => {
        const list = Array.isArray(data.employees) ? data.employees : [];
        const channels: string[] | null = Array.isArray(data.connectedChannels)
          ? data.connectedChannels.map(String)
          : null;
        setRoster(
          list
            .map((e: { id?: string; name?: string; role?: string; status?: string }) => ({
              id: e.id,
              name: String(e.name || ''),
              role: typeof e.role === 'string' ? e.role : undefined,
              status: e.status,
            }))
            .filter((e: MentionableEmployee) => e.name)
        );
        setAskEmployees(
          list
            .map(
              (e: {
                id?: string;
                name?: string;
                role?: string;
                status?: string;
                avatar_url?: string | null;
                avatarUrl?: string | null;
                tool_allowlist?: unknown;
                connected_tool_count?: unknown;
                connectedToolCount?: unknown;
              }) => {
                const id = typeof e.id === 'string' ? e.id : '';
                const name = String(e.name || '').trim();
                if (!id || !name) return null;
                const explicitConnected =
                  typeof e.connected_tool_count === 'number'
                    ? e.connected_tool_count
                    : typeof e.connectedToolCount === 'number'
                      ? e.connectedToolCount
                      : null;
                const derived =
                  explicitConnected != null
                    ? { count: Math.max(0, explicitConnected), label: 'connected' as const }
                    : deriveToolCount(e.tool_allowlist, channels);
                return {
                  id,
                  name,
                  role: typeof e.role === 'string' ? e.role : '',
                  avatarUrl: e.avatar_url ?? e.avatarUrl ?? null,
                  toolCount: derived.count,
                  toolCountLabel: derived.label,
                  status: typeof e.status === 'string' ? e.status : 'active',
                } satisfies AskEmployeeOption;
              }
            )
            .filter((e: AskEmployeeOption | null): e is AskEmployeeOption => e != null)
        );
      })
      .catch(() => {
        setRoster([]);
        setAskEmployees([]);
      });
  }, []);

  // Persistence: Debounced, namespaced save. Strip heavy payloads (big plan
  // steps, draft/execution blobs) before writing so localStorage never exceeds
  // quota, and never save executor-only transient state.
  useEffect(() => {
    if (messages.length <= 1) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const snack = messages.map((m) => ({
        ...m,
        reasoning: undefined,
        execution: undefined,
        statusLine: undefined,
        planCard: m.planCard
          ? {
              planId: m.planCard.planId,
              summary: m.planCard.summary,
              status: m.planCard.status,
              steps: (m.planCard.steps || []).map((s) => ({
                id: s.id,
                description: s.description,
                tool: s.tool,
                action: s.action,
                enabled: s.enabled,
              })),
            }
          : undefined,
        draftBox: m.draftBox
          ? { content: m.draftBox.content, version: m.draftBox.version, accepted: m.draftBox.accepted }
          : undefined,
        // Keep resumable approvals across reloads, minus transient resolving flag.
        approvalBox: m.approvalBox
          ? { sessionId: m.approvalBox.sessionId, approvals: m.approvalBox.approvals, decided: m.approvalBox.decided }
          : undefined,
        // Cap persisted subagent/usage snapshots; live streams rehydrate the rest.
        subagents: m.subagents?.slice(-24),
        usage: m.usage,
      }));
      try {
        localStorage.setItem(storageKey.current, JSON.stringify(snack));
      } catch (e) {
        console.warn('Failed to persist chat history (quota?)', e);
      }
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [messages]);

  const scrollToBottom = () => {
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const applyNdjsonEvent = (aiMsgId: string, event: any, prompt: string) => {
    if (event.type === 'chunk') {
      setMessages((prev) =>
        prev.map((m) => (m.id === aiMsgId ? { ...m, text: m.text + (event.text || '') } : m))
      );
      return;
    }
    if (event.type === 'warning') {
      const note =
        typeof event.message === 'string' && event.message.trim()
          ? event.message.trim()
          : 'Previous thread context could not be loaded. This reply may lack conversation history.';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                statusLine: note,
                text: m.text ? m.text : `> ⚠️ ${note}\n\n`,
              }
            : m
        )
      );
      return;
    }
    if (event.type === 'tool') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                statusLine: formatToolStatusLine(event.tool, event.label),
                toolEvents: [...(m.toolEvents || []), { tool: event.tool, label: event.label }],
              }
            : m
        )
      );
      return;
    }
    if (event.type === 'done' || event.type === 'simple') {
      if (event.conversationId) {
        conversationIdRef.current = event.conversationId;
        setConversationId(event.conversationId);
        storageKey.current = storageNamespace(
          sessionUserIdRef.current,
          sessionOrgIdRef.current,
          event.conversationId
        );
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', `/ask-ai?c=${event.conversationId}`);
        }
      }
      void fetchConversationsList();
      const routing = parseAskRouting(event.routing);
      const handoffRaw = (event as { handoff?: unknown }).handoff;
      const handoff =
        handoffRaw &&
        typeof handoffRaw === 'object' &&
        typeof (handoffRaw as { toRole?: unknown }).toRole === 'string' &&
        typeof (handoffRaw as { reason?: unknown }).reason === 'string'
          ? {
              toRole: String((handoffRaw as { toRole: string }).toRole),
              reason: String((handoffRaw as { reason: string }).reason),
            }
          : undefined;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                text: event.answer || m.text,
                routing: routing || m.routing,
                handoff: handoff || m.handoff,
                handledBy: event.employeeName
                  ? `${event.employeeName}${event.employeeRole ? ` · ${event.employeeRole}` : ''}`
                  : routing?.employeeNames?.length
                    ? routing.employeeNames.join(', ')
                    : m.handledBy,
                usedTools: event.usedTools || m.usedTools,
                error: event.error || undefined,
                retryable: event.retryable ?? false,
                partialReply: event.partialReply || undefined,
                retryPrompt: event.error ? prompt : undefined,
                statusLine: undefined,
                streamDone: true,
                trajectory: Array.isArray(event.executedSteps) ? event.executedSteps : m.trajectory,
                sessionId: event.sessionId || m.sessionId,
                subagents: Array.isArray((event as any).subagents) && (event as any).subagents.length > 0
                  ? (event as any).subagents
                  : m.subagents,
                usage: (event as any).usage || m.usage,
                // A chained pause can arrive with done: keep resumability.
                approvalBox:
                  m.approvalBox ||
                  (event.sessionId && Array.isArray(event.approvals) && event.approvals.length > 0
                    ? {
                        sessionId: event.sessionId,
                        approvals: event.approvals
                          .filter((a: any) => a && a.threadId && a.toolCallId)
                          .map((a: any) => ({
                            threadId: String(a.threadId),
                            toolCallId: String(a.toolCallId),
                            toolName: String(a.toolName || 'tool'),
                          })),
                      }
                    : undefined),
              }
            : m
        )
      );
      return;
    }
    if (event.type === 'subagent' && event.subagent && event.subagent.threadId) {
      const incoming = event.subagent;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== aiMsgId) return m;
          const list = [...(m.subagents || [])];
          // Pair done/error with its started entry so durations render even if the
          // terminal event arrives without one (defensive: backend pairs too).
          if (incoming.status === 'done' || incoming.status === 'error') {
            const openIdx = [...list]
              .reverse()
              .findIndex((s) => s.threadId === incoming.threadId && s.status === 'started');
            if (openIdx !== -1) {
              const idx = list.length - 1 - openIdx;
              const started = list[idx];
              list[idx] = {
                ...started,
                durationMs: incoming.durationMs ?? started.durationMs,
              };
            }
          }
          const endStatus =
            incoming.status === 'done'
              ? 'done'
              : incoming.status === 'error'
                ? 'error'
                : 'started';
          list.push({
            threadId: String(incoming.threadId),
            title: String(incoming.title || incoming.name || 'subagent'),
            name: String(incoming.name || incoming.title || 'subagent'),
            instruction: String(incoming.instruction || '').slice(0, 2000),
            model: typeof incoming.model === 'string' ? incoming.model : undefined,
            status: endStatus,
            durationMs: typeof incoming.durationMs === 'number' ? incoming.durationMs : undefined,
            createdAt: String(incoming.createdAt || new Date().toISOString()),
            error: typeof incoming.error === 'string' ? incoming.error : undefined,
          });
          return { ...m, subagents: list.slice(-40) };
        })
      );
      return;
    }
    if (event.type === 'approval') {
      if (!event.sessionId || !Array.isArray(event.approvals) || event.approvals.length === 0) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                statusLine: undefined,
                approvalBox: {
                  sessionId: event.sessionId,
                  approvals: event.approvals
                    .filter((a: any) => a && a.threadId && a.toolCallId)
                    .map((a: any) => ({
                      threadId: String(a.threadId),
                      toolCallId: String(a.toolCallId),
                      toolName: String(a.toolName || 'tool'),
                    })),
                },
              }
            : m
        )
      );
      return;
    }
    if (event.type === 'error') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                error: event.error,
                retryable: event.retryable,
                text: (m.text || '') + `\n\n❌ **Error:** ${event.error}`,
                retryPrompt: prompt,
                statusLine: undefined,
                streamDone: true,
              }
            : m
        )
      );
    }
  };

  const resolveApproval = async (
    aiMsgId: string,
    decision: 'allow' | 'deny',
    scope: 'all' | { threadId: string; toolCallId: string },
    reason?: string
  ) => {
    const target = messagesRef.current.find((m) => m.id === aiMsgId)?.approvalBox;
    if (!target || target.resolving) return;
    // TrueForge semantics: deny requires a reason, allow is one click.
    if (decision === 'deny' && !(reason && reason.trim())) return;
    const items = target.approvals.filter((a) =>
      scope === 'all' ? true : a.threadId === scope.threadId && a.toolCallId === scope.toolCallId
    );
    if (items.length === 0) return;
    const cleanReason = decision === 'deny' ? reason!.trim().slice(0, 500) : undefined;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === aiMsgId && m.approvalBox
          ? {
              ...m,
              approvalBox: {
                ...m.approvalBox,
                resolving: true,
                denyFor: null,
                denyReason: '',
                denyError: false,
                decided: {
                  ...(m.approvalBox.decided || {}),
                  ...Object.fromEntries(items.map((a) => [`${a.threadId}:${a.toolCallId}`, decision])),
                },
                decidedReasons: cleanReason
                  ? {
                      ...(m.approvalBox.decidedReasons || {}),
                      ...Object.fromEntries(items.map((a) => [`${a.threadId}:${a.toolCallId}`, cleanReason])),
                    }
                  : m.approvalBox.decidedReasons,
              },
              statusLine: `${decision === 'allow' ? 'Approved — resuming execution' : 'Denied — resuming execution'}…`,
            }
          : m
      )
    );
    try {
      const res = await fetch('/api/ask-ai/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: target.sessionId,
          conversationId: conversationIdRef.current || undefined,
          decisions: items.map((a) => ({
            threadId: a.threadId,
            toolCallId: a.toolCallId,
            decision,
            reason: cleanReason,
          })),
        }),
      });
      if (!res.body || !res.headers.get('content-type')?.includes('application/x-ndjson')) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || 'Approval resume failed');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            applyNdjsonEvent(aiMsgId, JSON.parse(line), '');
          } catch {
            // ignore partial JSON
          }
        }
      }
      if (buffer.trim()) {
        try {
          applyNdjsonEvent(aiMsgId, JSON.parse(buffer), '');
        } catch {
          // ignore partial JSON
        }
      }
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId && m.approvalBox
            ? {
                ...m,
                approvalBox: { ...m.approvalBox, resolving: false },
                statusLine: undefined,
                error: e?.message || 'Approval resume failed',
                retryable: true,
                streamDone: true,
                text: (m.text || '') + `\n\n❌ **Error:** ${e?.message || 'Approval resume failed'}`,
              }
            : m
        )
      );
    }
  };

  const handleStopTurn = () => {
    if (turnAbortControllerRef.current) {
      turnAbortControllerRef.current.abort();
      turnAbortControllerRef.current = null;
    }
    const runningPlanId = messagesRef.current.find((m) => m.execution?.running)?.planCard?.planId;
    if (runningPlanId) {
      void handleStopExecution(runningPlanId);
    } else if (executionAbortControllerRef.current) {
      executionAbortControllerRef.current.abort();
      executionAbortControllerRef.current = null;
    }
    setLoading(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.statusLine || m.execution?.running || m.streamDone === false
          ? {
              ...m,
              statusLine: undefined,
              streamDone: true,
              stopped: true,
              execution: m.execution ? { ...m.execution, running: false } : m.execution,
            }
          : m
      )
    );
  };

  const sendRequest = async (prompt: string, threadId?: string) => {
    setLoading(true);
    stickToBottomRef.current = true;
    const controller = new AbortController();
    turnAbortControllerRef.current = controller;
    let aiMsgId: string | null = null;

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          prompt,
          conversationId: threadId || conversationIdRef.current || undefined,
          mode: askModeRef.current,
          employeeIds: employeeIdsForRequest(askModeRef.current, askEmployeeIdsRef.current),
        }),
      });

      if (res.headers.get('content-type')?.includes('application/x-ndjson')) {
        if (!res.body) {
          throw new Error('Ask AI stream returned no body');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        aiMsgId = `ai_${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: aiMsgId!,
            sender: 'ai',
            text: '',
            provider: 'TrueForge',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            toolEvents: [],
            streamDone: false,
          },
        ]);

        const consumeLine = (line: string) => {
          if (!line.trim()) return;
          try {
            applyNdjsonEvent(aiMsgId!, JSON.parse(line), prompt);
          } catch {
            // ignore partial JSON
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            consumeLine(line);
          }
        }
        if (buffer.trim()) consumeLine(buffer);
        return;
      }

      const data = await res.json();

      // ── COMPLEX: plan-confirm-execute proposal ──────────────────────────
      if (res.ok && data.conversationId) {
        conversationIdRef.current = data.conversationId;
        setConversationId(data.conversationId);
        storageKey.current = storageNamespace(
          sessionUserIdRef.current,
          sessionOrgIdRef.current,
          data.conversationId
        );
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', `/ask-ai?c=${data.conversationId}`);
        }
        void fetchConversationsList();
      }

      if (res.ok && data.type === 'complex' && data.planId) {
        const planMsgId = `ai_plan_${Date.now()}`;
        const routing = parseAskRouting(data.routing);
        const planMessage: Message = {
          id: planMsgId,
          sender: 'ai',
          text: '',
          provider: data.provider || 'TrueForge',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          type: 'complex',
          routing,
          handledBy: data.employeeName
            ? `${data.employeeName}${data.employeeRole ? ` · ${data.employeeRole}` : ''}`
            : routing?.employeeNames?.length
              ? routing.employeeNames.join(', ')
              : undefined,
          reasoning: { text: data.reasoning || '', durationMs: null },
          planCard: {
            planId: data.planId,
            summary: data.summary || '',
            steps: Array.isArray(data.steps) ? data.steps : [],
            status: 'pending',
          },
          draftBox: data.draft
            ? { content: data.draft, version: 1 }
            : undefined,
        };
        setMessages((prev) => [...prev, planMessage]);
        return;
      }

      if (res.ok && data.answer) {
        const routing = parseAskRouting(data.routing);
        const aiMessage: Message = {
          id: `ai_${Date.now()}`,
          sender: 'ai',
          text: data.answer,
          provider: data.provider || 'TrueForge',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          routing,
          handledBy: data.employeeName
            ? `${data.employeeName}${data.employeeRole ? ` · ${data.employeeRole}` : ''}`
            : routing?.employeeNames?.length
              ? routing.employeeNames.join(', ')
              : undefined,
          suggestedActions: data.suggestedActions,
          proposedAction: data.proposedAction,
          error: data.error || undefined,
          retryable: data.retryable ?? false,
          partialReply: data.partialReply || undefined,
          retryPrompt: data.error ? prompt : undefined,
          streamDone: true,
        };
        setMessages((prev) => [...prev, aiMessage]);
      } else if (data.error) {
        const errorText = data.retryable
          ? `❌ **I hit a snag while processing your request — and I may have gotten started before failing.**\n\n${data.error}\n\nUse **Retry** below to run it again.`
          : `❌ **I couldn\u2019t process your request.**\n\n${data.error}`;
        const errMessage: Message = {
          id: `ai_err_${Date.now()}`,
          sender: 'ai',
          text: errorText,
          provider: 'TrueForge',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: data.error,
          retryable: Boolean(data.retryable),
          retryPrompt: data.retryable ? prompt : undefined,
          streamDone: true,
        };
        setMessages((prev) => [...prev, errMessage]);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Stopped by user — handleStopTurn already settled the message.
        return;
      }
      console.error('Ask AI error:', err);
      const errMessage: Message = {
        id: `ai_err_${Date.now()}`,
        sender: 'ai',
        text: '❌ **Connection error.** Could not reach the Ask AI backend. Please confirm the worker is running, then try again.',
        provider: 'TrueForge',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        error: 'Connection error',
        retryable: true,
        retryPrompt: prompt,
        streamDone: true,
      };
      setMessages((prev) => [...prev, errMessage]);
    } finally {
      turnAbortControllerRef.current = null;
      setLoading(false);
      // Stream ended without done/error (or race) must not leave the composer
      // disabled forever via streamDone === false.
      if (aiMsgId) {
        const openId = aiMsgId;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== openId || m.streamDone !== false) return m;
            const dropped = !m.text && !m.error;
            return {
              ...m,
              streamDone: true,
              statusLine: undefined,
              error: m.error || (dropped ? 'Stream ended unexpectedly' : undefined),
              retryable: m.retryable ?? dropped,
              retryPrompt: m.retryPrompt || (dropped ? prompt : undefined),
              text: m.text || (dropped
                ? '❌ **Stream ended unexpectedly.** Use Retry to try again.'
                : m.text),
            };
          })
        );
      }
    }
  };

  const applyMentionChrome = (value: string) => {
    const parsed = parseEmployeeMentions(value, roster);
    setLockedName(parsed.locked?.name || null);
    const at = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(value);
    if (at) {
      setMentionOpen(true);
      setMentionQuery(at[1].toLowerCase());
    } else {
      setMentionOpen(false);
      setMentionQuery('');
    }
  };

  const mentionMatches = roster.filter(
    (e) =>
      (e.status || 'active') !== 'paused' &&
      e.name.toLowerCase().startsWith(mentionQuery)
  );

  const insertMention = (name: string) => {
    const next = inputPrompt.replace(/(?:^|\s)@[A-Za-z0-9._-]*$/, (chunk) =>
      chunk.startsWith(' ') ? ` @${name} ` : `@${name} `
    );
    setInputPrompt(next);
    setMentionOpen(false);
    setLockedName(name);
  };

  const askModeNeedsEmployee =
    (askMode === 'single' && askEmployeeIds.length < 1) ||
    (askMode === 'team' && askEmployeeIds.length < 1);

  const handleSendMessage = async (textToSend?: string) => {
    if (askModeNeedsEmployee) {
      setModePickerRequestMode(askMode);
      setModePickerRequestOpen(true);
      return;
    }
    const prompt = textToSend || inputPrompt;
    if (!prompt.trim() || loading) return;
    parseEmployeeMentions(prompt, roster);

    const userMsgId = `user_${Date.now()}`;
    const userMessage: Message = {
      id: userMsgId,
      sender: 'user',
      text: prompt,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) =>
      prev.map((m) =>
        m.approvalBox && !m.approvalBox.resolving
          ? {
              ...m,
              approvalBox: {
                ...m.approvalBox,
                decided: {
                  ...(m.approvalBox.decided || {}),
                  ...Object.fromEntries(
                    m.approvalBox.approvals
                      .filter((a) => !m.approvalBox?.decided?.[`${a.threadId}:${a.toolCallId}`])
                      .map((a) => [`${a.threadId}:${a.toolCallId}`, 'deny' as const])
                  ),
                },
                decidedReasons: {
                  ...(m.approvalBox.decidedReasons || {}),
                  ...Object.fromEntries(
                    m.approvalBox.approvals
                      .filter((a) => !m.approvalBox?.decided?.[`${a.threadId}:${a.toolCallId}`])
                      .map((a) => [`${a.threadId}:${a.toolCallId}`, 'Superseded by user message'])
                  ),
                },
              },
            }
          : m
      ).concat([userMessage])
    );
    setConversationsList((prev) => {
      const activeId = conversationIdRef.current || conversationId;
      const exists = prev.find((c) => c.id === activeId);
      if (exists) {
        return prev.map((c) =>
          c.id === activeId && (c.summary === 'New Chat' || c.summary === 'Ask AI' || !c.summary)
            ? { ...c, summary: prompt.slice(0, 100).trim(), updated_at: new Date().toISOString() }
            : c
        );
      }
      return [
        {
          id: activeId || `conv_${Date.now()}`,
          summary: prompt.slice(0, 100).trim(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          message_count: 1,
        },
        ...prev,
      ];
    });

    setInputPrompt('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setMentionOpen(false);
    setLockedName(null);
    await sendRequest(prompt);
  };

  const handleRetry = (prompt: string) => {
    if (!prompt || loading) return;
    sendRequest(prompt);
  };

  const patchMessage = (msgId: string, patch: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, ...patch } : m)));
  };

  // ── Plan lifecycle: approve → run SSE → stream step completion ─────────
  const handleApprovePlan = async (planId: string) => {
    try {
      const existingStatus = messagesRef.current.find((m) => m.planCard?.planId === planId)?.planCard?.status;
      if (existingStatus === 'pending') {
        const res = await fetch('/api/ask-ai/plan', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, action: 'approve' }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const msgId = messagesRef.current.find((m) => m.planCard?.planId === planId)?.id;
          if (msgId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, error: errBody.error || 'Failed to approve plan', retryable: false } : m
              )
            );
          }
          return;
        }
      }

      const msgId = messagesRef.current.find((m) => m.planCard?.planId === planId)?.id;
      if (!msgId) return;

      const latest = messagesRef.current.find((m) => m.id === msgId);
      const stepIds = (latest?.planCard?.steps || []).map((s) => ({
        id: s.id || `step-${s.description}`,
        description: s.description,
      }));

      const setPlanMsg = (updater: (cur: Message) => Message) => {
        setMessages((prev) => prev.map((m) => (m.id === msgId ? updater(m) : m)));
      };

      let statuses: StepRunStatus[] = stepIds.map(() => ({ status: 'pending' as const }));
      setPlanMsg((cur) => ({
        ...cur,
        planCard: cur.planCard ? { ...cur.planCard, status: 'running' } : cur.planCard,
        execution: { running: true, statuses },
        error: undefined,
      }));

      const controller = new AbortController();
      executionAbortControllerRef.current = controller;

      const streamRes = await fetch(`/api/ask-ai/execute?planId=${encodeURIComponent(planId)}`, {
        signal: controller.signal,
      });
      if (!streamRes.ok || !streamRes.body) {
        const failMsg = streamRes.status === 409
          ? 'This plan was already executed.'
          : 'Failed to open execution stream';
        statuses = stepIds.map(() => ({ status: 'error' as const, message: failMsg }));
        setPlanMsg((cur) => ({
          ...cur,
          planCard: cur.planCard ? { ...cur.planCard, status: 'approved' } : cur.planCard,
          execution: { running: false, statuses },
          error: failMsg,
          retryable: streamRes.status !== 409,
          retryPrompt: undefined,
        }));
        return;
      }

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawExecutionDone = false;

      const updateSteps = (index: number, status: StepRunStatus) => {
        if (!statuses[index]) statuses[index] = status;
        else statuses[index] = { ...statuses[index], ...status };
        setPlanMsg((cur) => ({ ...cur, execution: { running: true, statuses: [...statuses] } }));
      };

      const consumeSseChunk = (chunk: string) => {
        let eventType: string | null = null;
        let dataLine = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine || !eventType) return;
        let evt: any;
        try {
          evt = JSON.parse(dataLine);
        } catch {
          return;
        }

        if (eventType === 'step_start' && typeof evt.stepIndex === 'number') {
          updateSteps(evt.stepIndex, { status: 'running' });
        } else if (eventType === 'step_done' && typeof evt.stepIndex === 'number') {
          const notConnected = evt.data && evt.data.connected === false;
          updateSteps(evt.stepIndex, {
            status: evt.status === 'error' ? 'error' : evt.status === 'skipped' ? 'skipped' : 'done',
            message: evt.message,
            setupUrl: notConnected ? evt.data.setupUrl || '/connectors' : undefined,
          });
        } else if (eventType === 'step_error' && typeof evt.stepIndex === 'number') {
          updateSteps(evt.stepIndex, { status: 'error', message: evt.message });
        } else if (eventType === 'execution_done') {
          sawExecutionDone = true;
          const nextStatus =
            evt.status === 'completed_with_errors'
              ? 'completed_with_errors'
              : evt.status === 'completed'
                ? 'completed'
                : 'cancelled';
          setPlanMsg((cur) => ({
            ...cur,
            planCard: cur.planCard ? { ...cur.planCard, status: nextStatus } : cur.planCard,
            execution: { running: false, statuses: [...statuses] },
          }));
        } else if (eventType === 'execution_error') {
          const failedIdx = statuses.findIndex((s) => s.status === 'running');
          if (failedIdx >= 0) statuses[failedIdx] = { status: 'error', message: evt.message };
          setPlanMsg((cur) => ({
            ...cur,
            planCard: cur.planCard ? { ...cur.planCard, status: 'completed_with_errors' } : cur.planCard,
            execution: { running: false, statuses: [...statuses] },
            error: evt.message,
            retryable: true,
          }));
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
        setPlanMsg((cur) => ({
          ...cur,
          planCard: cur.planCard
            ? { ...cur.planCard, status: cur.planCard.status === 'running' ? 'completed_with_errors' : cur.planCard.status }
            : cur.planCard,
          execution: { running: false, statuses: [...statuses] },
          error: cur.planCard?.status === 'running' ? 'Execution stream ended unexpectedly' : cur.error,
          retryable: true,
        }));
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Cancelled by user via Stop Execution
        return;
      }
      console.error('Plan execution error:', err);
      const msgId = messagesRef.current.find((m) => m.planCard?.planId === planId)?.id;
      if (msgId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  planCard: m.planCard ? { ...m.planCard, status: 'approved' } : m.planCard,
                  execution: { running: false, statuses: m.execution?.statuses || [] },
                  error: 'Connection error during plan execution',
                  retryable: true,
                }
              : m
          )
        );
      }
    } finally {
      executionAbortControllerRef.current = null;
    }
  };

  const handleStopExecution = async (planId: string) => {
    if (executionAbortControllerRef.current) {
      executionAbortControllerRef.current.abort();
      executionAbortControllerRef.current = null;
    }
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action: 'cancel' }),
      });
    } catch (e) {
      console.error('Failed to cancel plan:', e);
    }
    const msgId = messagesRef.current.find((m) => m.planCard?.planId === planId)?.id;
    if (msgId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                planCard: m.planCard ? { ...m.planCard, status: 'cancelled' } : m.planCard,
                execution: {
                  running: false,
                  statuses: (m.execution?.statuses || []).map((s) =>
                    s.status === 'running'
                      ? { status: 'skipped', message: 'Execution stopped by user' }
                      : s.status === 'pending'
                      ? { status: 'skipped' }
                      : s
                  ),
                },
                error: 'Execution stopped by user',
              }
            : m
        )
      );
    }
  };

  const handleCancelPlan = async (planId: string) => {
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action: 'cancel' }),
      });
    } catch (e) { console.error('plan cancel failed, server state may not match UI:', planId, e); }
    const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
    if (msgId) {
      const cur = messages.find((m) => m.id === msgId)!;
      patchMessage(msgId, { planCard: { ...cur.planCard!, status: 'cancelled' } });
    }
  };

  const handleToggleStep = async (planId: string, index: number, enabled: boolean) => {
    const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
    if (!msgId) return;
    const cur = messages.find((m) => m.id === msgId)!;
    const steps = (cur.planCard?.steps || []).map((s, i) => (i === index ? { ...s, enabled } : s));
    patchMessage(msgId, { planCard: { ...cur.planCard!, steps } });
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          steps: steps.map((s) => ({
            id: s.id,
            description: s.description,
            enabled: s.enabled,
            payload: s.payload || {},
          })),
        }),
      });
    } catch (e) { console.error('step toggle sync failed, server state may not match UI:', planId, e); }
  };

  const handleUpdateStepPayload = async (
    planId: string,
    index: number,
    payload: Record<string, unknown>
  ) => {
    const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
    if (!msgId) return;
    const cur = messages.find((m) => m.id === msgId)!;
    const steps = (cur.planCard?.steps || []).map((s, i) => (i === index ? { ...s, payload } : s));
    patchMessage(msgId, { planCard: { ...cur.planCard!, steps } });
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          steps: steps.map((s) => ({
            id: s.id,
            description: s.description,
            enabled: s.enabled,
            payload: s.payload || {},
          })),
        }),
      });
    } catch (e) {
      console.error('step payload sync failed, server state may not match UI:', planId, e);
    }
  };

  const handleAddInstruction = async (planId: string, instruction: string) => {
    const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
    if (!msgId) return;
    const cur = messages.find((m) => m.id === msgId)!;
    const newStep: PlanStep = {
      id: `step-${Date.now()}`,
      description: instruction,
      tool: 'user_instruction',
      action: 'note',
      enabled: true,
    };
    const steps = [...(cur.planCard?.steps || []), newStep];
    patchMessage(msgId, { planCard: { ...cur.planCard!, steps } });
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          steps: steps.map((s) => ({ id: s.id, description: s.description, tool: s.tool, action: s.action, enabled: s.enabled })),
        }),
      });
    } catch (e) { console.error('add instruction sync failed, server state may not match UI:', planId, e); }
  };

  const handleDraftRevised = (msgId: string, draft: DraftState, newStatus?: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        const updatedPlan = m.planCard
          ? {
              ...m.planCard,
              status: (newStatus || m.planCard.status || 'pending') as any,
            }
          : undefined;
        return {
          ...m,
          draftBox: draft,
          planCard: updatedPlan,
          execution: newStatus === 'pending' ? undefined : m.execution,
        };
      })
    );
  };

  const handleVote = async (msg: Message, vote: 'up' | 'down') => {
    patchMessage(msg.id, { vote });
    try {
      await fetch('/api/ask-ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'vote',
          vote,
          messageId: msg.id,
          conversationId: conversationId || undefined,
          planId: msg.planCard?.planId,
        }),
      });
    } catch (err) {
      console.error('Ask AI feedback vote failed', err);
    }
  };

  const handleExecuteToolAction = async (_tool: string, _action: string, label: string) => {
    const suggestion = DEFAULT_SUGGESTIONS.find((s) => s.label === label);
    await handleSendMessage(suggestion?.prompt || label);
  };

  const handleToolExecutionComplete = (result: any) => {
    let title = '⚡ **Action Approved & Executed!**';
    if (result.status === 'simulated' || result.status === 'not_connected') {
      title = '⚠️ **Action Not Connected / Simulated**';
    } else if (result.status === 'error') {
      title = '❌ **Action Execution Failed**';
    }

    let formattedText = `${title}\n\n- **Tool:** \`${result.tool}\`\n- **Action:** \`${result.action}\`\n- **Status:** \`${result.status}\`\n- **Details:** ${result.message}\n\n`;

    let followUpAction: ProposedActionData | undefined = undefined;

    if (result.tool === 'gmail' && result.action === 'fetch_latest_emails' && Array.isArray(result.data?.emails) && result.data.emails.length > 0) {
      const emails: any[] = result.data.emails;
      formattedText += `### 📬 Executive Inbox Summary (${emails.length} Synced Emails):\n\n`;
      emails.forEach((em: any, i: number) => {
        formattedText += `**${i + 1}. ${em.subject}**\n- **From:** \`${em.from}\`\n- **Date:** ${em.date}\n- **Preview:** *${em.snippet}*\n\n`;
      });

      // Propose follow-up action to dispatch email summary
      followUpAction = {
        tool: 'gmail',
        action: 'send_email',
        params: {
          recipient: currentUserEmail,
          subject: `Executive Digest: ${emails.length} Latest Inbox Emails`,
          body: `Here is your requested digest of ${emails.length} latest emails.\n\n` + emails.map((e, idx) => `${idx + 1}. [${e.from}] ${e.subject}`).join('\n'),
        },
        explanation: `Dispatch this ${emails.length}-email executive digest to ${currentUserEmail}`,
      };
    } else {
      formattedText += `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;
    }

    const resultMsg: Message = {
      id: `tool_res_${Date.now()}`,
      sender: 'ai',
      text: formattedText,
      provider: 'TrueForge',
      timestamp: 'Just now',
      proposedAction: followUpAction,
    };
    setMessages((prev) => [...prev, resultMsg]);
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="relative flex h-[calc(100vh-8.5rem)] md:h-[calc(100vh-6rem)] w-full overflow-hidden">
      <LiveRegion
        message={
          loading
            ? 'Ask AI is responding'
            : messages.find((m) => m.statusLine)?.statusLine || ''
        }
      />

      {/* Side Tab / History Drawer */}
      <AskAiHistoryDrawer
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        conversations={conversationsList}
        currentConversationId={conversationId}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleNewChat}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
        loading={loadingConversations}
        switchingId={switchingConversationId}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 max-w-5xl mx-auto h-full px-1.5 sm:px-4 space-y-3 sm:space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-cream-300 pb-3 shrink-0 gap-2">
          <div className="flex items-center space-x-2 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className={`p-2 rounded-xl border transition-all flex items-center gap-1.5 text-xs font-semibold ${
                sidebarOpen
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-900 shadow-xs'
                  : 'bg-white border-cream-300 hover:bg-cream-100 text-slate-700 hover:text-heading shadow-xs'
              }`}
              title={sidebarOpen ? 'Close chat history' : 'Open chat history'}
              aria-label="Toggle chat history side tab"
            >
              <PanelLeft className="w-4 h-4 text-amber-600" />
              <span className="hidden sm:inline">History</span>
              {conversationsList.length > 0 && (
                <span className="px-1.5 py-0.2 bg-cream-200 text-[10px] text-slate-600 font-mono rounded-full">
                  {conversationsList.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleNewChat}
              className="p-2 sm:px-3 sm:py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-heading font-semibold text-xs transition-all flex items-center gap-1.5 shadow-sm shrink-0"
              title="Start a new chat"
              aria-label="New Chat"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Chat</span>
            </button>

            <div className="h-6 w-px bg-cream-300 hidden sm:block mx-1" />

            <div className="w-9 h-9 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
              <Brain className="w-4.5 h-4.5 text-amber-600 animate-pulse" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-serif font-bold text-heading truncate">Ask AI Intelligence</h1>
              <p className="text-[11px] text-slate-500 truncate">
                {orgName}
                {connectedChannels.length > 0
                  ? ` · connected: ${connectedChannels.join(', ')}`
                  : ' · no OAuth connectors yet'}
              </p>
            </div>
          </div>
        </div>

        {conversationActionError && (
          <div
            role="alert"
            className="shrink-0 px-3 py-2 bg-amber-50 border border-amber-500/30 rounded-xl text-[11px] text-amber-900 flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span className="truncate">{conversationActionError}</span>
            </span>
            <button
              type="button"
              onClick={() => setConversationActionError(null)}
              className="shrink-0 text-[10px] font-semibold text-amber-800 hover:text-amber-950"
            >
              Dismiss
            </button>
          </div>
        )}

      {/* Chat Messages Feed */}
      <div
        ref={messagesScrollRef}
        className="flex-1 overflow-y-auto space-y-5 sm:space-y-6 px-0.5 sm:pr-2 overscroll-contain"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
      >
        {messages.map((msg, idx) => {
          const isUser = msg.sender === 'user';
          const shownAnswer = isUser ? msg.text : visibleAnswer(msg.text, msg.trajectory);
          return (
            <div key={msg.id} className={`flex items-start space-x-3 ${isUser ? 'flex-row-reverse space-x-reverse' : ''}`}>
              {/* Avatar */}
              <div
                className={`w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 border ${
                  isUser
                    ? 'bg-heading text-cream-100 border-slate-700'
                    : 'bg-amber-500 text-heading border-amber-600 shadow-sm'
                }`}
              >
                {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              {/* Bubble Body */}
              <div className={`flex flex-col space-y-2 max-w-3xl ${isUser ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-center space-x-2 px-1.5 ${isUser ? 'flex-row-reverse space-x-reverse' : ''}`}>
                  <span className="text-xs font-bold text-slate-700">{isUser ? 'You' : 'DareX AI Intelligence'}</span>
                  {msg.provider && !/trueforge/i.test(msg.provider) && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-cream-200 text-slate-600">
                      {msg.provider}
                    </span>
                  )}
                  <span suppressHydrationWarning className="text-[10px] text-slate-400 font-mono">{msg.timestamp}</span>
                </div>

                {/* ── Claude-style layout: Reasoning & Plan/Draft appear at the TOP of the response ── */}
                {!isUser && (msg.routing || msg.handledBy) ? (
                  <AskRoutingChip
                    routing={msg.routing}
                    handledBy={msg.handledBy}
                    onPickSomeone={() => {
                      setModePickerRequestMode('single');
                      setModePickerRequestOpen(true);
                    }}
                  />
                ) : null}
                {!isUser && msg.handoff ? (
                  <HandoffOfferControl
                    toRole={msg.handoff.toRole}
                    reason={msg.handoff.reason}
                    employees={askEmployees}
                    onHandTo={(employeeId) => {
                      setAskMode('single');
                      askModeRef.current = 'single';
                      setAskEmployeeIds([employeeId]);
                      askEmployeeIdsRef.current = [employeeId];
                    }}
                  />
                ) : null}
                {!isUser && msg.type === 'complex' && msg.planCard && (
                  <>
                    {msg.reasoning && (
                      <ReasoningStrip text={msg.reasoning.text} durationMs={msg.reasoning.durationMs} />
                    )}

                    {msg.execution ? (
                      <ExecutionStrip
                        steps={msg.planCard.steps.map((s) => ({ id: s.id, description: s.description }))}
                        statuses={msg.execution.statuses}
                        running={msg.execution.running}
                        onStop={() => handleStopExecution(msg.planCard?.planId || '')}
                      />
                    ) : (
                      (msg.planCard.status === 'pending' || msg.planCard.status === 'approved') && (
                        <PlanCard
                          planId={msg.planCard.planId}
                          summary={msg.planCard.summary}
                          steps={msg.planCard.steps}
                          disabled={msg.planCard.status === 'approved'}
                          status={msg.planCard.status}
                          onApprove={handleApprovePlan}
                          onCancel={handleCancelPlan}
                          onToggleStep={handleToggleStep}
                          onAddInstruction={handleAddInstruction}
                          onUpdateStepPayload={handleUpdateStepPayload}
                        />
                      )
                    )}

                    {msg.draftBox && (
                      <DraftPanel
                        draft={msg.draftBox}
                        planId={msg.planCard.planId}
                        editable={!msg.execution?.running}
                        onRevised={(d, s) => handleDraftRevised(msg.id, d, s)}
                      />
                    )}
                  </>
                )}

                {!isUser && msg.draftBox && !msg.planCard && (
                  <DraftPanel
                    draft={msg.draftBox}
                    planId=""
                    editable={false}
                  />
                )}

                {/* Text Response Bubble */}
                {!isUser && msg.statusLine && (
                  <div className="px-3.5 py-2 rounded-xl text-[11px] font-medium text-amber-900 bg-amber-50/90 border border-amber-200/80 shadow-xs flex items-center gap-2.5 my-1.5 w-fit max-w-full">
                    <RefreshCw className="w-3 h-3 text-amber-600 animate-spin shrink-0" />
                    <span className="truncate">{msg.statusLine}</span>
                  </div>
                )}
                {!isUser && msg.stopped && (
                  <div className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-slate-600 bg-cream-100 border border-cream-300 flex items-center gap-1.5 w-fit">
                    <Square className="w-3 h-3 text-slate-500 fill-slate-500" />
                    Stopped
                  </div>
                )}
                {!isUser && ((msg.trajectory && msg.trajectory.length > 0) || (msg.toolEvents && msg.toolEvents.length > 0) || (msg.approvalBox && msg.approvalBox.approvals.length > 0)) && (
                  <AgentTrajectory
                    data={buildTrajectory({
                      executedSteps: msg.trajectory,
                      toolEvents: msg.toolEvents,
                      done: msg.streamDone ?? !loading,
                      error: msg.error,
                      approvals: msg.approvalBox?.approvals,
                      sessionId: msg.approvalBox?.sessionId || msg.sessionId,
                      decided: msg.approvalBox?.decided,
                      decidedReasons: msg.approvalBox?.decidedReasons,
                      resolving: msg.approvalBox?.resolving,
                      subagents: msg.subagents,
                      usage: msg.usage,
                    })}
                    onAllow={(a) => resolveApproval(msg.id, 'allow', { threadId: a.threadId, toolCallId: a.toolCallId })}
                    onDeny={(a, reason) => resolveApproval(msg.id, 'deny', { threadId: a.threadId, toolCallId: a.toolCallId }, reason)}
                    onStop={handleStopTurn}
                  />
                )}
                <div
                  className={`p-4 sm:p-5 rounded-2xl text-[13px] sm:text-sm leading-relaxed border shadow-sm ${
                    isUser
                      ? 'bg-amber-500 text-heading border-amber-600 font-medium rounded-tr-sm'
                      : msg.error
                        ? 'bg-white text-slate-800 border-rose-200 rounded-tl-sm'
                        : msg.stopped && !msg.text
                          ? 'bg-cream-50 text-slate-600 border-cream-300 rounded-tl-sm'
                          : 'bg-white text-slate-800 border-cream-300 rounded-tl-sm'
                  } ${!isUser && !msg.text && !(loading && !msg.streamDone && idx === messages.length - 1) && !msg.stopped ? 'hidden' : ''}`}
                >
                  {isUser ? (
                    msg.text
                  ) : !msg.text && loading && !msg.streamDone && idx === messages.length - 1 ? (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="inline-flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse [animation-delay:120ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse [animation-delay:240ms]" />
                      </span>
                      <span>Thinking…</span>
                    </div>
                  ) : msg.stopped && !msg.text ? (
                    <p className="text-xs text-slate-500">Turn stopped before a reply was written.</p>
                  ) : (
                    <FormattedMarkdownResponse
                      content={shownAnswer}
                      isStreaming={!msg.streamDone && loading && idx === messages.length - 1}
                    />
                  )}
                </div>
                {!isUser && shownAnswer && <CitationChips text={shownAnswer} />}
                {!isUser && (shownAnswer || msg.usedTools?.length) && (
                  <div className="flex items-center flex-wrap gap-2 px-1">
                    {msg.usedTools && msg.usedTools.length > 0 && !(msg.trajectory && msg.trajectory.length > 0) && (
                      <div className="flex flex-wrap gap-1">
                        {Array.from(new Set(msg.usedTools)).map((tool) => (
                          <span
                            key={tool}
                            className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200"
                          >
                            {humanToolName(tool)}
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <button
                        type="button"
                        onClick={() => handleCopyText(msg.id, visibleAnswer(msg.text, msg.trajectory))}
                        className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 flex items-center gap-1"
                      >
                        {copiedId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedId === msg.id ? 'Copied' : 'Copy'}
                      </button>
                    )}
                    {shownAnswer && msg.id !== 'welcome' && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleVote(msg, 'up')}
                          className={`p-1 rounded-md ${msg.vote === 'up' ? 'text-emerald-600 bg-emerald-50' : 'text-slate-400 hover:text-slate-700'}`}
                          title="Helpful — stored as a vote, not used to train on another tenant"
                        >
                          <ThumbsUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleVote(msg, 'down')}
                          className={`p-1 rounded-md ${msg.vote === 'down' ? 'text-red-600 bg-red-50' : 'text-slate-400 hover:text-slate-700'}`}
                          title="Not helpful — stored as a vote, not used to train on another tenant"
                        >
                          <ThumbsDown className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Failure Banner + Retry */}
                {!isUser && msg.error && (
                  <div className="px-3 py-2 bg-amber-50 border border-amber-500/30 rounded-xl text-[11px] text-amber-900 flex items-center justify-between gap-2">
                    <span className="flex items-center space-x-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      <span>
                        {msg.retryable
                          ? '⚠️ Processing did not fully complete.'
                          : '⚠️ Processing failed.'}
                        {msg.partialReply ? ' A partial answer may be shown above.' : ''}
                      </span>
                    </span>
                    {msg.retryable && (msg.retryPrompt || msg.planCard?.planId) && (
                      <button
                        onClick={() =>
                          msg.retryPrompt
                            ? handleRetry(msg.retryPrompt!)
                            : handleApprovePlan(msg.planCard!.planId)
                        }
                        disabled={loading}
                        className="shrink-0 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-heading font-bold rounded-lg transition-all disabled:opacity-40"
                      >
                        {loading ? 'Running…' : msg.retryPrompt ? 'Retry' : 'Retry execution'}
                      </button>
                    )}
                  </div>
                )}

                {/* Proposed Action Permission Card */}
                {!isUser && msg.proposedAction && (
                  <ActionPermissionCard
                    actionData={msg.proposedAction}
                    onExecutionComplete={handleToolExecutionComplete}
                  />
                )}

                {/* Suggested Action Buttons if AI */}
                {!isUser && msg.suggestedActions && msg.suggestedActions.length > 0 && (
                  <div className="pt-2 flex flex-wrap gap-2">
                    {msg.suggestedActions.map((act, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleExecuteToolAction(act.tool, act.action, act.label)}
                        disabled={executingTool === act.label}
                        className="px-3 py-1.5 bg-cream-100 hover:bg-amber-500/10 border border-cream-300 hover:border-amber-500/40 text-slate-700 font-semibold text-[11px] rounded-xl flex items-center space-x-1.5 transition-all disabled:opacity-50"
                      >
                        {executingTool === act.label ? (
                          <RefreshCw className="w-3 h-3 text-amber-600 animate-spin" />
                        ) : (
                          <Zap className="w-3 h-3 text-amber-600" />
                        )}
                        <span>{act.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {loading &&
          !messages.some((m) => m.sender === 'ai' && (m.statusLine || m.streamDone === false || (!m.text && m.id !== 'welcome' && !m.planCard))) && (
          <div className="flex items-start space-x-3">
            <div className="w-9 h-9 rounded-2xl bg-amber-500 text-heading flex items-center justify-center border border-amber-600">
              <Bot className="w-4 h-4 animate-bounce" />
            </div>
            <div className="bg-white border border-cream-300 px-4 py-3 rounded-2xl text-xs text-slate-600 flex items-center gap-2.5 shadow-sm">
              <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />
              <span>Working on your request…</span>
            </div>
          </div>
        )}

        {messages.length <= 1 && !loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pb-3">
            {DEFAULT_SUGGESTIONS.filter(
              (s) => !s.requires || s.requires.some((tool) => connectedChannels.includes(tool))
            ).map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => handleSendMessage(s.prompt)}
                className="text-left px-3.5 py-3 bg-white hover:bg-amber-50/70 border border-cream-300 hover:border-amber-400/60 text-slate-700 rounded-2xl transition-all shadow-xs"
              >
                <span className="block text-[12px] font-semibold text-heading leading-snug">{s.label.replace(/^[^\w]+/, '')}</span>
                <span className="mt-1 block text-[11px] text-slate-500 line-clamp-2 leading-snug">{s.prompt}</span>
              </button>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Prompt Input */}
      {(() => {
        const hasPendingPlanOrDraft = messages.some(
          (m) =>
            m.planCard?.status === 'pending' ||
            m.planCard?.status === 'approved' ||
            (m.draftBox && !m.draftBox.accepted)
        );
        const hasPendingApproval = messages.some(
          (m) =>
            m.approvalBox &&
            m.approvalBox.approvals.some((a) => !m.approvalBox?.decided?.[`${a.threadId}:${a.toolCallId}`])
        );
        const requestInFlight = loading || messages.some((m) => m.execution?.running || m.streamDone === false);
        return (
          <div className="relative shrink-0 pb-2 pt-1 space-y-2 border-t border-cream-200/80">
            {hasPendingApproval && (
              <div className="flex items-center justify-between px-3.5 py-2 bg-amber-50 border border-amber-400/40 rounded-xl text-xs text-amber-900 shadow-sm">
                <span className="flex items-center gap-2 font-medium">
                  <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
                  Tool execution waiting for approval above. Click <strong>Approve</strong> or <strong>Deny</strong>, or type a new prompt to continue.
                </span>
              </div>
            )}
            {lockedName ? (
              <StatusBadge label={`@${lockedName} overrides mode for this message · org-union tools`} tone="info" />
            ) : (
              <AskModeLockStrip
                mode={askMode}
                employeeIds={askEmployeeIds}
                employees={askEmployees}
                onClear={resetAskModeToAuto}
              />
            )}
            {!lockedName && askMode === 'auto' ? (
              <p className="text-[11px] text-slate-400 px-1">
                Auto routes each message. Type @name for one turn, or pick Pick one / Team.
              </p>
            ) : null}
            {mentionOpen && mentionMatches.length > 0 ? (
              <ul
                role="listbox"
                aria-label="Mention employee"
                className="absolute bottom-full mb-2 left-0 right-0 bg-white border border-cream-300 rounded-2xl shadow-lg max-h-40 overflow-y-auto z-20"
              >
                {mentionMatches.map((emp) => (
                  <li key={emp.id || emp.name}>
                    <button
                      type="button"
                      onClick={() => insertMention(emp.name)}
                      className="w-full text-left px-4 py-2 text-xs font-medium text-heading hover:bg-cream-100 focus:outline-none focus-visible:bg-amber-50"
                    >
                      <span className="font-semibold">@{emp.name}</span>
                      {emp.role ? <span className="block text-[10px] text-slate-500 font-normal">{emp.role}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="relative flex items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                placeholder={
                  hasPendingApproval
                    ? 'Action requires approval above — click Approve or Deny, or send a new instruction...'
                    : hasPendingPlanOrDraft
                    ? 'Approve the plan above to continue, or ask something else...'
                    : 'Ask AI… @Customer @Sarah @Finance — or describe the job and the roster routes it'
                }
                value={inputPrompt}
                onChange={(e) => {
                  setInputPrompt(e.target.value);
                  applyMentionChrome(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                    if (inputRef.current) {
                      inputRef.current.style.height = 'auto';
                    }
                  }
                }}
                disabled={requestInFlight}
                aria-label="Ask AI prompt"
                className={`flex-1 min-w-0 pl-4 sm:pl-5 pr-3 py-3.5 rounded-2xl text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shadow-sm disabled:opacity-50 transition-all resize-none max-h-44 overflow-y-auto leading-relaxed ${
                  hasPendingPlanOrDraft
                    ? 'bg-cream-100/80 border border-amber-500/40 text-heading placeholder-amber-900/60 font-semibold'
                    : 'bg-white border border-cream-300 text-heading focus:border-amber-500'
                }`}
              />
              <EmployeeModeSelector
                mode={askMode}
                employeeIds={askEmployeeIds}
                employees={askEmployees}
                disabled={requestInFlight}
                requestOpen={modePickerRequestOpen}
                requestMode={modePickerRequestMode}
                onRequestOpenConsumed={() => {
                  setModePickerRequestOpen(false);
                  setModePickerRequestMode(undefined);
                }}
                onChange={({ mode, employeeIds }) => {
                  setAskMode(mode);
                  askModeRef.current = mode;
                  setAskEmployeeIds(employeeIds);
                  askEmployeeIdsRef.current = employeeIds;
                }}
              />
              {requestInFlight ? (
                <button
                  type="button"
                  onClick={handleStopTurn}
                  aria-label="Stop response"
                  className="shrink-0 px-3 py-2 bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-700 border border-rose-200 rounded-xl transition-all text-xs font-semibold flex items-center gap-1.5 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                  title="Stop this request"
                >
                  <Square className="w-3.5 h-3.5 fill-rose-600 text-rose-600" />
                  <span className="hidden sm:inline">Stop</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={!inputPrompt.trim() || askModeNeedsEmployee}
                  aria-label="Send message"
                  title={
                    askModeNeedsEmployee
                      ? askMode === 'team'
                        ? 'Select 1–3 employees for Team mode'
                        : 'Pick an employee first'
                      : 'Send'
                  }
                  className="shrink-0 p-2.5 bg-amber-500 hover:bg-amber-600 text-heading rounded-xl transition-all disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 shadow-sm"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        );
      })()}
      </div>
    </div>
  );
}
