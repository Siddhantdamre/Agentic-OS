import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/revoke — make the agent ask about everything again.
 *
 * The button a business needs on the day something goes wrong. It is one call,
 * it takes effect on the next action rather than the next cycle, and it needs
 * no reasoning about which action classes are at which level — because the
 * person reaching for it is not in a state to reason about that.
 *
 * Deliberately not reversible in one click. Trust was earned one approval at a
 * time and is re-earned the same way; a "restore my previous settings" button
 * would let somebody undo a panic decision before understanding what caused
 * it.
 */
export async function POST() {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId, userId } = scoped;

  try {
    const res = await client.query(
      `SELECT revoke_all_autonomy($1::uuid, $2::uuid) AS n`,
      [orgId, userId],
    );
    const n = Number(res.rows[0]?.n ?? 0);
    return NextResponse.json({
      status: 'revoked',
      classesRevoked: n,
      message: n === 0
        ? 'The agent was already asking you about everything.'
        : `The agent will ask you first about ${n} more thing${n === 1 ? '' : 's'} from now on.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[approvals/revoke]', message);
    return NextResponse.json({ error: 'Could not revoke.' }, { status: 500 });
  } finally {
    client.release();
  }
}
