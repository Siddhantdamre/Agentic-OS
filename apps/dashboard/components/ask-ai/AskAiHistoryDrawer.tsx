'use client';

import React, { useState, useMemo } from 'react';
import {
  History,
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  Check,
  Search,
  X,
  RefreshCw,
  Clock,
  PanelLeftClose,
} from 'lucide-react';

export interface ConversationItem {
  id: string;
  summary: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface AskAiHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  conversations: ConversationItem[];
  currentConversationId: string;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onDeleteConversation: (e: React.MouseEvent, id: string) => void;
  onRenameConversation?: (id: string, newSummary: string) => Promise<void>;
  loading: boolean;
  switchingId: string | null;
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function categorizeDate(dateStr: string): 'Today' | 'Previous 7 Days' | 'Older' {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'Older';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 1 && d.getDate() === now.getDate()) return 'Today';
  if (diffDays < 7) return 'Previous 7 Days';
  return 'Older';
}

export function AskAiHistoryDrawer({
  open,
  onClose,
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  onRenameConversation,
  loading,
  switchingId,
}: AskAiHistoryDrawerProps) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  const startRename = (e: React.MouseEvent, c: ConversationItem) => {
    e.stopPropagation();
    setEditingId(c.id);
    setEditTitle(c.summary || 'New Chat');
  };

  const handleSaveRename = async (e: React.MouseEvent | React.FormEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (!editTitle.trim() || savingRename) return;
    setSavingRename(true);
    try {
      if (onRenameConversation) {
        await onRenameConversation(id, editTitle.trim());
      }
      setEditingId(null);
    } finally {
      setSavingRename(false);
    }
  };

  const cancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
    setEditTitle('');
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLowerCase().trim();
    return conversations.filter((c) => (c.summary || '').toLowerCase().includes(q));
  }, [conversations, search]);

  const grouped = useMemo(() => {
    const groups: { [key in 'Today' | 'Previous 7 Days' | 'Older']?: ConversationItem[] } = {};
    for (const c of filtered) {
      const cat = categorizeDate(c.updated_at || c.created_at);
      if (!groups[cat]) groups[cat] = [];
      groups[cat]!.push(c);
    }
    return groups;
  }, [filtered]);

  return (
    <>
      {/* Mobile Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-40 md:hidden transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* History Drawer / Side Panel */}
      <aside
        className={`${
          open
            ? 'translate-x-0 w-80 max-w-[85vw] opacity-100'
            : '-translate-x-full md:translate-x-0 md:w-0 md:opacity-0 md:overflow-hidden md:border-transparent'
        } fixed md:static inset-y-0 left-0 z-50 md:z-10 bg-white border-r border-cream-300 flex flex-col h-full transition-all duration-300 ease-in-out shadow-2xl md:shadow-none shrink-0`}
        aria-label="Ask AI Chat History"
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-3.5 border-b border-cream-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <History className="w-4 h-4 text-amber-700" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-heading">Chat History</h2>
              <p className="text-[10px] text-slate-500">
                {conversations.length} saved {conversations.length === 1 ? 'chat' : 'chats'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Collapse chat history"
            title="Collapse sidebar"
            className="p-1.5 rounded-lg hover:bg-cream-100 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* Action: New Chat Button */}
        <div className="p-3 border-b border-cream-100">
          <button
            type="button"
            onClick={onNewChat}
            className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-heading font-bold text-xs transition-all shadow-sm active:scale-[0.99] group"
          >
            <span className="flex items-center gap-2">
              <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform duration-200" />
              <span>New Chat</span>
            </span>
            <span className="text-[10px] font-mono bg-black/10 px-1.5 py-0.5 rounded opacity-80">
              New
            </span>
          </button>
        </div>

        {/* Search filter */}
        {conversations.length > 2 && (
          <div className="px-3 pt-2.5 pb-1">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search history…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-cream-50 border border-cream-200 text-xs text-heading placeholder-slate-400 focus:outline-none focus:border-amber-500 transition-colors"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 p-0.5 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-4">
          {loading && conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 text-xs space-y-2">
              <RefreshCw className="w-4 h-4 animate-spin text-amber-600" />
              <span>Loading conversations…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 px-4 space-y-2">
              <div className="w-10 h-10 rounded-2xl bg-cream-100 border border-cream-200 flex items-center justify-center mx-auto text-slate-400">
                <MessageSquare className="w-5 h-5" />
              </div>
              <p className="text-xs font-semibold text-slate-600">
                {search ? 'No matching chats found' : 'No chat history yet'}
              </p>
              <p className="text-[11px] text-slate-400">
                {search ? 'Try a different search term' : 'Click New Chat above to begin'}
              </p>
            </div>
          ) : (
            (['Today', 'Previous 7 Days', 'Older'] as const).map((groupKey) => {
              const items = grouped[groupKey];
              if (!items || items.length === 0) return null;
              return (
                <div key={groupKey} className="space-y-1">
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
                    <span>{groupKey}</span>
                    <span className="text-[9px] font-mono text-slate-400 bg-cream-100 px-1.5 py-0.2 rounded-full">
                      {items.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {items.map((c) => {
                      const isActive = c.id === currentConversationId;
                      const isSwitching = switchingId === c.id;
                      const isEditing = editingId === c.id;

                      if (isEditing) {
                        return (
                          <div
                            key={c.id}
                            className="p-2 rounded-xl border border-amber-500 bg-amber-50/50 space-y-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveRename(e, c.id);
                                if (e.key === 'Escape') cancelRename(e as any);
                              }}
                              autoFocus
                              className="w-full px-2 py-1 text-xs border border-amber-400 rounded-lg bg-white text-heading focus:outline-none"
                            />
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={(e) => handleSaveRename(e, c.id)}
                                disabled={savingRename}
                                className="p-1 text-xs bg-amber-500 hover:bg-amber-600 text-heading rounded-md font-semibold flex items-center gap-1"
                              >
                                <Check className="w-3 h-3" />
                                <span>Save</span>
                              </button>
                              <button
                                type="button"
                                onClick={cancelRename}
                                className="p-1 text-xs bg-cream-200 hover:bg-cream-300 text-slate-600 rounded-md"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={c.id}
                          onClick={() => onSelectConversation(c.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelectConversation(c.id);
                            }
                          }}
                          className={`group relative flex items-start justify-between gap-2 p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                            isActive
                              ? 'bg-amber-500/10 border-amber-500/50 text-heading font-medium shadow-xs border-l-4 border-l-amber-600'
                              : 'bg-white hover:bg-cream-50/90 border-cream-200 hover:border-slate-300 text-slate-700 border-l-4 border-l-transparent'
                          }`}
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-1.5">
                              {isSwitching ? (
                                <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />
                              ) : (
                                <MessageSquare
                                  className={`w-3.5 h-3.5 shrink-0 ${
                                    isActive ? 'text-amber-600' : 'text-slate-400 group-hover:text-slate-600'
                                  }`}
                                />
                              )}
                              <span
                                className={`text-xs truncate ${
                                  isActive ? 'font-semibold text-heading' : 'font-medium text-slate-700'
                                }`}
                                title={c.summary || 'New Chat'}
                              >
                                {c.summary || 'New Chat'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 pl-5 text-[10px] text-slate-400">
                              <span className="flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" />
                                {formatRelativeTime(c.updated_at || c.created_at)}
                              </span>
                              {typeof c.message_count === 'number' && c.message_count > 0 && (
                                <span className="bg-cream-100 px-1.5 py-0.2 rounded text-slate-500 font-mono">
                                  {c.message_count} {c.message_count === 1 ? 'msg' : 'msgs'}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Hover action buttons: Rename & Delete */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0 mt-0.5">
                            {onRenameConversation && (
                              <button
                                type="button"
                                onClick={(e) => startRename(e, c)}
                                aria-label={`Rename chat "${c.summary || 'New Chat'}"`}
                                title="Rename this chat"
                                className="p-1 text-slate-400 hover:text-amber-700 hover:bg-amber-100/60 rounded-md transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => onDeleteConversation(e, c.id)}
                              aria-label={`Delete chat "${c.summary || 'New Chat'}"`}
                              title="Delete this chat"
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
