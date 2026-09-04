/**
 * THE TOOL GRANT FOR ONE SELF-DIRECTED TURN.
 *
 * `duties.ts` promises, in its own header, that a duty runs with the minimum
 * tool and never the employee's full authority. `planDuty` computes that and
 * `duties.test.ts` asserts it — and then the value was passed into the workflow
 * and dropped, because the MCP bridge is a separate process that receives only
 * what the model puts in a tool call.
 *
 * Measured: Emma's duty, allowlist `["database_query"]`, reached `metrics_list`,
 * `metrics_query` and `intercom_fetch_conversations`. Intercom is neither in her
 * employee allowlist nor connected in that workspace; the org-wide union let it
 * through because another employee holds it and the call is a read.
 *
 * So the grant is written where both processes can see it, keyed by the session
 * id — the one value that crosses the bridge with the HOST's authority rather
 * than the model's. Patch 0003 forwards it on every MCP tool call.
 *
 * ── IT CAN ONLY EVER NARROW ─────────────────────────────────────────────────
 *
 * No grant, an expired grant, or a call that arrives without a session id all
 * mean the bridge behaves exactly as it does today: the org union, reads only.
 * That is deliberate. Treating a missing grant as "deny" would turn one stale
 * row or a little clock skew into an outage on live customer conversations —
 * a worse failure than the least-privilege erosion this fixes.
 *
 * It follows that this is defence in depth, not a hard boundary: a tool call
 * that omits the session id gets the old, wider behaviour. What stops that
 * being an escalation is the layer underneath — every send, payment and write
 * is refused outright when no employee is named, which is verified directly
 * rather than assumed.
 */

import { withOrgScopedClient } from './shared.js';

/** How long a grant stays live. A turn is minutes; an abandoned grant must not linger. */
const GRANT_TTL_MS = 15 * 60 * 1000;

export interface TurnGrantInput {
  orgId: string;
  sessionId: string;
  employeeId?: string | null;
  /** The duty's need intersected with what the employee holds. Never the union. */
  allowlist: string[];
}

/**
 * Record the grant for a turn about to start.
 *
 * Upserts, so a Temporal retry of the same turn refreshes the expiry instead of
 * colliding on the primary key — a retried duty must not find itself locked out
 * by its own earlier attempt.
 *
 * Never throws. A grant is a restriction; failing to write one leaves the turn
 * with today's behaviour, and taking down a shift because the narrowing could
 * not be recorded would trade a small privilege problem for no work at all.
 */
