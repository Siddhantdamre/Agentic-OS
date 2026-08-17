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
  ShieldCheck,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  BookmarkPlus,
} from 'lucide-react';
import { FormattedMarkdownResponse } from '@/components/chat/FormattedMarkdownResponse';
import { ActionPermissionCard, ProposedActionData } from '@/components/chat/ActionPermissionCard';
import { ReasoningStrip } from '@/components/chat/ReasoningStrip';
import { PlanCard, PlanStep } from '@/components/chat/PlanCard';
import { ExecutionStrip, StepRunStatus } from '@/components/chat/ExecutionStrip';
import { DraftPanel, DraftState } from '@/components/chat/DraftPanel';
import { CitationChips } from '@/components/ask-ai/CitationChips';
import { parseEmployeeMentions, type MentionableEmployee } from '@/lib/employee-mentions';
import { LiveRegion, StatusBadge } from '@/components/a11y';

interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  provider?: string;
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
  draftBox?: DraftState;
  execution?: {
    running: boolean;
    statuses: StepRunStatus[];
  };
  vote?: 'up' | 'down';
  promotedName?: string;
}

const DEFAULT_SUGGESTIONS: Array<{ label: string; prompt: string; requires?: string[] }> = [
  { label: 'Ask about our Darex data', prompt: 'How many conversations and messages are in our workspace right now?' },
  { label: '📊 Analyze Google Ads & Meta Ads Performance', prompt: 'Summarize our active advertising metrics, CTR, and ROAS across Google Ads and Meta Ads.', requires: ['google-ads', 'meta-ads'] },
  { label: '📅 Book Sales Demo on Google Calendar', prompt: 'Can you schedule a product demo call on Google Calendar for tomorrow at 2:00 PM?', requires: ['google-calendar'] },
  { label: '🗃️ Log Lead into HubSpot CRM', prompt: 'Log a new qualified sales lead into HubSpot CRM with contact email lead@company.com.', requires: ['hubspot'] },
  { label: '📧 Dispatch Email Follow-Up via Gmail', prompt: 'Draft and dispatch a follow-up email to customer@company.com thanking them for their inquiry.', requires: ['gmail'] },
];

