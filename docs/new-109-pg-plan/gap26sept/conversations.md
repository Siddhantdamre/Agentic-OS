# Conversations & Inbox Audit

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|---|---|---|---|---|
| 1 | 150 correlated subqueries on inbox list | P0 | `api/conversations/route.ts` | 🟢 | `LEFT JOIN LATERAL` + `COUNT(*) OVER()`; session org `$1`; parameterized filters. |
| 2 | Hardcoded LIMIT 50, no pagination | P0 | `route.ts` + inbox page | 🟢 | Keyset cursor `(updated_at, id)`; default 30 / max 100; UI load-more. |
| 3 | Human takeover does not pause AI | P0 | `messages/route.ts` + `[id]/route.ts` + `091_*.sql` | 🟢 | `ai_paused` + `ai_paused_until`; human reply sets +2h; PATCH `pauseAi`; API skips `fireInboundAgent` while paused. |
| 4 | Role taxonomy `user` vs `customer` | P1 | `messages/route.ts` + UI | 🟢 | Boundary maps `customer`→`user` without rewriting history; UI accepts both. |
| 5 | `metadata::text ILIKE` full scan | P1 | `conversations/route.ts` | 🟢 | JSONB key paths only (`sender_name`/`phone`/`email`). |
| 6 | Attachments / assigned_user / unread / notes / SLA | P1–P2 | `091_*.sql` + messages/PATCH/UI | 🟢 | Columns + unread increment/clear, `is_internal` notes, attachments JSONB, `assigned_user_id`, SLA deadline/badge, reopen on inbound API message. |
| 7 | Message order collisions | P1 | `messages/route.ts` GET | 🟢 | `ORDER BY created_at ASC, id ASC`. |
| 8 | Explicit Take Over toggle | P1 | inbox page + PATCH | 🟢 | Header Take over / Resume AI. |
| 9 | Webhook employee/pause enforcement | P0 | `api/webhooks/*` | 🟢 | Verified `551f4ab`: WhatsApp/Chatwoot preserve `employee_id` via `resolveEmployeeForConversation` and skip `fireInboundAgent` while `ai_paused_until > now()`. No rewrite needed. |
| 10 | Attachment URL scheme not validated (CH-S04) | P1 | `messages/route.ts` `parseAttachments`, `conversations/page.tsx` | 🟢 | http(s) only on write and render (`lib/safe-url.ts`); jest test. |
| 11 | Any role can reply / pause / resolve / create channels; no audit (CH-S05, CH-E07) | P1 | `api/conversations/**`, `lib/conversation-audit.ts` | 🟡 | RBAC owner/admin/member + audit rows in code. Audit kinds need the CHECK migration from the other session before rows persist; stream routes not covered here. |
| 12 | Unbounded `GET /messages`; raw `err.message` leaked on 500 | P1 | `messages/route.ts` | 🟢 | GET returns newest `limit` rows (default 200, max 500, `before` cursor) oldest-first; GET/POST 500s (messages, list, create, PATCH) log with `errorId` and return a generic message. Typecheck clean; not live-exercised. Inbox has a "Load older messages" button (keyset on `before`, deduped by id). Not exercised in a live browser. |

## Status: working (inbox LATERAL, cursor, takeover, unread/notes/SLA/attachments, webhook pause+employee)



The conversations domain (`/conversations`, `/api/conversations`, `/api/conversations/[id]`, and `/api/conversations/[id]/messages`) powers the unified human-in-the-loop customer communication inbox across WhatsApp, Chatwoot, Email, and Widget channels. Messages and conversations are persistently stored in PostgreSQL with strict session-scoped multi-tenancy, and new messages automatically publish real-time events to Redis.

However, **the inbox query suffers from severe N*3 correlated subquery bottlenecks**, lacks pagination beyond 50 records, lacks an explicit "AI Pause / Human Takeover" lock, casts JSONB `metadata::text ILIKE` causing full table scans, and lacks first-class multimedia attachment handling.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Channel Scoped Inbox Queries**:
   - `apps/dashboard/app/api/conversations/route.ts:12-140` — `GET /api/conversations`:
     - Session-scoped tenant extraction via `getScopedClient()` (`route.ts:14`).
     - Multi-channel filtering: Supports filtering by channel type or matching messages across channels (`mk.channel_key = $param`, `route.ts:48-60`).
     - Parameterized search query with escaped LIKE wildcards (`escapeLike`, line 8), safely handling user input without SQL injection vulnerabilities.
     - Aggregates real status breakdowns (`open`, `resolved`, `pending_human`, `needs_attention`) and channel volume distributions (`route.ts:78-90`).
