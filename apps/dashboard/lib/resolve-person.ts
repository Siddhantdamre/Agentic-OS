import { normaliseIdentity } from '@darex/workflows/dist/identity/identity.js';

/**
 * WHO IS THIS MESSAGE FROM — the one place that answers it.
 *
 * A conversation created without a person_id is a conversation that:
 *
 *   cannot be joined to anything that person said before, so the agent
 *     re-asks what it was told last week
 *   cannot be fully erased, because erase_person walks the identities and
 *     finds none
 *   counts as its own quiet lead, so one human gets followed up several times
 *
 * There are five places in this codebase that create a conversation. Wiring the
 * resolution into each of them fixes today and guarantees the sixth — which is
 * exactly how attribution missed three call sites, how the budget missed five,
 * and how tenant isolation missed a table. So this is the only function that
 * resolves a person, and lint-conversation-person.js fails the build if an
 * INSERT INTO conversations appears anywhere that does not use it.
 *
 * ── NORMALISATION IS NOT DUPLICATED HERE ──────────────────────────────────
 * The matching rules live in services/workflows/src/identity/identity.ts with
 * 20 unit tests, most asserting that two handles must NOT be merged. This file
 * calls them. A second copy of a matching rule drifts, and the drift is silent
 * until somebody reads a stranger's messages.
 *
 * ── IT NEVER THROWS ───────────────────────────────────────────────────────
 * A failure to resolve returns null and the conversation is created without a
 * person. That is a degraded conversation; refusing to store an inbound
 * customer message because the identity table had a bad moment would be an
 * outage caused by a feature that exists to add context.
 */

/** Minimal shape of whatever query client the caller already holds. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function resolvePersonId(
  client: Queryable,
  orgId: string,
  contactHandle: string | null | undefined,
  channelHint?: string,
): Promise<string | null> {
  const raw = String(contactHandle ?? '').trim();
  if (!orgId || !raw) return null;

  try {
    const n = normaliseIdentity(raw, channelHint);
    if (!n.value) return null;

    const res = await client.query(
      `SELECT resolve_contact_person($1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::text) AS id`,
      [orgId, n.kind, n.value, n.raw, n.confident, n.raw],
    );
    const id = res.rows[0]?.id;
    return typeof id === 'string' ? id : null;
  } catch (err) {
    // Loud, because a resolver that silently stops running looks exactly like
    // a workspace whose customers all happen to be new.
    console.error(
      `[identity] could not resolve "${raw}" for org ${orgId}; the conversation will be `
      + `created without a person and will not be linked to their history. `
      + `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