export default function AskAiPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: `### Hello from DareX Executive

I can answer questions and query your Darex data. Connector actions only run for tools that are actually connected — I will not invent results.`,
      provider: 'Atomic Intelligence Agent',
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
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [lockedName, setLockedName] = useState<string | null>(null);
  const [promoteDraft, setPromoteDraft] = useState<Record<string, string>>({});
  const [promoteBusy, setPromoteBusy] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const conversationIdRef = useRef<string>('');
  const queryBootstrapped = useRef(false);

  const storageKey = useRef<string>('askAiMessages');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageNamespace = (userId: string, orgId?: string) =>
    `askAiMessages:${orgId || 'no-org'}:${userId || 'anon'}`;

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
    provider: 'Atomic Intelligence Agent',
    timestamp: 'Just now',
  });

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
      } catch {}
      if (cancelled) return;
      const key = storageNamespace(userId, orgId);
      storageKey.current = key;
      let hydratedConversationId = '';

      try {
        const threadRes = await fetch('/api/ask-ai');
        if (threadRes.ok) {
          const thread = await threadRes.json();
          if (cancelled) return;
          if (thread.conversationId) {
            hydratedConversationId = thread.conversationId;
            setConversationId(thread.conversationId);
          }
          if (Array.isArray(thread.connectedChannels)) setConnectedChannels(thread.connectedChannels);
          if (thread.orgName) setOrgName(thread.orgName);

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
                provider: 'Atomic Agent',
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
              provider: 'Atomic Agent',
              timestamp: formatTs(row.createdAt),
              usedTools: Array.isArray(tc.usedTools) ? tc.usedTools : undefined,
              error: tc.error || undefined,
              retryable: Boolean(tc.retryable),
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
              provider: 'Atomic Agent',
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
            messagesRef.current = serverMsgs;
            setMessages(serverMsgs);
            const orphan = plans.find((p: any) => p.status === 'running');
            if (orphan?.id) {
              void handleApprovePlan(orphan.id);
            }
          } else {
            setMessages([buildWelcome(thread.orgName || 'Your Business', thread.connectedChannels || [])]);
          }
        } else {
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
          window.history.replaceState({}, '', '/ask-ai');
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
        setRoster(
          list.map((e: { id?: string; name?: string; status?: string }) => ({
            id: e.id,
            name: String(e.name || ''),
            status: e.status,
          })).filter((e: MentionableEmployee) => e.name)
        );
      })
      .catch(() => setRoster([]));
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
    if (event.type === 'tool') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                statusLine: `⚙️ ${event.tool}${event.label ? ` — ${event.label}` : ''}…`,
                toolEvents: [...(m.toolEvents || []), { tool: event.tool, label: event.label }],
              }
            : m
        )
      );
      return;
    }
    if (event.type === 'done' || event.type === 'simple') {
      if (event.conversationId) setConversationId(event.conversationId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                ...m,
                text: event.answer || m.text,
                usedTools: event.usedTools || m.usedTools,
                error: event.error || undefined,
                retryable: event.retryable ?? false,
                partialReply: event.partialReply || undefined,
                retryPrompt: event.error ? prompt : undefined,
                statusLine: undefined,
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
              }
            : m
        )
      );
    }
  };

  const sendRequest = async (prompt: string, threadId?: string) => {
    setLoading(true);

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          conversationId: threadId || conversationIdRef.current || undefined,
        }),
      });

      if (res.headers.get('content-type')?.includes('application/x-ndjson')) {
        if (!res.body) {
          throw new Error('Ask AI stream returned no body');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const aiMsgId = `ai_${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: aiMsgId,
            sender: 'ai',
            text: '',
            provider: 'Atomic Agent',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            toolEvents: [],
          },
        ]);

        const consumeLine = (line: string) => {
          if (!line.trim()) return;
          try {
            applyNdjsonEvent(aiMsgId, JSON.parse(line), prompt);
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
      if (res.ok && data.conversationId) setConversationId(data.conversationId);

      if (res.ok && data.type === 'complex' && data.planId) {
        const planMsgId = `ai_plan_${Date.now()}`;
        const planMessage: Message = {
          id: planMsgId,
          sender: 'ai',
          text: '',
          provider: data.provider || 'Atomic Agent',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          type: 'complex',
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
        const aiMessage: Message = {
          id: `ai_${Date.now()}`,
          sender: 'ai',
          text: data.answer,
          provider: data.provider || 'Atomic Agent',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          suggestedActions: data.suggestedActions,
          proposedAction: data.proposedAction,
          error: data.error || undefined,
          retryable: data.retryable ?? false,
          partialReply: data.partialReply || undefined,
          retryPrompt: data.error ? prompt : undefined,
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
          provider: 'Atomic Agent',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: data.error,
          retryable: Boolean(data.retryable),
          retryPrompt: data.retryable ? prompt : undefined,
        };
        setMessages((prev) => [...prev, errMessage]);
      }
    } catch (err) {
      console.error('Ask AI error:', err);
      const errMessage: Message = {
        id: `ai_err_${Date.now()}`,
        sender: 'ai',
        text: '❌ **Connection error.** Could not reach the Ask AI backend. Please confirm the worker & atomic-agent services are running, then try again.',
        provider: 'Atomic Agent',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        error: 'Connection error',
        retryable: true,
        retryPrompt: prompt,
      };
      setMessages((prev) => [...prev, errMessage]);
    } finally {
      setLoading(false);
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

  const handleSendMessage = async (textToSend?: string) => {
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

    setMessages((prev) => [...prev, userMessage]);
    setInputPrompt('');
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

      const streamRes = await fetch(`/api/ask-ai/execute?planId=${encodeURIComponent(planId)}`);
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
    } catch (err) {
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
    }
  };

  const handleCancelPlan = async (planId: string) => {
    try {
      await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action: 'cancel' }),
      });
    } catch {}
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
        body: JSON.stringify({ planId, steps: steps.map((s) => ({ id: s.id, description: s.description, enabled: s.enabled })) }),
      });
    } catch {}
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
    } catch {}
  };

  const handleDraftRevised = (msgId: string, draft: DraftState) => {
    patchMessage(msgId, { draftBox: draft });
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

  const handlePromotePlan = async (msg: Message) => {
    const planId = msg.planCard?.planId;
    if (!planId) return;
    const name = (promoteDraft[planId] || '').trim();
    if (name.length < 3) return;
    setPromoteBusy(planId);
    try {
      const res = await fetch('/api/ask-ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'promote', planId, name }),
      });
      const data = await res.json();
      if (res.ok && data.promotion?.name) {
        patchMessage(msg.id, { promotedName: data.promotion.name });
      }
    } catch (err) {
      console.error('Ask AI playbook promote failed', err);
    } finally {
      setPromoteBusy(null);
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
      provider: 'Executive Intelligence Engine',
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
    <div className="max-w-5xl mx-auto flex flex-col h-[calc(100vh-8.5rem)] md:h-[calc(100vh-6rem)] space-y-4">
      <LiveRegion
        message={
          loading
            ? 'Ask AI is responding'
            : messages.find((m) => m.statusLine)?.statusLine || ''
        }
      />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cream-300 pb-4 shrink-0 gap-2">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
            <Brain className="w-5 h-5 text-amber-600 animate-pulse" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-serif font-bold text-heading truncate">Ask AI Intelligence</h1>
            <p className="text-xs text-slate-500 truncate">
              {orgName}
              {connectedChannels.length > 0
                ? ` · connected: ${connectedChannels.join(', ')}`
                : ' · no OAuth connectors yet'}
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center space-x-2 shrink-0">
          <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1 bg-amber-500/10 text-amber-800 rounded-full border border-amber-500/30 flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-600" />
            <span>Atomic Agent Active</span>
          </span>
        </div>
      </div>

      {/* Chat Messages Feed */}
      <div className="flex-1 overflow-y-auto space-y-6 pr-2">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
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
              <div className={`space-y-2 max-w-2xl ${isUser ? 'items-end' : 'items-start'}`}>
                <div className="flex items-center space-x-2 px-1">
                  <span className="text-xs font-bold text-slate-700">{isUser ? 'You' : 'DareX AI Intelligence'}</span>
                  {msg.provider && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-cream-200 text-slate-600">
                      {msg.provider}
                    </span>
                  )}
                  <span suppressHydrationWarning className="text-[10px] text-slate-400 font-mono">{msg.timestamp}</span>
                </div>

                {/* ── Claude-style layout: Reasoning & Plan/Draft appear at the TOP of the response ── */}
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
                      />
                    ) : (
                      (msg.planCard.status === 'pending' || msg.planCard.status === 'approved') && (
                        <PlanCard
                          planId={msg.planCard.planId}
                          summary={msg.planCard.summary}
                          steps={msg.planCard.steps}
                          disabled={msg.planCard.status === 'approved'}
                          onApprove={handleApprovePlan}
                          onCancel={handleCancelPlan}
                          onToggleStep={handleToggleStep}
                          onAddInstruction={handleAddInstruction}
                        />
                      )
                    )}

                    {(msg.planCard.status === 'completed' || msg.planCard.status === 'completed_with_errors') && msg.draftBox && (
                      <DraftPanel
                        draft={msg.draftBox}
                        planId={msg.planCard.planId}
                        editable
                        onRevised={(d) => handleDraftRevised(msg.id, d)}
                      />
                    )}

                    {(msg.planCard.status === 'completed' ||
                      msg.planCard.status === 'completed_with_errors' ||
                      msg.planCard.status === 'approved') && (
                      <div className="mt-2 p-3 rounded-xl border border-cream-300 bg-cream-50 space-y-2">
                        <p className="text-[11px] text-slate-600 flex items-center gap-1.5">
                          <BookmarkPlus className="w-3.5 h-3.5" />
                          Promote this plan to a human-named org playbook. Replay uses the matcher — no cross-org training.
                        </p>
                        {msg.promotedName ? (
                          <p className="text-[11px] font-semibold text-emerald-700">Promoted as “{msg.promotedName}”</p>
                        ) : (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={promoteDraft[msg.planCard.planId] || ''}
                              onChange={(e) =>
                                setPromoteDraft((prev) => ({ ...prev, [msg.planCard!.planId]: e.target.value }))
                              }
                              placeholder="Name this playbook…"
                              className="flex-1 text-xs px-2.5 py-1.5 rounded-lg border border-cream-300 bg-white"
                            />
                            <button
                              type="button"
                              onClick={() => handlePromotePlan(msg)}
                              disabled={
                                promoteBusy === msg.planCard.planId ||
                                (promoteDraft[msg.planCard.planId] || '').trim().length < 3
                              }
                              className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg bg-amber-500 text-heading disabled:opacity-40"
                            >
                              {promoteBusy === msg.planCard.planId ? 'Saving…' : 'Promote'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {msg.planCard.status !== 'completed' && msg.draftBox && (
                      <DraftPanel
                        draft={msg.draftBox}
                        planId={msg.planCard.planId}
                        editable={false}
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
                  <div className="px-4 py-2.5 rounded-2xl text-[11px] text-amber-800 bg-amber-50 border border-amber-500/30 flex items-center gap-2">
                    <RefreshCw className="w-3 h-3 text-amber-600 animate-spin shrink-0" />
                    <span className="font-mono">{msg.statusLine}</span>
                  </div>
                )}
                {!isUser && msg.toolEvents && msg.toolEvents.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.toolEvents.map((ev, idx) => (
                      <span
                        key={`${ev.tool}-${idx}`}
                        className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200"
                      >
                        {ev.tool}{ev.label ? ` — ${ev.label}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                <div
                  className={`p-5 rounded-3xl text-xs leading-relaxed border shadow-sm ${
                    isUser
                      ? 'bg-amber-500 text-heading border-amber-600 font-medium rounded-tr-none'
                      : 'bg-white text-slate-800 border-cream-300 rounded-tl-none'
                  } ${!isUser && !msg.text ? 'hidden' : ''}`}
                >
                  {isUser ? msg.text : <FormattedMarkdownResponse content={msg.text} />}
                </div>
                {!isUser && msg.text && <CitationChips text={msg.text} />}
                {!isUser && (msg.text || msg.usedTools?.length) && (
                  <div className="flex items-center flex-wrap gap-2 px-1">
                    {msg.usedTools && msg.usedTools.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {msg.usedTools.map((tool) => (
                          <span
                            key={tool}
                            className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <button
                        type="button"
                        onClick={() => handleCopyText(msg.id, msg.text)}
                        className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 flex items-center gap-1"
                      >
                        {copiedId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedId === msg.id ? 'Copied' : 'Copy'}
                      </button>
                    )}
                    {msg.text && msg.id !== 'welcome' && (
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
          !messages.some((m) => m.sender === 'ai' && (m.statusLine || (!m.text && m.id !== 'welcome' && !m.planCard))) && (
          <div className="flex items-start space-x-3">
            <div className="w-9 h-9 rounded-2xl bg-amber-500 text-heading flex items-center justify-center border border-amber-600">
              <Bot className="w-4 h-4 animate-bounce" />
            </div>
            <div className="bg-white border border-cream-300 p-4 rounded-3xl text-xs text-slate-500 flex items-center space-x-2 shadow-sm">
              <RefreshCw className="w-4 h-4 text-amber-600 animate-spin" />
              <span>Synthesizing multi-tool intelligence response...</span>
            </div>
          </div>
        )}

        {messages.length <= 1 && !loading && (
          <div className="flex flex-wrap gap-2 pb-2">
            {DEFAULT_SUGGESTIONS.filter(
              (s) => !s.requires || s.requires.some((tool) => connectedChannels.includes(tool))
            ).map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => handleSendMessage(s.prompt)}
                className="px-3 py-1.5 bg-cream-100 hover:bg-amber-500/10 border border-cream-300 hover:border-amber-500/40 text-slate-700 font-semibold text-[11px] rounded-xl transition-all"
              >
                {s.label}
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
        return (
          <div className="relative shrink-0 pb-2 space-y-2">
            {lockedName ? (
              <StatusBadge label={`Asking ${lockedName} · org-union tools`} tone="info" />
            ) : (
              <p className="text-[11px] text-slate-400 px-1">Type @name to mention an employee. Tools stay org-union.</p>
            )}
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
                      @{emp.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              type="text"
              placeholder={
                hasPendingPlanOrDraft
                  ? 'Approve the plan above to continue, or ask something else...'
                  : 'Ask AI… use @Sarah to mention an employee'
              }
              value={inputPrompt}
              onChange={(e) => {
                setInputPrompt(e.target.value);
                applyMentionChrome(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              disabled={loading}
              aria-label="Ask AI prompt"
              className={`w-full pl-5 pr-14 py-3.5 rounded-2xl text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shadow-sm disabled:opacity-50 transition-all ${
                hasPendingPlanOrDraft
                  ? 'bg-cream-100/80 border border-amber-500/40 text-heading placeholder-amber-900/60 font-semibold'
                  : 'bg-white border border-cream-300 text-heading focus:border-amber-500'
              }`}
            />
            <button
              type="button"
              onClick={() => handleSendMessage()}
              disabled={!inputPrompt.trim() || loading}
              aria-label="Send message"
              className="absolute right-2 bottom-2 p-2 bg-amber-500 hover:bg-amber-600 text-heading rounded-xl transition-all disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        );
      })()}
    </div>
  );
}
