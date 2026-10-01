/**
 * OE-06: trigger the fuzzy dedup check when a contact is created. Compares
 * the new contact against the org's active `entities` (the local CRM record
 * of record) and either records it as a new entity, redirects it into an
 * existing one as a safe non-destructive merge (>=0.85), or queues it in
 * ambiguous_duplicate_reviews for a human to resolve (0.60-0.85).
 */
import { isUndefinedTable, withOrgClient } from '../db.js';
import { pickDedup, persistAmbiguousDuplicate, type DedupCandidate } from '../operations/dedup-engine.js';

export interface CheckContactDuplicateInput {
  orgId: string;
  name: string;
  domain?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface CheckContactDuplicateResult {
  decision: 'merge' | 'quarantine' | 'create';
  entityId: string;
  mergedIntoEntityId?: string;
  score: number;
}

export async function checkContactDuplicateActivity(
  input: CheckContactDuplicateInput,
): Promise<CheckContactDuplicateResult> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const existing = await client.query<{ id: string; display_name: string; metadata: Record<string, unknown> }>(
        `SELECT id::text, display_name, metadata
           FROM entities
          WHERE org_id = $1 AND entity_type = 'account' AND status = 'active'
          ORDER BY updated_at DESC LIMIT 200`,
        [input.orgId],
      );
      const candidates: DedupCandidate[] = existing.rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        domain: (row.metadata?.domain as string) || null,
        phone: (row.metadata?.phone as string) || null,
      }));
      const incoming: DedupCandidate = { name: input.name, domain: input.domain, phone: input.phone };
      const match = pickDedup(incoming, candidates);

      const metadata = { domain: input.domain || null, phone: input.phone || null, email: input.email || null };

      if (match.decision === 'merge' && match.candidate?.id) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO entities (org_id, entity_type, display_name, status, merged_into, metadata)
           VALUES ($1, 'account', $2, 'merged', $3, $4::jsonb)
           RETURNING id::text`,
          [input.orgId, input.name, match.candidate.id, JSON.stringify(metadata)],
        );
        return {
          decision: 'merge',
          entityId: inserted.rows[0].id,
          mergedIntoEntityId: match.candidate.id,
          score: match.total,
        };
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO entities (org_id, entity_type, display_name, status, metadata)
         VALUES ($1, 'account', $2, 'active', $3::jsonb)
         RETURNING id::text`,
        [input.orgId, input.name, JSON.stringify(metadata)],
      );
      const entityId = inserted.rows[0].id;

      if (match.decision === 'quarantine') {
        await persistAmbiguousDuplicate(client, input.orgId, incoming, match).catch(() => undefined);
      }

      return { decision: match.decision, entityId, score: match.total };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { decision: 'create', entityId: `pending:${input.name}`, score: 0 };
    }
    throw err;
  }
}
