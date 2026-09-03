'use strict';
/**
 * WAIT FOR THE ANSWER, NOT FOR THE FIRST THING THE AGENT SAYS.
 *
 * The agent deliberately sends an interim acknowledgement before a slow answer:
 *
 *   "Just checking that for you — I will have an answer shortly."
 *
 * `reply-gate.ts` is explicit that this is "an interim message, NOT a fallback.
 * The real answer still follows when it lands." Measured on the live database:
 * 45 of 47 interim acks were followed by a real answer.
 *
 * Three e2e checks waited for the first new assistant message and asserted on
 * it. So on any workspace slow enough to trigger the ack — which today means
 * any workspace on the free model tier, measured at 28-38 seconds for a
 * twenty-token reply — they read the ack, found no facts in it (there are none
 * in it by design) and reported:
 *
 *   [FAIL] answer contains the uploaded fact ("Bay 70")
 *          — Just checking that for you — I will have an answer shortly.
 *
 * That is a misattributed failure. It says the answer was WRONG when what
 * happened is that the answer had not arrived yet, and it points an operator at
 * retrieval when the truth is latency. Three suites, one root cause, so this
 * lives in one place rather than three.
 *
 * Two outcomes, deliberately distinguished:
 *   { reply }                  a substantive answer, safe to assert on
 *   { reply: null, sawAck }    nothing but the ack — a timeout, not a wrong answer
 */

/**
 * The interim ack, matched loosely.
 *
 * Kept as a pattern rather than importing the constant so a checker never
 * depends on the compiled workflow bundle being present and current. Loose on
 * the dash, because the source uses an em-dash and copies of it have not always
 * survived encoding.
 */
const INTERIM_ACK = /just checking that for you/i;

/**
 * The word a caller greps for to tell "too slow" from "wrong".
 *
 * Exported rather than duplicated. check-e2e-agent-reply.js counts latency
 * failures separately so it can exit 3 ("blocked on model capacity") instead of
 * 1, and it was matching this wording with its own hardcoded regex — two copies
 * of one string, which is the drift that turns a careful distinction back into
 * a plain failure the first time somebody rewords a sentence.
 */
const LATENCY_MARKER = 'LATENCY';

/** Is this the agent saying "still working" rather than answering? */
function isInterimAck(text) {
  return INTERIM_ACK.test(String(text || ''));
}

/**
 * Wait for a substantive assistant reply.
 *
 * @param {object} opts
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} opts.query
 * @param {string} opts.orgId
 * @param {number} [opts.timeoutMs] total wall clock. Default 180s: the slowest
 *   correct reply ever measured here was 93.1s, and the free tier adds ~30s per
 *   model call on top of that.
 * @param {number} [opts.pollMs]
 * @returns {Promise<{reply: string|null, sawAck: boolean, waitedMs: number, ackCount: number}>}
 */
async function awaitSubstantiveReply({ query, orgId, timeoutMs = 180000, pollMs = 1000 }) {
  const t0 = Date.now();
  let sawAck = false;
  let ackCount = 0;

  while (Date.now() - t0 < timeoutMs) {
    // Every assistant message, newest first — not just the latest one. The ack
    // and the real answer can land within the same poll interval, and taking
    // only the newest row would still be a coin flip on ordering.
    const res = await query(
      `SELECT content FROM messages
        WHERE org_id = $1 AND role = 'assistant'
        ORDER BY created_at DESC LIMIT 10`,
      [orgId]
    );

    const rows = res.rows.map((r) => String(r.content || ''));
    ackCount = rows.filter(isInterimAck).length;
    if (ackCount > 0) sawAck = true;

    const substantive = rows.find((c) => c.trim() && !isInterimAck(c));
    if (substantive) {
      return { reply: substantive, sawAck, waitedMs: Date.now() - t0, ackCount };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return { reply: null, sawAck, waitedMs: Date.now() - t0, ackCount };
}

/**
 * The sentence to print when nothing substantive arrived.
 *
 * Names which of the two things happened, because they need opposite responses:
 * an ack and no answer is latency, and silence is a dead agent.
 */
function explainNoReply(outcome) {
  const secs = (outcome.waitedMs / 1000).toFixed(0);
  if (outcome.sawAck) {
    return `no substantive answer in ${secs}s — the agent sent only its interim `
      + `acknowledgement, so this is ${LATENCY_MARKER}, not a wrong answer. Check which `
      + 'model tier is serving: the free tier measures 28-38s per call.';
  }
  return `no assistant message at all in ${secs}s — the agent never replied. `
    + 'This is not latency; nothing was produced.';
}

module.exports = {
  awaitSubstantiveReply, isInterimAck, explainNoReply, INTERIM_ACK, LATENCY_MARKER,
};
