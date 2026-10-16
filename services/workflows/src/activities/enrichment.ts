/**
 * OE-07: Missing Info Auto-Fill. A contact with a blank phone or title gets
 * backfilled by scanning that contact's inbound Gmail threads for a
 * signature block (extractSignatureFields). Only fills fields that are
 * actually blank — never overwrites a value someone already entered.
 */
import type { ToolExecutionParams, ToolExecutionResult } from '@darex/shared-types';
import { isUndefinedTable, withOrgClient } from '../db.js';
import { extractSignatureFields } from '../tools/gmail.js';

type EmailMessage = { from?: string; body?: string };

/**
 * The gated executor (`executeAutonomousToolAction`), injected by the caller
 * so the Gmail read and the HubSpot write go through the same allowlist,
 * autonomy and audit checks as the call that triggered them (EMP-S02).
 */
export type GatedExecute = (params: ToolExecutionParams) => Promise<ToolExecutionResult>;

export interface BackfillContactFieldsInput {
  orgId: string;
  contactEmail: string;
  /** Who created the contact; the backfill runs as that employee. */
  actor: Pick<ToolExecutionParams, 'toolAllowlist' | 'employeeRole' | 'employeeId' | 'actorUserId' | 'workflowId'>;
  execute: GatedExecute;
}

export interface BackfillContactFieldsResult {
  enriched: boolean;
  fieldsFilled: string[];
  reason?: string;
}

function fromMatchesContact(from: string | undefined, contactEmail: string): boolean {
  if (!from) return false;
  return from.toLowerCase().includes(contactEmail.toLowerCase());
}

export async function backfillContactFieldsActivity(
  input: BackfillContactFieldsInput,
): Promise<BackfillContactFieldsResult> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const existing = await client.query<{ id: string; metadata: Record<string, unknown> }>(
        `SELECT id::text, metadata FROM entities
          WHERE org_id = $1 AND entity_type = 'account' AND metadata->>'email' = $2
          ORDER BY updated_at DESC LIMIT 1`,
        [input.orgId, input.contactEmail],
      );
      const entity = existing.rows[0];
      const missingPhone = !entity || !entity.metadata?.phone;
      const missingTitle = !entity || !entity.metadata?.title;
      if (!missingPhone && !missingTitle) {
        return { enriched: false, fieldsFilled: [], reason: 'no_missing_fields' };
      }

      const fetched = await input.execute({
        ...input.actor,
        tool: 'gmail',
        action: 'fetch_latest_emails',
        payload: { count: 25 },
        orgId: input.orgId,
        source: 'sweep',
      });
      if (!fetched || fetched.status !== 'executed') {
        return { enriched: false, fieldsFilled: [], reason: fetched?.message || 'gmail not connected' };
      }
      const emails = ((fetched.data as { emails?: EmailMessage[] } | null)?.emails || []).filter((e) =>
        fromMatchesContact(e.from, input.contactEmail),
      );
      if (emails.length === 0) {
        return { enriched: false, fieldsFilled: [], reason: 'no_matching_inbound_thread' };
      }

      let phone: string | undefined;
      let title: string | undefined;
      for (const email of emails) {
        const found = extractSignatureFields(email.body || '');
        phone = phone || found.phone;
        title = title || found.title;
        if (phone && title) break;
      }

      const fieldsFilled: string[] = [];
      const patch: Record<string, string> = {};
      if (missingPhone && phone) {
        patch.phone = phone;
        fieldsFilled.push('phone');
      }
      if (missingTitle && title) {
        patch.title = title;
        fieldsFilled.push('title');
      }
      if (fieldsFilled.length === 0) {
        return { enriched: false, fieldsFilled: [], reason: 'no_signature_fields_found' };
      }

      if (entity) {
        const mergedMetadata = { ...entity.metadata, ...patch };
        await client.query(
          `UPDATE entities SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1 AND org_id = $3`,
          [entity.id, JSON.stringify(mergedMetadata), input.orgId],
        );
      } else {
        await client.query(
          `INSERT INTO entities (org_id, entity_type, display_name, status, metadata)
           VALUES ($1, 'account', $2, 'active', $3::jsonb)`,
          [input.orgId, input.contactEmail, JSON.stringify({ email: input.contactEmail, ...patch })],
        );
      }

      // The local entity is already updated; a CRM sync that is denied, parked
      // for approval or fails is reported, not hidden.
      const synced = await input.execute({
        ...input.actor,
        tool: 'hubspot',
        action: 'update_contact',
        payload: { email: input.contactEmail, phone: patch.phone, jobtitle: patch.title },
        orgId: input.orgId,
        source: 'sweep',
      });
      if (synced.status !== 'executed') {
        console.warn(
          `[enrichment] HubSpot update for org ${input.orgId} not executed (${synced.status}): ${synced.message || 'no message'}`,
        );
        return { enriched: true, fieldsFilled, reason: `crm_sync_${synced.status}` };
      }

      return { enriched: true, fieldsFilled };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { enriched: false, fieldsFilled: [], reason: 'entities_table_missing' };
    throw err;
  }
}