2. **Chronological Message History Retrieval**:
   - `apps/dashboard/app/api/conversations/[id]/messages/route.ts:33-76` — `GET /api/conversations/[id]/messages`:
     - Retrieves chronological message history (`ORDER BY created_at ASC`) along with conversation status, channel metadata, and assigned AI employee name/role.
     - Immediately releases the DB client in `finally { client.release(); }` (line 67) to prevent pool leaks.
3. **Outbound Dispatch & Agent Turn Invocation**:
   - `apps/dashboard/app/api/conversations/[id]/messages/route.ts:79-180` — `POST /api/conversations/[id]/messages`:
     - Validates and normalizes message roles (`user`, `customer`, `human_agent`, `assistant`).
     - Broadcasts new message events to `realtimeHub.publish()` for instant inbox updates.
     - Triggers external outbound dispatch via `sendChannelReply()` (`channel-outbound.ts`) to deliver messages back to WhatsApp or Chatwoot.
     - Fires the in-process or Temporal AI loop (`fireInboundAgent()`) when user/customer messages arrive.
4. **Live Realtime Inbox Integration**:
   - `apps/dashboard/app/(dashboard)/conversations/page.tsx:102-180`:
     - Live SSE integration via `/api/stream/events` for `message_received`, `conversation_updated`, and `needs_attention`.
     - Debounced 500ms refetching and background tab throttling via `document.hidden`.
5. **Connection Pool Safety**:
   - `apps/dashboard/app/api/conversations/route.ts:138` and `[id]/messages/route.ts:67, 178`:
     - Releases database clients promptly in `finally` blocks.

---

## What's broken (file:line, user impact, code/schema cause)

1. **150-Correlated Subquery Bottleneck in Inbox Query (`apps/dashboard/app/api/conversations/route.ts:36-38`) (P0)**:
   - *User Impact*: Multi-second inbox load latency and pool starvation under concurrent team usage.
   - *Code Cause*: The main query executes three correlated subqueries per row:
     ```sql
     (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY created_at DESC LIMIT 1) as last_message,
     (SELECT created_at FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY created_at DESC LIMIT 1) as last_message_at,
     (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1) as message_count
     ```
     For a 50-row page, PostgreSQL executes 150 separate scans over `messages`. As conversation history grows, this saturates CPU and exhausts connection pool slots (`max: 10`).
2. **Hardcoded LIMIT 50 with Zero Pagination (`apps/dashboard/app/api/conversations/route.ts:74`) (P0)**:
   - *User Impact*: Permanent loss of visibility for older open conversations.
   - *Code Cause*: The query hardcodes `LIMIT 50` without cursor, offset, or page parameters. Active businesses with >50 open tickets cannot reach the rest of their queue.
3. **Race Condition: Human Takeover vs Autonomous AI Replies (`apps/dashboard/app/api/conversations/[id]/messages/route.ts:160-220`) (P0)**:
   - *User Impact*: Human agent and AI employee reply simultaneously to the customer, sending conflicting information.
   - *Code Cause*: When a human operator types a reply, the conversation lacks an explicit "AI Paused" lock. If an incoming message previously launched a background Temporal turn, both the human and AI reply to the customer within seconds.
4. **Full Table Scan on JSONB Text Search (`apps/dashboard/app/api/conversations/route.ts:69`) (P1)**:
   - *User Impact*: Severe query degradation when searching messages.
   - *Code Cause*: `OR c.metadata::text ILIKE $param` casts the JSONB column to text on every row, completely bypassing B-tree indices and forcing a sequential table scan.
5. **Role Taxonomy Desynchronization Across Channels (`apps/dashboard/app/api/conversations/[id]/messages/route.ts:15-30`)**:
   - *User Impact*: Visual glitches and inconsistent message styling in the inbox UI.
   - *Code Cause*: WhatsApp webhooks save incoming customer messages as `role: 'user'`, while the website widget saves them as `role: 'customer'`. In `page.tsx`, CSS styles differ between the two, resulting in inconsistent alignment.