export async function recordTurnGrant(input: TurnGrantInput): Promise<boolean> {
  const sessionId = String(input.sessionId || '').trim();
  const orgId = String(input.orgId || '').trim();
  const allowlist = (input.allowlist || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!sessionId || !orgId || allowlist.length === 0) return false;

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      await client.query(
        `INSERT INTO duty_turn_grants (session_id, org_id, employee_id, allowlist, expires_at)
         VALUES ($1, $2::uuid, $3, $4::text[], NOW() + ($5 || ' milliseconds')::interval)
         ON CONFLICT (session_id) DO UPDATE SET
           allowlist  = EXCLUDED.allowlist,
           employee_id = EXCLUDED.employee_id,
           expires_at = EXCLUDED.expires_at`,
        [sessionId, orgId, input.employeeId || null, allowlist, String(GRANT_TTL_MS)]
      );
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * The grant for a session, or null when there is none to apply.
 *
 * Expired rows are treated as absent rather than deleted here: the read path is
 * on every tool call and must not take a write lock. `clearTurnGrant` and the
 * sweep below do the removing.
 */
export interface TurnGrant {
  allowlist: string[];
  /**
   * WHICH EMPLOYEE IS ACTING — and why that unlocks more than it restricts.
   *
   * The executor refuses every non-read when no employee is named, with good
   * reason: an unattributed write is a write nobody can be held to. Its own
   * comment says "Acting requires somebody to say which employee is acting."
   *
   * Nobody ever said. Tool calls reach the executor from the MCP bridge, which
   * has no employee to name, so EVERY write through that path was refused —
   * measured: google-calendar.create_event, gmail.draft_email and
   * hubspot.create_crm_contact all `no_employee_named`. The agent could answer
   * a question and could not book, draft or record anything. A customer asking
   * to book a Saturday viewing was told "please provide the name of the
   * employee handling the booking", which is the internal refusal reaching a
   * customer through the model.
   *
   * A grant is the host saying it, authoritatively: the worker wrote this row
   * before the turn started, keyed by a session id the model never sees. So
   * honouring it SATISFIES the gate's requirement rather than bypassing it —
   * the employee is named, just not in the function argument.
   *
   * Everything above stays: risk class, confirm policy, the critic, and durable
   * execution for sends. This changes who is on the hook, not what is allowed
   * without review.
   */
  employeeId: string | null;
}

export async function readTurnGrant(orgId: string, sessionId: string): Promise<TurnGrant | null> {
  const sid = String(sessionId || '').trim();
  const org = String(orgId || '').trim();
  if (!sid || !org) return null;

  try {
    return await withOrgScopedClient(org, async (client) => {
      const res = await client.query<{ allowlist: string[]; employee_id: string | null }>(
        `SELECT allowlist, employee_id FROM duty_turn_grants
          WHERE session_id = $1 AND expires_at > NOW() LIMIT 1`,
        [sid]
      );
      const row = res.rows[0];
      if (!row || !Array.isArray(row.allowlist) || row.allowlist.length === 0) return null;
      return { allowlist: row.allowlist, employeeId: row.employee_id ?? null };
    });
  } catch {
    // A grant that cannot be read is a grant that does not apply. Same reason
    // as the write path: never fail a turn to enforce a narrowing.
    return null;
  }
}

/** Drop a grant once its turn is done, so nothing outlives the work. */
export async function clearTurnGrant(orgId: string, sessionId: string): Promise<void> {
  const sid = String(sessionId || '').trim();
  const org = String(orgId || '').trim();
  if (!sid || !org) return;
  try {
    await withOrgScopedClient(org, async (client) => {
      await client.query(`DELETE FROM duty_turn_grants WHERE session_id = $1`, [sid]);
    });
  } catch {
    // The TTL is the backstop. An undeleted grant expires on its own.
  }
}

/**
 * Remove grants whose turn ended without clearing them — a crashed worker, a
 * terminated workflow. Cheap, and safe to call from anywhere.
 */
export async function sweepExpiredTurnGrants(orgId: string): Promise<number> {
  const org = String(orgId || '').trim();
  if (!org) return 0;
  try {
    return await withOrgScopedClient(org, async (client) => {
      const res = await client.query(
        `DELETE FROM duty_turn_grants WHERE expires_at <= NOW()`
      );
      return res.rowCount || 0;
    });
  } catch {
    return 0;
  }
}

/**
 * The session id a tool call arrived with, if it carried one.
 *
 * Patch 0003 sends it as `_host_session_id`, namespaced so it cannot collide
 * with a real tool parameter. It is read out of the payload and REMOVED before
 * the payload reaches a provider, because a tool module has no business seeing
 * it and a stray field can fail a strict API schema.
 */
export function takeHostSessionId(payload: Record<string, unknown>): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload._host_session_id;
  delete payload._host_session_id;
  if (typeof raw !== 'string') return null;

  // NOT trimmed, deliberately. Trimming first turned a newline-padded value
  // into "darex:o:" and it passed the charset check — silently NORMALISED
  // "darex:o:" and passed the charset check — a padded value silently
  // NORMALISED into something that looks like a session id, which is how a
  // lookup key ends up being something nobody built. A host-built session id
  // never carries surrounding whitespace, so needing to trim is itself the
  // signal that this did not come from the host. Caught by its own test.
  if (!raw || raw.length > 200) return null;
  // Bounded and charset-restricted: this value reaches a SQL parameter and a
  // log line. It is parameterised, so injection is not the threat — a hostile
  // value being USED as a lookup key is.
  if (!/^[A-Za-z0-9:_=./-]+$/.test(raw)) return null;
  // Every segment must carry something. `darex:o:` names no turn.
  return raw.split(':').every((seg) => seg.length > 0) ? raw : null;
}
