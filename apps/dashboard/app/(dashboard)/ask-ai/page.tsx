'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Send,
  Bot,
  User,
  Zap,
  Calendar,
  Mail,
  Database,
  BarChart2,
  RefreshCw,
  Copy,
  Check,
  Brain,
  ShieldCheck,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { FormattedMarkdownResponse } from '@/components/chat/FormattedMarkdownResponse';
import { ActionPermissionCard, ProposedActionData } from '@/components/chat/ActionPermissionCard';
import { ReasoningStrip } from '@/components/chat/ReasoningStrip';
import { PlanCard, PlanStep } from '@/components/chat/PlanCard';
import { ExecutionStrip, StepRunStatus } from '@/components/chat/ExecutionStrip';
import { DraftPanel, DraftState } from '@/components/chat/DraftPanel';

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
  planCard?: {
    planId: string;
    summary: string;
    steps: PlanStep[];
    status: 'pending' | 'approved' | 'running' | 'completed' | 'cancelled';
  };
  draftBox?: DraftState;
  execution?: {
    running: boolean;
    statuses: StepRunStatus[];
  };
}

const DEFAULT_SUGGESTIONS = [
  { label: '📊 Analyze Google Ads & Meta Ads Performance', prompt: 'Summarize our active advertising metrics, CTR, and ROAS across Google Ads and Meta Ads.' },
  { label: '📅 Book Sales Demo on Google Calendar', prompt: 'Can you schedule a product demo call on Google Calendar for tomorrow at 2:00 PM?' },
  { label: '🗃️ Log Lead into HubSpot CRM', prompt: 'Log a new qualified sales lead into HubSpot CRM with contact email lead@company.com.' },
  { label: '📧 Dispatch Email Follow-Up via Gmail', prompt: 'Draft and dispatch a follow-up email to customer@company.com thanking them for their inquiry.' },
];

