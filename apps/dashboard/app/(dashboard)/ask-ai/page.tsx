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
} from 'lucide-react';
import { FormattedMarkdownResponse } from '@/components/chat/FormattedMarkdownResponse';
import { ActionPermissionCard, ProposedActionData } from '@/components/chat/ActionPermissionCard';

interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  provider?: string;
  timestamp: string;
  suggestedActions?: Array<{ label: string; tool: string; action: string }>;
  proposedAction?: ProposedActionData;
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

I have full operational awareness and live integration access across all **14 connected tools**:
- 💬 **Messaging:** WhatsApp Business, Slack
- 📧 **Email & Calendar:** Gmail, Google Calendar
- 📊 **Advertising:** Google Ads, Meta Ads
- 🗃️ **CRM & Support:** HubSpot CRM, Zendesk, Intercom
- 💳 **Payments & E-Com:** Stripe, Shopify, Razorpay
- 🧠 **Knowledge & Code:** Notion, GitHub

How can I assist your business strategy or automate your workflows today?`,
      provider: 'Groq (llama-3.3-70b)',
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

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data.email) setCurrentUserEmail(data.email);
      })
      .catch(() => {});
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

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
    setLoading(true);

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json();
      if (res.ok && data.answer) {
        const aiMessage: Message = {
          id: `ai_${Date.now()}`,
          sender: 'ai',
          text: data.answer,
          provider: data.provider || 'Groq',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          suggestedActions: data.suggestedActions,
          proposedAction: data.proposedAction,
        };
        setMessages((prev) => [...prev, aiMessage]);
      }
    } catch (err) {
      console.error('Ask AI error:', err);
    } finally {
      setLoading(false);
    }
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
            <p className="text-xs text-slate-500">Autonomous business reasoning engine connected to all 14 tools & live DB</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1 bg-amber-500/10 text-amber-800 rounded-full border border-amber-500/30 flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-600" />
            <span>☤ NousResearch Hermes Agent v3 + Groq Llama 3.3 Active</span>
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

                <div
                  className={`p-5 rounded-3xl text-xs leading-relaxed border shadow-sm ${
                    isUser
                      ? 'bg-amber-500 text-heading border-amber-600 font-medium rounded-tr-none'
                      : 'bg-white text-slate-800 border-cream-300 rounded-tl-none'
                  }`}
                >
                  {isUser ? msg.text : <FormattedMarkdownResponse content={msg.text} />}
                </div>

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
      <div className="relative shrink-0 pb-2">
        <input
          type="text"
          placeholder="Ask AI anything about your sales, ad performance, leads, or execute tool actions..."
          value={inputPrompt}
          onChange={(e) => setInputPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
          disabled={loading}
          className="w-full pl-5 pr-14 py-3.5 bg-white border border-cream-300 rounded-2xl text-xs font-medium text-heading focus:outline-none focus:border-amber-500 shadow-sm disabled:opacity-50"
        />
        <button
          onClick={() => handleSendMessage()}
          disabled={!inputPrompt.trim() || loading}
          className="absolute right-2 top-2 p-2 bg-amber-500 hover:bg-amber-600 text-heading rounded-xl transition-all disabled:opacity-40"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
