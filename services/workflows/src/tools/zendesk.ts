import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, getNangoConnection, notConnected } from './shared.js';

const ACTIONS = ['fetch_tickets', 'create_support_ticket', 'update_ticket'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('update') || a.includes('edit') || a.includes('create')) return 'draft';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const zendeskConnId = `${orgId}_zendesk`;
  const zendeskConn = await getNangoConnection(zendeskConnId, 'zendesk');
  const zendeskToken = zendeskConn?.credentials?.raw?.access_token || zendeskConn?.credentials?.access_token || null;
  if (zendeskToken) {
    try {
      const subdomain = payload.subdomain
        || process.env.ZENDESK_SUBDOMAIN
        || zendeskConn?.connection_config?.subdomain
        || zendeskConn?.metadata?.subdomain;
      if (!subdomain) {
        return apiError('zendesk', actionName, timestamp, 'Zendesk subdomain is required (payload, ZENDESK_SUBDOMAIN, or Nango metadata).');
      }
      if (subdomain) {
        if (actionName.includes('update') || actionName.includes('edit')) {
          const ticketId = payload.ticketId || payload.id;
          if (!ticketId) {
            return { tool: 'zendesk', action: 'update_ticket', status: 'error' as const, message: 'Ticket id (ticketId) is required to update.', data: null, timestamp };
          }
          const ticket: any = {};
          if (payload.status) ticket.status = payload.status;
          if (payload.priority) ticket.priority = payload.priority;
          if (payload.subject) ticket.subject = payload.subject;
          if (payload.assignee_id) ticket.assignee_id = payload.assignee_id;
          if (payload.comment) ticket.comment = { body: payload.comment };
          if (Object.keys(ticket).length === 0) {
            return { tool: 'zendesk', action: 'update_ticket', status: 'error' as const, message: 'No updatable fields supplied (try status, priority, subject, comment, assignee_id)', data: null, timestamp };
          }
          const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${zendeskToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
          });
          if (zdRes.ok) {
            const zdData = await zdRes.json();
            return {
              tool: 'zendesk',
              action: 'update_ticket',
              status: 'executed' as const,
              message: `Updated Zendesk ticket #${ticketId}`,
              data: { ticketId: zdData.ticket?.id, status: zdData.ticket?.status, priority: zdData.ticket?.priority, subject: zdData.ticket?.subject },
              timestamp,
            };
          }
          const zdErr = await zdRes.text();
          return { tool: 'zendesk', action: 'update_ticket', status: 'error' as const, message: `Zendesk update failed: ${zdRes.status} ${zdErr.slice(0, 200)}`, data: null, timestamp };
        }
        if (actionName.includes('list') || actionName.includes('fetch')) {
          const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json?sort_by=updated_at&sort_order=desc&per_page=10`, {
            headers: { Authorization: `Bearer ${zendeskToken}`, Accept: 'application/json' },
          });
          if (zdRes.ok) {
            const zdData = await zdRes.json();
            return {
              tool: 'zendesk',
              action: 'fetch_tickets',
              status: 'executed' as const,
              message: `Fetched ${zdData.tickets?.length || 0} tickets from Zendesk`,
              data: { tickets: zdData.tickets || [] },
              timestamp,
            };
          }
        } else {
          const subject = payload.subject || 'Support Request via DareX AI';
          const description = payload.description || payload.message || 'Customer support request';
          const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${zendeskToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: { subject, comment: { body: description }, priority: payload.priority || 'normal' } }),
          });
          if (zdRes.ok) {
            const zdData = await zdRes.json();
            return {
              tool: 'zendesk',
              action: 'create_support_ticket',
              status: 'executed' as const,
              message: `✅ Created Zendesk ticket: ${subject}`,
              data: { ticketId: zdData.ticket?.id, status: zdData.ticket?.status, subject },
              timestamp,
            };
          }
        }
      }
    } catch (e: any) {
      console.error('[Zendesk] API error:', e.message);
    }
  }
  return notConnected('zendesk', actionName, timestamp);
}

export const zendesk: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