6. **Total Absence of Structured Multimedia Attachments**:
   - *User Impact*: Customers sending photos, rental lease PDFs, or WhatsApp voice notes have their messages broken or lost.
   - *Code Cause*: `messages` only has a plain text `content` column. Missing an `attachments` JSONB column and media storage pipeline.
7. **No Direct Assignment to Human Agents**:
   - *User Impact*: Inability to assign escalated tickets to specific team members.
   - *Code Cause*: Schema stores `employee_id` (AI employee) but lacks `assigned_user_id` (human staff).
8. **Missing Unread Message Counters**:
   - *User Impact*: Operators cannot see which conversations have unread customer replies without opening each one.
   - *Code Cause*: Schema lacks an `unread_count` integer column maintained on new message insertion.
9. **No Internal Staff Private Notes**:
   - *User Impact*: Team members cannot leave internal notes on a conversation without sending them to the external customer.
   - *Code Cause*: `messages` lacks an `is_internal` boolean flag.
10. **Timestamp Ordering Collisions on Rapid Bursts**:
    - *User Impact*: Messages flipping out of chronological order when sent in the same millisecond.
    - *Code Cause*: `ORDER BY created_at ASC` without tie-breaking on `id ASC`.
11. **Static SLA Status Without Countdown**:
    - *User Impact*: High-priority customer tickets sit unanswered without visual urgency cues.
    - *Code Cause*: Missing SLA expiration timers and breach badges.
12. **Inability to Reopen Resolved Conversations on Inbound Reply**:
    - *User Impact*: Returning customers send a message that remains archived in "Resolved".
    - *Code Cause*: Inbound webhooks do not automatically flip `status = 'open'` when a customer sends a follow-up message.
13. **Inbound Webhook Arbitrary Employee Assignment Overriding Conversation Assignee (`apps/dashboard/app/api/webhooks/whatsapp/route.ts:204-209, 291-305`) (P0)**:
    - *User Impact*: Personality and context jarring for customers. A customer speaking with a specific Sales employee suddenly receives automated replies from a Support employee persona on their next message.
    - *Code Cause*: `whatsapp/route.ts:204` queries `SELECT id, name, role, persona, tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1` without ordering or checking whether the conversation already has an assigned `employee_id`. When creating the agent turn job, it passes this arbitrary employee's persona instead of the conversation's existing assigned employee.
    - *Fix*: Lookup the conversation's existing `employee_id` first. If present, load that specific employee's persona; only fall back to the default employee if none is assigned.
14. **Lack of `ai_paused_until` Enforcement in Inbound Agent Dispatch (`apps/dashboard/app/api/webhooks/whatsapp/route.ts:219-322`) (P0)**:
    - *User Impact*: AI intrudes into ongoing live human conversations.
    - *Code Cause*: The webhook checks `WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved'`, but never checks if `ai_paused_until > NOW()` or if `status = 'pending_human'`. It automatically schedules `fireInboundAgent(job)` on every single inbound customer text.
    - *Fix*: Check `ai_paused_until > NOW()` and skip pushing to `agentJobs` when the human agent cooldown is active.

---

## What's missing vs full vision

1. **Explicit Human Takeover / AI Snooze Mode**:
   - Prominent toggle in the conversation header: *"Pause AI Employee"*. When toggled on, sets `ai_paused = true` and `ai_paused_until = NOW() + INTERVAL '24 hours'`, halting all background AI turns.
2. **Optimized `JOIN LATERAL` Inbox Query with Cursor Pagination**:
   - Replacing correlated subqueries with a single high-performance LATERAL join and keyset cursor pagination (`updated_at_id`).
3. **Structured Multimedia & Voice Note Player**:
   - In-app rendering of PDF documents, image carousels, and an integrated audio player for WhatsApp `.ogg` voice notes.
4. **Internal Private Notes Tab**:
   - Ability for human support agents to toggle "Internal Note" to write yellow-highlighted messages visible only to colleagues.
5. **Canned Quick Replies & Snippets**:
   - Macro snippets triggered via `/` shortcuts (e.g. `/hours`, `/pricing`, `/tour-link`).
6. **Real-Time Typing Indicators & WhatsApp Delivery Ticks**:
   - Visual display of `sent` (single grey), `delivered` (double grey), and `read` (double blue) checkmarks on WhatsApp messages.
7. **Customer Context Slide-Over Drawer**:
   - Right-side panel showing CRM deal value, verified email/phone, lifetime conversation history, and active open loops.
