#!/usr/bin/env node
/**
 * OUTPUT QUALITY RULES — is the reply well written, not just correct?
 *
 * The completion suite answers "did the agent get the fact right". This answers
 * "would a customer be glad to receive this". Both matter: a correct answer
 * buried under "I'd be happy to help you with that!" or quoting "2500 rupees"
 * in one breath and "₹2,500" in the next still reads like a bot.
 *
 * A standalone module on purpose. Every rule here is a regex, and this file has
 * already been destroyed twice by writing regexes through a shell heredoc —
 * `\s` collapsing to `s`, `\b` becoming a literal backspace byte. Both times the
 * pattern still COMPILED and silently stopped matching, which is the worst
 * possible failure for a checker. Edit this file with file tools only, never
 * with sed/heredoc, and run `node infra/scripts/quality-rules.js` after any
 * change — the self-test at the bottom proves each rule fires on text that
 * should fail AND stays quiet on text that should pass.
 *
 * Usage:
 *   const { scoreQuality } = require('./quality-rules');
 *   node infra/scripts/quality-rules.js   # self-test
 */

/**
 * Each rule: `bad` returns true when the reply violates it.
 * `appliesTo` (optional) limits the rule to replies where it is meaningful —
 * a money-formatting rule must not fire on a reply that mentions no money.
 */
const RULES = [
  {
    name: 'answer_first',
    detail: 'opened with preamble instead of the answer',
    // Observed: "I'd be happy to help you with a refund request. To look up..."
    // and "I understand you're requesting deletion of your personal data".
    // The customer reads a sentence of throat-clearing before the fact.
    bad: (r) =>
      /^\s*(?:sure|certainly|of course|absolutely|great question|thanks for asking|thank you for asking|i'?d be happy|i am happy|i'?m happy|i understand|happy to help|let me help|i can help you with that)\b/i
        .test(r),
  },
  {
    name: 'money_symbol',
    detail: 'wrote money as "2500 rupees" instead of ₹2,500',
    // Only judged when the reply quotes an amount in words.
    appliesTo: (r) => /\b\d[\d,]*\s*(?:rupees|rs\.?|inr)\b/i.test(r),
    bad: (r) => /\b\d[\d,]*\s*(?:rupees|rs\.?|inr)\b/i.test(r),
  },
  {
    name: 'money_separators',
    // ₹2500 rather than ₹2,500. Four or more digits with no separator.
    detail: 'wrote an amount without thousands separators',
    appliesTo: (r) => /₹\s?\d/.test(r),
    // The next char must not continue the number. An earlier version used
    // (?!\d*[,.]) which the trailing full stop in "costs ₹2500." satisfied, so
    // the rule silently never fired — caught only by the self-test below.
    bad: (r) => /₹\s?\d{4,}(?![\d,])/.test(r),
  },
  {
    name: 'plain_text',
    detail: 'contained markdown, which renders literally on WhatsApp',
    bad: (r) => /\*\*|^\s{0,3}#{1,6}\s|^\s*[-*•]\s+|^\s*\d+[.)]\s+|\|.*\|/m.test(r),
  },
  {
    name: 'concise',
    detail: 'over 400 characters for a chat channel',
    bad: (r) => r.length > 400,
  },
  {
    name: 'not_truncated',
    detail: 'ended mid-sentence',
    // A reply cut off mid-word reads as a crash, not brevity.
    bad: (r) => {
      const t = r.trim();
      if (!t) return false;
      return !/[.!?…)"'।]$/.test(t) && !/more detail\?$/i.test(t);
    },
  },
  {
    name: 'no_internal_terms',
    detail: 'named a table, database, query, tool or connector',
    // "I checked the billing_invoices table in your organisation's database."
    bad: (r) =>
      /\b(?:database|table|column|schema|sql|query|api|endpoint|connector|webhook|tool call|system prompt)\b/i
        .test(r),
  },
  {
    name: 'no_internal_ids',
    detail: 'exposed a UUID or internal identifier',
    bad: (r) =>
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:org_?id|conversation_?id|employee_?id)\b/i
        .test(r),
  },
  {
    name: 'no_placeholder_text',
    detail: 'shipped an unresolved [placeholder] to the customer',
    // Observed verbatim: "Since today is [current date — please confirm], the
    // next Saturday is [date — please confirm]". The agent had no clock, tried
    // to resolve the date anyway, and sent the template. Nothing reads more
    // obviously broken to a customer than square brackets in a reply.
    //
    // Scoped to bracketed text that looks like a FIELD — a short run without
    // sentence punctuation — so a legitimate aside like "(we're closed Sunday)"
    // or a bracketed clarification is not flagged.
    bad: (r) => /\[[^\]\n]{2,60}\]/.test(r) || /\{\{[^}]{1,60}\}\}/.test(r) || /<[a-z_]{2,30}>/i.test(r),
  },
  {
    name: 'no_hedging',
    detail: 'hedged a figure it had retrieved exactly',
    // "approximately ₹2,500" when the record says exactly ₹2,500 erodes trust
    // in every other number the agent gives.
    bad: (r) => /\b(?:approximately|roughly|around|about|circa|give or take)\s*₹/i.test(r),
  },
];

