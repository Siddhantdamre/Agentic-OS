/**
 * RECORD THE TRIO — one row per task, written once, at the end.
 *
 * The doer, the monitor and the learner already ran on every work item. Their
 * traces were scattered across a dozen work_event kinds, so "was this task
 * supervised?" could only be answered by reconstructing a timeline. A
 * supervisor nobody can confirm ran is indistinguishable from one that
 * silently stopped, which is how four features in this codebase came to be
 * built, tested, and unreachable.
 *
 * A MISSING ROW IS THE SIGNAL. This is written at the terminal point of the
 * workflow, so a completed task with no supervision row means the task
 * finished without all three roles reporting — and check-supervision.js fails
 * on exactly that.
 *
 * ── IT NEVER THROWS ───────────────────────────────────────────────────────
 * Supervision is a record OF the work, not part of it. A customer's answer
 * must not be lost because the bookkeeping table had a bad moment. The failure
 * logs loudly instead, because a recorder that has silently stopped looks
 * exactly like a workspace where nothing needs supervising.
 */
import { Pool } from 'pg';

import { judgeTask, type TaskSignals, type TrioVerdict } from '../supervision/trio.js';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'darex_app',
      password: process.env.DB_PASSWORD || 'darex_app_dev_secret',
      database: process.env.DB_NAME || 'darex',
      max: 4,
    });
  }
  return pool;
}

export interface RecordTaskSupervisionParams extends TaskSignals {
  orgId: string;
  workItemId: string;
  conversationId?: string;
}

export async function recordTaskSupervisionActivity(
  params: RecordTaskSupervisionParams,
): Promise<TrioVerdict | null> {
  // The judgement is a pure function with 20 unit tests. This activity shapes
  // the write and never re-decides — two copies of the classification would
  // drift, and only one of them would be tested.
  const verdict = judgeTask(params);

  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT set_config('app.current_org_id', $1, false)", [params.orgId]);
      await client.query(
        `SELECT record_task_supervision(
           $1::uuid, $2::uuid, $3::uuid,
           $4::text, $5::int,
           $6::text, $7::text, $8::boolean,
           $9::text, $10::boolean)`,
        [
          params.orgId,
          params.workItemId,
          params.conversationId || null,
          verdict.doerOutcome,
          verdict.doerTurns,
          verdict.monitorVerdict,
          verdict.monitorReason,
          verdict.monitorUsedModel,
          verdict.learnerOutcome,
          verdict.learnerFromMonitor,
        ],
      );
    } finally {
      try { await client.query('RESET app.current_org_id'); } catch { /* releasing anyway */ }
      client.release();
    }
    return verdict;
  } catch (err) {
    console.error(
      `[supervision] could not record the trio for work item ${params.workItemId}; `
      + 'the task itself is unaffected, but it will appear UNSUPERVISED. '
      + `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
