'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  MessageSquare,
  Mail,
  Search,
  CheckCircle2,
  Clock,
  Send,
  RefreshCw,
  Sparkles,
  ShieldAlert,
  Bot,
  Filter,
  Plus,
  X,
  Zap,
  ArrowLeft,
} from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { FormattedMarkdownResponse } from '@/components/chat/FormattedMarkdownResponse';

interface Conversation {
  id: string;
  org_id: string;
  chatwoot_conv_id: number;
  status: 'open' | 'resolved' | 'pending_human' | 'needs_attention';
  contact_id: string;
  summary: string;
  metadata: any;
  started_at: string;
  updated_at: string;
  employee_id: string | null;
  employee_name: string | null;
  employee_role: string | null;
  channel_type: string;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'human_agent';
  content: string;
  created_at: string;
}

interface AIEmployee {
  id: string;
  name: string;
  role: string;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [replyAsCustomer, setReplyAsCustomer] = useState(false);

  // New Chat Modal
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [newChatContact, setNewChatContact] = useState('');
  const [newChatChannel, setNewChatChannel] = useState('whatsapp');
  const [newChatEmployeeId, setNewChatEmployeeId] = useState('');
  const [newChatInitialMessage, setNewChatInitialMessage] = useState('');
  const [creatingChat, setCreatingChat] = useState(false);
  const [employees, setEmployees] = useState<AIEmployee[]>([]);

  // Filters
  const [selectedChannel, setSelectedChannel] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [workType, setWorkType] = useState<string>('all');
  const [workPriority, setWorkPriority] = useState<string>('all');
  const [assigneeId, setAssigneeId] = useState<string>('all');
  const [workItemConvIds, setWorkItemConvIds] = useState<Set<string> | null>(null);
  const [mobilePane, setMobilePane] = useState<'list' | 'thread'>('list');

  // Stats
  const [stats, setStats] = useState({
    total: 0,
    open: 0,
    resolved: 0,
    pending_human: 0,
    channels: {} as Record<string, number>,
  });