8. **Automated SLA Breach Timer**:
   - Real-time countdown timer highlighting inquiries unanswered for >15 minutes.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Inbox Hardening & Takeover (`046_conversations_inbox_hardening.sql`)
```sql
-- 1. Add human assignment, AI pause, and unread counters
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sentiment TEXT DEFAULT 'neutral' CHECK (sentiment IN ('positive', 'neutral', 'frustrated', 'escalated'));

-- 2. Add structured attachments and internal notes to messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'sent' CHECK (delivery_status IN ('sent', 'delivered', 'read', 'failed'));

-- 3. Composite index for rapid cursor pagination
CREATE INDEX IF NOT EXISTS idx_conversations_inbox_perf
  ON conversations (org_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_ordered
  ON messages (org_id, conversation_id, created_at DESC, id DESC);
```

### 2. High-Performance Consolidated LATERAL Inbox Query (`apps/dashboard/app/api/conversations/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get('cursor');
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '30', 10), 1), 50);
  const status = searchParams.get('status');

  try {
    let cursorClause = '';
    const params: any[] = [orgId, limit + 1];

    if (cursor) {
      const [cursorTime, cursorId] = cursor.split('_');
      params.push(new Date(cursorTime).toISOString(), cursorId);
      cursorClause = `AND (c.updated_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    let statusClause = '';
    if (status) {
      params.push(status);
      statusClause = `AND c.status = $${params.length}`;
    }

    const query = `
      SELECT c.id, c.channel, c.status, c.updated_at, c.ai_paused, c.ai_paused_until,
             c.unread_count, c.sentiment, c.assigned_user_id,
             lm.content AS last_message,
             lm.created_at AS last_message_at,
             lm.total_messages
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT content, created_at, COUNT(*) OVER() AS total_messages
        FROM messages m
        WHERE m.conversation_id = c.id AND m.org_id = $1 AND m.is_internal = false
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) lm ON true
      WHERE c.org_id = $1 ${statusClause} ${cursorClause}
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT $2
    `;

    const res = await client.query(query, params);
    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore && items.length > 0
      ? `${items[items.length - 1].updated_at.toISOString()}_${items[items.length - 1].id}`
      : null;

    return NextResponse.json({ conversations: items, nextCursor });
  } finally {
    client.release();
  }
}
```

### 3. Human Takeover & AI Pause Route (`apps/dashboard/app/api/conversations/[id]/takeover/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { broadcastToOrg } from '@/lib/realtime-hub';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const { paused, durationHours = 24 } = await req.json();

    const res = await client.query(
      `UPDATE conversations
       SET ai_paused = $1,
           ai_paused_until = CASE WHEN $1 = true THEN NOW() + ($2 || ' hours')::interval ELSE NULL END,
           ai_paused_by_user_id = CASE WHEN $1 = true THEN $3 ELSE NULL END,
           updated_at = NOW()
       WHERE id = $4 AND org_id = $5
       RETURNING id, ai_paused, ai_paused_until`,
      [paused, durationHours, userId, params.id, orgId]
    );

    if (res.rowCount === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    broadcastToOrg(orgId, {
      type: 'conversation_takeover_updated',
      conversationId: params.id,
      aiPaused: paused
    });

    return NextResponse.json({ success: true, conversation: res.rows[0] });
  } finally {
    client.release();
  }
}
```

### 4. Interactive 3-Pane Unified Inbox UI (`apps/dashboard/app/(dashboard)/conversations/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Send,
  UserCheck,
  CheckCircle2,
  Clock,
  Paperclip,
  FileText,
  Volume2
} from 'lucide-react';
import { toast } from 'sonner';

interface Conversation {
  id: string;
  channel: string;
  status: string;
  last_message: string;
  last_message_at: string;
  ai_paused: boolean;
  unread_count: number;
}

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
  is_internal: boolean;
  attachments?: Array<{ type: string; url: string; name: string }>;
}