/** Returns the rules a reply violates. Empty array = clean. */
function scoreQuality(reply) {
  const text = String(reply || '');
  if (!text.trim()) return [];
  return RULES
    .filter((rule) => (rule.appliesTo ? rule.appliesTo(text) : true))
    .filter((rule) => rule.bad(text))
    .map((rule) => ({ name: rule.name, detail: rule.detail }));
}

/** Rule names, for reporting. */
function ruleNames() {
  return RULES.map((r) => r.name);
}

module.exports = { scoreQuality, ruleNames, RULES };

// ── Self-test ───────────────────────────────────────────────────────────────
// Run directly. Each rule must fire on a violation and stay quiet on a good
// reply — a regex that silently stops matching passes a "no issues" report,
// which is exactly how a broken checker hides.
if (require.main === module) {
  const cases = [
    // [label, text, expected rule name or null]
    ['preamble', "I'd be happy to help you with a refund request. To look up your order I need the reference.", 'answer_first'],
    ['understand', "I understand you're requesting deletion of your personal data under GDPR.", 'answer_first'],
    ['rupees words', 'An initial design consultation costs 2500 rupees.', 'money_symbol'],
    ['no separator', 'An initial design consultation costs ₹2500.', 'money_separators'],
    ['markdown bold', 'Our hours are **10am to 4pm** on Saturday.', 'plain_text'],
    ['markdown bullet', 'What I can do:\n- check your order\n- book a viewing', 'plain_text'],
    ['too long', 'x'.repeat(401), 'concise'],
    ['truncated', 'We are open from 10am to', 'not_truncated'],
    ['internal term', "I checked the billing_invoices table in your organisation's database.", 'no_internal_terms'],
    ['uuid', 'Your policy for org_id=a8ea8b57-7e31-4b77-a55e-691c313d8494 allows returns.', 'no_internal_ids'],
    ['hedge', 'The consultation costs approximately ₹2,500.', 'no_hedging'],
    // Verbatim from the reliability run that exposed the missing clock.
    ['placeholder date',
      'Since today is [current date — please confirm], the next Saturday is [date — please confirm].',
      'no_placeholder_text'],
    ['placeholder name', 'Thanks [customer name], your order is on its way.', 'no_placeholder_text'],
    ['placeholder mustache', 'Your booking is confirmed for {{slot_time}}.', 'no_placeholder_text'],
    ['placeholder angle', 'Please contact us at <support_email>.', 'no_placeholder_text'],
    // Good replies — every one of these must score clean.
    ['good hours', 'We open at 10am on Saturdays and close at 4pm.', null],
    ['good money', 'An initial design consultation costs ₹2,500, credited against orders over ₹50,000.', null],
    ['good delivery', 'Yes, a delivery charge of ₹1,200 applies for locations outside Bengaluru.', null],
    ['good cancel', 'Yes, you can cancel an order free of charge within 48 hours. After that a 15% restocking fee applies.', null],
    ['good refusal', "I can't share other people's personal details — they're private to them.", null],
    ['good hindi', 'जी हाँ, मैं हिंदी में बात कर सकता हूँ। आप कैसे मदद करना चाहेंगे?', null],
  ];

  let pass = 0;
  let fail = 0;
  for (const [label, text, expected] of cases) {
    const hits = scoreQuality(text).map((h) => h.name);
    const ok = expected === null ? hits.length === 0 : hits.includes(expected);
    if (ok) {
      pass++;
    } else {
      fail++;
      console.log(`  FAIL ${label.padEnd(16)} expected ${expected || 'clean'}, got [${hits.join(', ') || 'clean'}]`);
    }
  }
  console.log(`\nquality-rules self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