  const selectedConvIdRef = useRef<string | null>(null);
  selectedConvIdRef.current = selectedConvId;
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [notif, setNotif] = useState<string | null>(null);
  const [notifVisible, setNotifVisible] = useState(false);
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream/events');
    const onInboxEvent = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const conversationId = payload.conversationId as string | undefined;
        if (conversationId) {
          if (e.type === 'needs_attention') {
            setSelectedConvId(conversationId);
          }
          fetchConversations();
          if (conversationId === selectedConvIdRef.current) {
            void fetchMessages(conversationId);
          }
        }
        if (e.type === 'needs_attention') {
          const sender = payload.contactId?.toString() || 'Customer';
          const preview = (payload.message?.toString() || '').slice(0, 80);
          setNotif(`${sender}: ${preview}`);
          setNotifVisible(true);
          if (notifTimer.current) clearTimeout(notifTimer.current);
          notifTimer.current = setTimeout(() => setNotifVisible(false), 6000);
        }
      } catch (err) {
        console.error('Failed to parse realtime event:', err);
      }
    };
    es.addEventListener('needs_attention', onInboxEvent);
    es.addEventListener('conversation_updated', onInboxEvent);
    es.addEventListener('message_received', onInboxEvent);
    es.addEventListener('connected', () => {
      console.log('[Realtime] SSE stream connected');
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch conversation list
  const fetchConversations = async () => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams();
      if (selectedChannel !== 'all') queryParams.append('channel', selectedChannel);
      if (selectedStatus !== 'all') queryParams.append('status', selectedStatus);
      if (searchQuery) queryParams.append('search', searchQuery);

      const res = await fetch(`/api/conversations?${queryParams.toString()}`);
      const data = await res.json();

      if (data.conversations) {
        setConversations(data.conversations);
        if (data.conversations.length > 0 && !selectedConvId) {
          setSelectedConvId(data.conversations[0].id);
        }
      }
      if (data.stats) {
        setStats(data.stats);
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch employees for modal + assignee filter
  useEffect(() => {
    fetch('/api/employees')
      .then((res) => res.json())
      .then((data) => setEmployees(data.employees || []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (workType !== 'all') params.set('type', workType);
    if (workPriority !== 'all') params.set('priority', workPriority);
    if (assigneeId !== 'all') params.set('assignee', assigneeId);
    fetch(`/api/work-items?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data?.workItems)
          ? data.workItems
          : Array.isArray(data?.items)
            ? data.items
            : null;
        if (!items) {
          setWorkItemConvIds(null);
          return;
        }
        const ids = new Set<string>();
        for (const item of items) {
          const cid = item?.conversationId || item?.conversation_id;
          if (typeof cid === 'string') ids.add(cid);
        }
        setWorkItemConvIds(ids);
      })
      .catch(() => {
        if (!cancelled) setWorkItemConvIds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workType, workPriority, assigneeId]);

  // Fetch thread messages for selected conversation
  const fetchMessages = async (convId: string, silent = false) => {
    try {
      if (!silent) setMessagesLoading(true);
      const res = await fetch(`/api/conversations/${convId}/messages`);
      const data = await res.json();
      // Guard against races: only apply the result if this conversation is
      // still the one selected (an older fetch can resolve after a newer one
      // if the user switches conversations quickly).
      if (data.messages && selectedConvIdRef.current === convId) {
        setMessages(data.messages);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      if (!silent && selectedConvIdRef.current === convId) setMessagesLoading(false);
    }
  };

  const pollForAssistant = async (convId: string) => {
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (selectedConvIdRef.current !== convId) return;
      await fetchMessages(convId, true);
    }
  };

  useEffect(() => {
    fetchConversations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannel, selectedStatus, searchQuery]);

  useEffect(() => {
    if (selectedConvId) {
      fetchMessages(selectedConvId);
    }
  }, [selectedConvId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message in thread
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyContent.trim() || !selectedConvId || sendingReply) return;

    try {
      setSendingReply(true);
      const targetRole = replyAsCustomer ? 'user' : 'human_agent';

      const res = await fetch(`/api/conversations/${selectedConvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyContent, role: targetRole }),
      });

      const data = await res.json();
      if (data.success) {
        setReplyContent('');
        await fetchMessages(selectedConvId);
        fetchConversations();
        if (replyAsCustomer) {
          void pollForAssistant(selectedConvId);
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSendingReply(false);
    }
  };

  // Start New Test Conversation
  const handleCreateNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChatInitialMessage.trim() || creatingChat) return;

    try {
      setCreatingChat(true);
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: newChatContact || `Customer ${Math.floor(100 + Math.random() * 900)}`,
          channelType: newChatChannel,
          employeeId: newChatEmployeeId || undefined,
          initialMessage: newChatInitialMessage,
        }),
      });

      const data = await res.json();
      if (data.success && data.conversation) {
        setIsNewChatOpen(false);
        setNewChatContact('');
        setNewChatInitialMessage('');
        setSelectedConvId(data.conversation.id);
        fetchConversations();
        void pollForAssistant(data.conversation.id);
      }
    } catch (err) {
      console.error('Failed to create new chat:', err);
    } finally {
      setCreatingChat(false);
    }
  };

  // Toggle conversation status
  const handleStatusChange = async (newStatus: string) => {
    if (!selectedConvId) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        fetchConversations();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const visibleConversations = conversations.filter((conv) => {
    if (assigneeId !== 'all' && conv.employee_id !== assigneeId) return false;
    if (workItemConvIds && (workType !== 'all' || workPriority !== 'all')) {
      return workItemConvIds.has(conv.id);
    }
    if (workType === 'inquiry' && workItemConvIds === null) return false;
    return true;
  });

  const activeConv = visibleConversations.find((c) => c.id === selectedConvId) || conversations.find((c) => c.id === selectedConvId);

  const getChannelIcon = (type: string) => {
    const kind = (type || '').toLowerCase();
    switch (kind) {
      case 'whatsapp':
        return <MessageSquare className="w-4 h-4 text-emerald-400" />;
      case 'gmail':
      case 'email':
        return <Mail className="w-4 h-4 text-blue-400" />;
      case 'chatwoot':
        return <MessageSquare className="w-4 h-4 text-amber-400" />;
      default:
        return <MessageSquare className="w-4 h-4 text-amber-400" />;
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] bg-[#121917] text-[#FAF9F0] overflow-hidden">
      <LiveRegion message={notifVisible && notif ? `Needs attention: ${notif}` : ''} politeness="assertive" />
      {notifVisible && notif && (
        <div className="fixed top-4 right-4 z-50 bg-amber-950/95 border border-amber-600/40 text-amber-100 rounded-xl px-4 py-3 shadow-2xl max-w-sm flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-xs font-bold text-amber-300 uppercase tracking-wider mb-0.5">
              Needs Attention
            </div>
            <p className="text-xs text-amber-100/90 break-words">{notif}</p>
          </div>
          <button onClick={() => setNotifVisible(false)} className="text-amber-400 hover:text-amber-200 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {/* ───────────────────────────────────────────────────────────── */}
      {/* PANE 1: FILTER & CHANNEL SIDEBAR */}
      {/* ───────────────────────────────────────────────────────────── */}
      <div className={`${mobilePane === 'thread' ? 'hidden md:flex' : 'flex'} w-full md:w-64 border-r border-emerald-950/60 bg-[#16201D] flex-col shrink-0`}>
        <div className="p-4 border-b border-emerald-950/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-[#F0C05A]" />
            <h2 className="font-bold text-sm tracking-wide">Multi-Channel Inbox</h2>
          </div>
          <button
            onClick={() => fetchConversations()}
            className="p-1.5 hover:bg-emerald-900/40 rounded text-emerald-400 transition"
            title="Refresh feed"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-6 overflow-y-auto flex-1">
          {/* Status Filters */}
          <div>
            <div className="px-2 mb-2 text-xs font-semibold text-emerald-500 uppercase tracking-wider">
              Inbox Views
            </div>
            <div className="space-y-1">
              {[
                { id: 'all', label: 'All Inboxes', icon: MessageSquare, count: stats.total },
                { id: 'open', label: 'Open Chats', icon: Clock, count: stats.open },
                { id: 'needs_attention', label: 'Needs Attention', icon: ShieldAlert, count: stats.pending_human, alert: true },
                { id: 'resolved', label: 'Resolved', icon: CheckCircle2, count: stats.resolved },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedStatus(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition font-medium ${
                    selectedStatus === item.id
                      ? 'bg-[#F0C05A]/10 text-[#F0C05A] border border-[#F0C05A]/30'
                      : 'hover:bg-emerald-900/30 text-emerald-100/70'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <item.icon className={`w-4 h-4 ${item.alert ? 'text-amber-400' : ''}`} />
                    <span>{item.label}</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      selectedStatus === item.id
                        ? 'bg-[#F0C05A] text-[#16201D]'
                        : 'bg-emerald-950 text-emerald-400'
                    }`}
                  >
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="px-2 mb-2 text-xs font-semibold text-emerald-500 uppercase tracking-wider">
              Work items
            </div>
            <label className="block px-2 mb-1 text-[10px] text-emerald-500">Type</label>
            <select
              value={workType}
              onChange={(e) => setWorkType(e.target.value)}
              className="w-full mb-2 bg-[#1A2623] border border-emerald-900/60 rounded-lg px-2 py-1.5 text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]/60"
            >
              <option value="all">All types</option>
              <option value="conversation">Conversation</option>
              <option value="re.inquiry">Inquiry</option>
              <option value="task">Task</option>
            </select>
            <label className="block px-2 mb-1 text-[10px] text-emerald-500">Priority</label>
            <select
              value={workPriority}
              onChange={(e) => setWorkPriority(e.target.value)}
              className="w-full mb-2 bg-[#1A2623] border border-emerald-900/60 rounded-lg px-2 py-1.5 text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]/60"
            >
              <option value="all">All priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <label className="block px-2 mb-1 text-[10px] text-emerald-500">Assignee</label>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="w-full bg-[#1A2623] border border-emerald-900/60 rounded-lg px-2 py-1.5 text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]/60"
            >
              <option value="all">All employees</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>

          {/* Channel Filters */}
          <div>
            <div className="px-2 mb-2 text-xs font-semibold text-emerald-500 uppercase tracking-wider">
              Channels
            </div>
            <div className="space-y-1">
              {[
                { id: 'all', label: 'All Channels', icon: Filter },
                { id: 'whatsapp', label: 'WhatsApp', icon: MessageSquare },
                { id: 'chatwoot', label: 'Chatwoot', icon: MessageSquare },
                { id: 'gmail', label: 'Email / Gmail', icon: Mail },
                { id: 'instagram', label: 'Instagram', icon: MessageSquare },
                { id: 'sms', label: 'SMS', icon: MessageSquare },
                { id: 'widget', label: 'Widget', icon: MessageSquare },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedChannel(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition ${
                    selectedChannel === item.id
                      ? 'bg-emerald-900/50 text-emerald-200 border border-emerald-700/40'
                      : 'hover:bg-emerald-900/20 text-emerald-100/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <item.icon className="w-4 h-4 text-emerald-400" />
                    <span>{item.label}</span>
                  </div>
                  {item.id !== 'all' && (
                    <span className="text-[10px] text-emerald-400 font-mono">
                      {stats.channels[item.id] || 0}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* PANE 2: CONVERSATION LIST FEED */}
      {/* ───────────────────────────────────────────────────────────── */}
      <div className={`${mobilePane === 'thread' ? 'hidden md:flex' : 'flex'} w-full md:w-80 border-r border-emerald-950/60 bg-[#141E1B] flex-col shrink-0`}>
        <div className="p-3 border-b border-emerald-950/60 space-y-2">
          <button
            onClick={() => setIsNewChatOpen(true)}
            className="w-full bg-[#F0C05A] hover:bg-[#e0b04a] text-[#16201D] font-bold text-xs py-2 rounded-lg flex items-center justify-center gap-1.5 transition shadow-md"
          >
            <Plus className="w-4 h-4" />
            <span>New Test Chat</span>
          </button>

          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-emerald-500" />
            <input
              type="text"
              placeholder="Search contact or content..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#1A2623] border border-emerald-900/60 rounded-lg pl-9 pr-3 py-1.5 text-xs text-emerald-100 placeholder-emerald-600 focus:outline-none focus:border-[#F0C05A]/60"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-emerald-950/40">
          {loading ? (
            <div className="p-6 text-center text-xs text-emerald-500 flex flex-col items-center gap-2">
              <RefreshCw className="w-5 h-5 animate-spin" />
              <span>Loading conversations...</span>
            </div>
          ) : visibleConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-emerald-500 space-y-3">
              <p>No conversations found.</p>
              <button
                onClick={() => setIsNewChatOpen(true)}
                className="px-3 py-1.5 bg-[#F0C05A]/20 text-[#F0C05A] rounded-lg border border-[#F0C05A]/30 text-xs font-semibold"
              >
                Start First Test Chat
              </button>
            </div>
          ) : (
            visibleConversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => {
                  setSelectedConvId(conv.id);
                  setMobilePane('thread');
                }}
                className={`p-3 cursor-pointer transition flex flex-col gap-1.5 ${
                  selectedConvId === conv.id
                    ? 'bg-[#1E2C28] border-l-4 border-l-[#F0C05A]'
                    : 'hover:bg-emerald-950/40'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getChannelIcon(conv.channel_type)}
                    <span className="font-semibold text-xs text-emerald-100 truncate max-w-[130px]">
                      {conv.metadata?.sender_name || conv.contact_id}
                    </span>
                  </div>
                  <span suppressHydrationWarning className="text-[10px] text-emerald-500 shrink-0 font-mono">
                    {conv.updated_at ? new Date(conv.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>

                <p className="text-xs text-emerald-300/70 line-clamp-2 leading-relaxed">
                  {conv.last_message || conv.summary || 'Inbound conversation started'}
                </p>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] bg-emerald-950 px-2 py-0.5 rounded text-emerald-400 font-medium">
                    {conv.employee_name || 'Sarah'}
                  </span>
                  <StatusBadge
                    label={conv.status.replace(/_/g, ' ')}
                    tone={
                      conv.status === 'open'
                        ? 'success'
                        : conv.status === 'needs_attention'
                          ? 'warning'
                          : 'neutral'
                    }
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* PANE 3: CHAT CANVAS & CONTEXT DRAWER */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeConv ? (
        <div className={`${mobilePane === 'list' ? 'hidden md:flex' : 'flex'} flex-1 overflow-hidden`}>
          {/* Main Chat Canvas */}
          <div className="flex-1 flex flex-col bg-[#121917] min-w-0">
            {/* Conversation Header */}
            <div className="p-4 border-b border-emerald-950/60 bg-[#16201D] flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  className="md:hidden p-1.5 rounded-lg border border-emerald-800/40 text-emerald-300"
                  onClick={() => setMobilePane('list')}
                  aria-label="Back to inbox list"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="w-9 h-9 rounded-full bg-emerald-900/60 flex items-center justify-center border border-emerald-700/40">
                  {getChannelIcon(activeConv.channel_type)}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-emerald-50">
                    {activeConv.metadata?.sender_name || activeConv.contact_id}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-emerald-400/70">
                    <span>{activeConv.contact_id}</span>
                    <span>•</span>
                    <span className="capitalize">{activeConv.channel_type}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <select
                  value={activeConv.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className="bg-[#1D2925] border border-emerald-900/80 text-xs rounded-lg px-2.5 py-1.5 text-emerald-200 focus:outline-none focus:border-[#F0C05A]"
                >
                  <option value="open">Status: Open</option>
                  <option value="needs_attention">Status: Needs Attention</option>
                  <option value="resolved">Status: Resolved</option>
                </select>

                <div className="flex items-center gap-1.5 bg-emerald-950/80 px-3 py-1.5 rounded-lg border border-emerald-800/40 text-xs text-emerald-300">
                  <Bot className="w-4 h-4 text-[#F0C05A]" />
                  <span>AI Assigned: <strong>{activeConv.employee_name || 'Sarah'}</strong></span>
                </div>
              </div>
            </div>

            {/* Chat Messages Stream */}
            <div className="flex-1 p-4 overflow-y-auto space-y-4">
              {messagesLoading ? (
                <div className="text-center text-xs text-emerald-500 py-8">Loading message history...</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-xs text-emerald-500 py-8">No messages in this thread yet.</div>
              ) : (
                messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  return (
                    <div key={msg.id} className={`flex flex-col ${isUser ? 'items-start' : 'items-end'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-emerald-500">
                          {isUser ? 'Customer' : msg.role === 'human_agent' ? 'Human Agent' : `AI (${activeConv.employee_name || 'Sarah'})`}
                        </span>
                        <span suppressHydrationWarning className="text-[10px] text-emerald-600 font-mono">
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div
                        className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed ${
                          isUser
                            ? 'bg-[#1C2825] text-emerald-100 rounded-tl-none border border-emerald-900/60'
                            : 'bg-[#F0C05A] text-[#16201D] font-medium rounded-tr-none shadow-lg'
                        }`}
                      >
                        {isUser ? msg.content : <FormattedMarkdownResponse content={msg.content} />}
                      </div>
                    </div>
                  );
                })
              )}
              {sendingReply && replyAsCustomer && (
                <div className="flex items-center gap-2 text-xs text-amber-400 italic">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#F0C05A]" />
                  <span>AI Employee {activeConv.employee_name || 'Sarah'} is thinking & responding...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Message Input Box */}
            <form onSubmit={handleSendMessage} className="p-3 border-t border-emerald-950/60 bg-[#16201D] space-y-2">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setReplyAsCustomer(false)}
                    className={`text-[10px] font-bold px-2 py-0.5 rounded transition ${
                      !replyAsCustomer ? 'bg-[#F0C05A] text-[#16201D]' : 'bg-emerald-950 text-emerald-400'
                    }`}
                  >
                    Send as Human Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplyAsCustomer(true)}
                    className={`text-[10px] font-bold px-2 py-0.5 rounded transition ${
                      replyAsCustomer ? 'bg-amber-500 text-heading' : 'bg-emerald-950 text-emerald-400'
                    }`}
                  >
                    Simulate Customer (Triggers Live AI Response)
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={
                    replyAsCustomer
                      ? "Simulate customer message (AI employee will reply live)..."
                      : "Type a response as human agent..."
                  }
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  className="flex-1 bg-[#1C2825] border border-emerald-900/80 rounded-xl px-4 py-2.5 text-xs text-emerald-100 placeholder-emerald-600 focus:outline-none focus:border-[#F0C05A]"
                />
                <button
                  type="submit"
                  disabled={sendingReply || !replyContent.trim()}
                  className="bg-[#F0C05A] hover:bg-[#e0b04a] disabled:opacity-50 text-[#16201D] font-bold text-xs px-4 py-2.5 rounded-xl flex items-center gap-2 transition"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{sendingReply ? 'Sending...' : 'Send'}</span>
                </button>
              </div>
            </form>
          </div>

          {/* Context Drawer */}
          <div className="hidden lg:block w-72 border-l border-emerald-950/60 bg-[#16201D] p-4 space-y-6 overflow-y-auto">
            <div>
              <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-3">
                Customer Context
              </h4>
              <div className="bg-[#1C2825] p-3 rounded-xl border border-emerald-900/60 space-y-2.5 text-xs">
                <div>
                  <span className="text-emerald-500 block text-[10px]">Contact Identity</span>
                  <span className="font-mono text-emerald-200">{activeConv.contact_id}</span>
                </div>
                <div>
                  <span className="text-emerald-500 block text-[10px]">Channel</span>
                  <span className="capitalize text-emerald-200">{activeConv.channel_type}</span>
                </div>
                <div>
                  <span className="text-emerald-500 block text-[10px]">Started At</span>
                  <span className="text-emerald-200">
                    {new Date(activeConv.started_at).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-3">
                Assigned AI Agent
              </h4>
              <div className="bg-[#1C2825] p-3 rounded-xl border border-emerald-900/60 space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#F0C05A]" />
                  <span className="font-bold text-emerald-100">{activeConv.employee_name || 'Sarah'}</span>
                </div>
                <p className="text-[11px] text-emerald-400">{activeConv.employee_role || 'Sales Representative'}</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-center p-8 bg-[#121917]">
          <div className="max-w-md space-y-4">
            <MessageSquare className="w-12 h-12 text-emerald-600 mx-auto" />
            <h3 className="text-lg font-bold text-emerald-100 font-serif">No Conversation Selected</h3>
            <p className="text-xs text-emerald-500">
              Select a conversation from the list or start a new test chat to test live AI responses.
            </p>
            <button
              onClick={() => setIsNewChatOpen(true)}
              className="px-4 py-2 bg-[#F0C05A] hover:bg-[#e0b04a] text-[#16201D] font-bold text-xs rounded-xl shadow-md"
            >
              Start New Test Chat
            </button>
          </div>
        </div>
      )}

      {/* Start New Test Chat Modal */}
      {isNewChatOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#16201D] border border-emerald-900/80 rounded-3xl p-6 max-w-lg w-full shadow-2xl space-y-5 text-emerald-100">
            <div className="flex items-center justify-between border-b border-emerald-900/60 pb-3">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-[#F0C05A]" />
                <h3 className="text-lg font-serif font-bold text-emerald-50">Start Live AI Test Chat</h3>
              </div>
              <button onClick={() => setIsNewChatOpen(false)} className="text-emerald-500 hover:text-emerald-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateNewChat} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                  Customer Contact Identity
                </label>
                <input
                  type="text"
                  placeholder="e.g. +1 555-0199 or Alex Smith"
                  value={newChatContact}
                  onChange={(e) => setNewChatContact(e.target.value)}
                  className="w-full px-4 py-2 bg-[#1C2825] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                    Channel
                  </label>
                  <select
                    value={newChatChannel}
                    onChange={(e) => setNewChatChannel(e.target.value)}
                    className="w-full px-3 py-2 bg-[#1C2825] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]"
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="gmail">Gmail / Email</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                    Assigned AI Employee
                  </label>
                  <select
                    value={newChatEmployeeId}
                    onChange={(e) => setNewChatEmployeeId(e.target.value)}
                    className="w-full px-3 py-2 bg-[#1C2825] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]"
                  >
                    <option value="">Default Active AI</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} ({emp.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                  Customer Initial Message *
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="e.g. Hi, I am interested in your services and would like to know pricing and schedule a call."
                  value={newChatInitialMessage}
                  onChange={(e) => setNewChatInitialMessage(e.target.value)}
                  className="w-full px-4 py-2 bg-[#1C2825] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 focus:outline-none focus:border-[#F0C05A]"
                />
              </div>

              <div className="pt-2 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsNewChatOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-emerald-400 hover:text-emerald-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingChat || !newChatInitialMessage.trim()}
                  className="px-5 py-2 bg-[#F0C05A] hover:bg-[#e0b04a] text-[#16201D] font-bold text-xs rounded-xl shadow-md disabled:opacity-50 flex items-center gap-1.5"
                >
                  {creatingChat ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Creating & Generating AI Reply...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5" />
                      <span>Launch Test Chat & Trigger AI</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