export default function UnifiedInboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetch('/api/conversations')
      .then((res) => res.json())
      .then((data) => {
        setConversations(data.conversations || []);
        if (data.conversations?.[0]) setSelectedId(data.conversations[0].id);
      });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    fetch(`/api/conversations/${selectedId}/messages`)
      .then((res) => res.json())
      .then((data) => setMessages(data.messages || []));
  }, [selectedId]);

  const activeConv = conversations.find((c) => c.id === selectedId);

  const toggleTakeover = async () => {
    if (!activeConv) return;
    const newPaused = !activeConv.ai_paused;
    const res = await fetch(`/api/conversations/${activeConv.id}/takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: newPaused })
    });
    if (res.ok) {
      toast.success(newPaused ? 'AI paused. You are in manual takeover.' : 'AI autonomy resumed.');
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConv.id ? { ...c, ai_paused: newPaused } : c))
      );
    }
  };

  const handleSend = async () => {
    if (!replyText.trim() || !selectedId) return;
    setSending(true);
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'human_agent',
          content: replyText.trim(),
          isInternal
        })
      });
      if (res.ok) {
        setReplyText('');
        const data = await res.json();
        setMessages((prev) => [...prev, data.message]);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-slate-950">
      {/* Pane 1: Conversation List */}
      <div className="w-80 border-r border-slate-800 flex flex-col bg-slate-900/60">
        <div className="p-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-emerald-400" />
            Customer Inbox
          </h2>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-slate-800/60">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`w-full p-4 text-left transition flex flex-col gap-1 ${
                selectedId === c.id ? 'bg-slate-800/80' : 'hover:bg-slate-850'
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200 capitalize">{c.channel}</span>
                <span className="text-slate-500 font-mono text-[10px]">
                  {new Date(c.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="text-xs text-slate-400 line-clamp-1">{c.last_message || 'New conversation'}</p>
              {c.ai_paused && (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded w-fit mt-1">
                  AI Paused (Human Takeover)
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Pane 2: Message Thread */}
      <div className="flex-1 flex flex-col bg-slate-900/30">
        {activeConv && (
          <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
            <div>
              <div className="text-sm font-semibold text-slate-100">Conversation {activeConv.id.slice(0, 8)}</div>
              <div className="text-xs text-slate-400">Channel: {activeConv.channel}</div>
            </div>

            <button
              onClick={toggleTakeover}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeConv.ai_paused
                  ? 'bg-amber-600 hover:bg-amber-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              {activeConv.ai_paused ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
              {activeConv.ai_paused ? 'Resume AI Agent' : 'Take Over (Pause AI)'}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.map((m) => {
            const isUser = m.role === 'user' || m.role === 'customer';
            return (
              <div key={m.id} className={`flex flex-col ${isUser ? 'items-start' : 'items-end'}`}>
                <div
                  className={`max-w-md p-3.5 rounded-xl text-xs space-y-2 ${
                    m.is_internal
                      ? 'bg-amber-950/40 border border-amber-600/40 text-amber-200'
                      : isUser
                      ? 'bg-slate-800 text-slate-200 rounded-bl-none'
                      : 'bg-emerald-600 text-white rounded-br-none'
                  }`}
                >
                  {m.is_internal && <div className="font-semibold text-[10px] uppercase text-amber-400">Internal Staff Note</div>}
                  <p>{m.content}</p>
                </div>
                <span className="text-[10px] text-slate-500 mt-1 font-mono">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            );
          })}
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/80 space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsInternal(!isInternal)}
              className={`text-xs px-2.5 py-1 rounded font-medium transition ${
                isInternal ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {isInternal ? 'Internal Note Mode' : 'External Reply'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={isInternal ? 'Type an internal note visible only to your team...' : 'Reply to customer...'}
              className="flex-1 px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            />
            <button
              disabled={sending || !replyText.trim()}
              onClick={handleSend}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg transition"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Check `ai_paused_until` in inbound webhooks before dispatching `fireInboundAgent` to prevent AI from interrupting active human agents.
- **P0**: Preserve conversation-assigned `employee_id` in webhook agent dispatch rather than selecting an arbitrary active employee with `LIMIT 1`.
- **P0**: Fix human takeover race condition so human agent replies immediately pause autonomous AI responses on that conversation.
- **P0**: Eliminate the 150 correlated subqueries per inbox load using `JOIN LATERAL` to prevent database pool starvation.
- **P0**: Implement cursor pagination to remove the hardcoded 50-conversation ceiling.
- **P1**: Normalize role identifiers across all channels (`'user'` vs `'customer'`).
- **P1**: Add structured attachment support (`messages.attachments`) for images, PDFs, and audio voice notes.
- **P2**: Deploy `046_conversations_inbox_hardening.sql` with indices and takeover columns.
- **P2**: Surface SLA breach badges and WhatsApp delivery checkmarks in the inbox UI.