export default function AskAiPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: `### 🤖 Hello! I am DareX Executive AI Intelligence.

I have full operational awareness and live integration access across your **connected tools**:
- 💬 **Messaging:** WhatsApp Business, Slack
- 📧 **Email & Calendar:** Gmail, Google Calendar
- 📊 **Advertising:** Google Ads, Meta Ads
- 🗃️ **CRM & Support:** HubSpot CRM, Zendesk, Intercom
- 💳 **Payments & E-Com:** Stripe, Shopify, Razorpay
- 🧠 **Knowledge & Code:** Notion, GitHub

How can I assist your business strategy or automate your workflows today?`,
      provider: 'Atomic Intelligence Agent',
      timestamp: 'Just now',
      suggestedActions: [
        { label: '📅 Book Demo on Google Calendar', tool: 'google-calendar', action: 'create_event' },
        { label: '📧 Dispatch Gmail Follow-Up', tool: 'gmail', action: 'send_email' },
        { label: '🗃️ Log Lead in HubSpot CRM', tool: 'hubspot', action: 'create_crm_contact' },
        { label: '📊 Fetch Meta & Google Ads Metrics', tool: 'meta-ads', action: 'fetch_campaign_metrics' },
      ],
    },
  ]);

  const [inputPrompt, setInputPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [executingTool, setExecutingTool] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('user@company.com');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const storageKey = useRef<string>('askAiMessages');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageNamespace = (userId: string, orgId?: string) =>
    `askAiMessages:${orgId || 'no-org'}:${userId || 'anon'}`;

  // Persistence: Load messages from local storage on mount (namespaced per org+user)
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
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) setMessages(parsed);
        } catch (e) {
          console.error('Failed to parse saved messages', e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const sendRequest = async (prompt: string) => {
    setLoading(true);

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (res.headers.get('content-type')?.includes('application/x-ndjson')) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        const aiMsgId = `ai_${Date.now()}`;
        setMessages((prev) => [...prev, {
          id: aiMsgId,
          sender: 'ai',
          text: '',
          provider: 'Atomic Agent',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (!line.trim()) continue;
            
            try {
              const event = JSON.parse(line);
              if (event.type === 'chunk') {
                 setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { ...m, text: m.text + event.text } : m)));
              } else if (event.type === 'tool') {
                 // Live tool-progress: update the in-flight bubble's status line
                 setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { ...m, statusLine: `⚙️ ${event.tool}${event.label ? ` — ${event.label}` : ''}…` } : m)));
              } else if (event.type === 'done') {
                 setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { ...m, ...event, statusLine: undefined } : m)));
              } else if (event.type === 'error') {
                 setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { 
                   ...m, 
                   error: event.error, 
                   retryable: event.retryable,
                   text: (m.text || '') + `\n\n❌ **Error:** ${event.error}`,
                   retryPrompt: prompt,
                   statusLine: undefined,
                 } : m)));
              }
            } catch(e) {}
          }
        }
        return;
      }

      const data = await res.json();

      // ── COMPLEX: plan-confirm-execute proposal ──────────────────────────
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

  const handleSendMessage = async (textToSend?: string) => {
    const prompt = textToSend || inputPrompt;
    if (!prompt.trim() || loading) return;

    const userMsgId = `user_${Date.now()}`;
    const userMessage: Message = {
      id: userMsgId,
      sender: 'user',
      text: prompt,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputPrompt('');
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
      const res = await fetch('/api/ask-ai/plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action: 'approve' }),
      });
      if (!res.ok) return;

      const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
      if (!msgId) return;

      const stepIds = (messages.find((m) => m.id === msgId)?.planCard?.steps || []).map((s) => ({
        id: s.id || `step-${s.description}`,
        description: s.description,
      }));

      const setPlanMsg = (patch: Partial<Message>) => {
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, ...patch } : m)));
      };

      let statuses: StepRunStatus[] = stepIds.map(() => ({ status: 'pending' as const }));
      setPlanMsg({
        planCard: { ...messages.find((m) => m.id === msgId)!.planCard!, status: 'running' },
        execution: { running: true, statuses },
      });

      const streamRes = await fetch(`/api/ask-ai/execute?planId=${encodeURIComponent(planId)}`);
      if (!streamRes.ok || !streamRes.body) {
        statuses = stepIds.map(() => ({ status: 'error' as const, message: 'Failed to open execution stream' }));
        setPlanMsg({
          planCard: { ...messages.find((m) => m.id === msgId)!.planCard!, status: 'approved' },
          execution: { running: false, statuses },
        });
        return;
      }

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType: string | null = null;

      const updateSteps = (index: number, status: StepRunStatus) => {
        if (!statuses[index]) statuses[index] = status;
        else statuses[index] = { ...statuses[index], ...status };
        setPlanMsg({ execution: { running: true, statuses: [...statuses] } });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          eventType = null;
          let dataLine = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine || !eventType) continue;
          let evt: any;
          try { evt = JSON.parse(dataLine); } catch { continue; }

          if (eventType === 'step_start' && typeof evt.stepIndex === 'number') {
            updateSteps(evt.stepIndex, { status: 'running' });
          } else if (eventType === 'step_done' && typeof evt.stepIndex === 'number') {
            updateSteps(evt.stepIndex, {
              status: evt.status === 'error' ? 'error' : 'done',
              message: evt.message,
            });
          } else if (eventType === 'step_error' && typeof evt.stepIndex === 'number') {
            updateSteps(evt.stepIndex, { status: 'error', message: evt.message });
          } else if (eventType === 'execution_done') {
            setPlanMsg({
              planCard: {
                ...messages.find((m) => m.id === msgId)!.planCard!,
                status: evt.status === 'completed' || evt.status === 'completed_with_errors' ? 'completed' : 'cancelled',
              },
              execution: { running: false, statuses: [...statuses] },
            });
          } else if (eventType === 'execution_error') {
            const failedIdx = statuses.findIndex((s) => s.status === 'running');
            if (failedIdx >= 0) statuses[failedIdx] = { status: 'error', message: evt.message };
            setPlanMsg({
              planCard: {
                ...messages.find((m) => m.id === msgId)!.planCard!,
                status: 'cancelled',
              },
              execution: { running: false, statuses: [...statuses] },
            });
          }
        }
      }

      // Stream closed without execution_done: mark done anyway based on progress
      const curPlan = messages.find((m) => m.id === msgId)?.planCard;
      if (curPlan?.status === 'running') {
        setPlanMsg({
          planCard: { ...curPlan, status: 'completed' },
          execution: { running: false, statuses: [...statuses] },
        });
      }
    } catch (err) {
      console.error('Plan execution error:', err);
      const msgId = messages.find((m) => m.planCard?.planId === planId)?.id;
      if (msgId) {
        const cur = messages.find((m) => m.id === msgId)!;
        patchMessage(msgId, {
          planCard: { ...cur.planCard!, status: 'approved' },
          execution: { running: false, statuses: cur.execution?.statuses || [] },
        });
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
      tool: 'agent.user_instruction',
      action: 'execute_context',
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

  const handleExecuteToolAction = async (tool: string, action: string, label: string) => {
    setExecutingTool(label);

    let payload: Record<string, any> = {};
    if (action === 'create_event') {
      payload = { summary: 'Sales Demo Call', startTime: new Date(Date.now() + 86400000).toISOString() };
    } else if (action === 'send_email') {
      payload = { recipient: currentUserEmail, subject: 'Follow-up from DareX AI', content: 'Thank you for contacting us!' };
    } else if (action === 'create_crm_contact') {
      payload = { email: 'lead@company.com', firstname: 'Test', lastname: 'Lead' };
    }

    try {
      const res = await fetch('/api/agent/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool,
          action,
          payload,
        }),
      });

      const data = await res.json();
      if (data.success && data.result) {
        const confirmMsg: Message = {
          id: `tool_confirm_${Date.now()}`,
          sender: 'ai',
          text: `⚡ **Tool Action Executed Successfully!**\n\n- **Tool:** \`${data.result.tool}\`\n- **Action:** \`${data.result.action}\`\n- **Status:** \`${data.result.status}\`\n- **Result:** ${data.result.message}\n\n\`\`\`json\n${JSON.stringify(data.result.data, null, 2)}\n\`\`\``,
          provider: 'Tool Engine',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setMessages((prev) => [...prev, confirmMsg]);
      }
    } catch (err) {
      console.error('Tool execution error:', err);
    } finally {
      setExecutingTool(null);
    }
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
    <div className="max-w-5xl mx-auto flex flex-col h-[calc(100vh-6rem)] space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cream-300 pb-4 shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
            <Brain className="w-5 h-5 text-amber-600 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-serif font-bold text-heading">Ask AI Intelligence</h1>
            <p className="text-xs text-slate-500">Autonomous business reasoning engine connected to your tools &amp; live DB</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1 bg-amber-500/10 text-amber-800 rounded-full border border-amber-500/30 flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-600" />
            <span>☤ Atomic Intelligence Agent Active</span>
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

                    {msg.planCard.status === 'completed' && msg.draftBox && (
                      <DraftPanel
                        draft={msg.draftBox}
                        planId={msg.planCard.planId}
                        editable
                        onRevised={(d) => handleDraftRevised(msg.id, d)}
                      />
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
                {!isUser && msg.statusLine && !msg.text && (
                  <div className="px-4 py-2.5 rounded-2xl text-[11px] text-amber-800 bg-amber-50 border border-amber-500/30 flex items-center gap-2">
                    <RefreshCw className="w-3 h-3 text-amber-600 animate-spin shrink-0" />
                    <span className="font-mono">{msg.statusLine}</span>
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
                    {msg.retryable && msg.retryPrompt && (
                      <button
                        onClick={() => handleRetry(msg.retryPrompt!)}
                        disabled={loading}
                        className="shrink-0 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-heading font-bold rounded-lg transition-all disabled:opacity-40"
                      >
                        {loading ? 'Running…' : 'Retry'}
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

        {/* Loading Indicator */}
        {loading && (
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
          <div className="relative shrink-0 pb-2">
            <input
              type="text"
              placeholder={
                hasPendingPlanOrDraft
                  ? 'Approve the plan above to continue, or ask something else...'
                  : 'Ask AI anything about your sales, ad performance, leads, or execute tool actions...'
              }
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              disabled={loading}
              className={`w-full pl-5 pr-14 py-3.5 rounded-2xl text-xs font-medium focus:outline-none shadow-sm disabled:opacity-50 transition-all ${
                hasPendingPlanOrDraft
                  ? 'bg-cream-100/80 border border-amber-500/40 text-heading placeholder-amber-900/60 font-semibold'
                  : 'bg-white border border-cream-300 text-heading focus:border-amber-500'
              }`}
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputPrompt.trim() || loading}
              className="absolute right-2 top-2 p-2 bg-amber-500 hover:bg-amber-600 text-heading rounded-xl transition-all disabled:opacity-40"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        );
      })()}
    </div>
  );
}
