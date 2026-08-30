/**
 * DID THE WORK ACTUALLY LAND? — reading the evidence already in the database.
 *
 * The two outcomes this deployment has ever recorded are `customer_replied`
 * (711) and `conversation_resolved` (652). The second is written by the quiet
 * sweep: the business spoke last and the customer never came back. That is
 * SILENCE, recorded as resolution — so the most common "success" in the system
 * is indistinguishable from a customer who gave up and went elsewhere.
 *
 * The first is worse in a more useful way: 711 replies were collected and their
 * meaning thrown away. The signal is already arriving. Nobody reads it.
 *
 * So this module is a reader, not a collector. It never asks anyone anything.
 *
 * ── WHY ASKING IS THE WRONG MECHANISM ─────────────────────────────────────
 * If the agent is measured on approval it can request, it learns to request
 * approval — "was this helpful?" on every message raises the metric and lowers
 * the product. Behavioural evidence cannot be gamed that way: the agent cannot
 * make someone book a viewing, and it cannot stop them asking the same question
 * twice. So behaviour outranks explicit feedback here, permanently.
 *
 * ── THE RULE THAT MATTERS MOST ────────────────────────────────────────────
 * AMBIGUITY IS NEVER POSITIVE. A reply that cannot be read confidently returns
 * `neutral`, which leaves the conversation in `awaiting` and eventually
 * `unknown`. Guessing in the flattering direction is precisely how the current
 * 91% "resolution rate" came to mean nothing.
 *
 * ── HINGLISH IS NOT AN EDGE CASE HERE ─────────────────────────────────────
 * The customers are Indian SMB customers. "theek hai", "thik h", "ok ji",
 * "dhanyavaad", "nahi chahiye" are the normal register, not exotic input. A
 * classifier that only reads formal English would read most of this market as
 * neutral and report that it has no idea — which is worse than useless,
 * because it looks like caution.
 */

export type Polarity = 'positive' | 'negative' | 'neutral';
export type Strength = 'strong' | 'moderate' | 'weak';

export interface ReplyReading {
  polarity: Polarity;
  /** Why, in a word an operator can read. */
  reason: string;
  strength: Strength;
}

const NEUTRAL: ReplyReading = { polarity: 'neutral', reason: 'unreadable', strength: 'weak' };

/** Strip punctuation/emoji and fold case so patterns match how people type. */
function normalise(text: string): string {
  return String(text || '')
    .toLowerCase()
    // Apostrophes are DELETED, not spaced. Splitting "didn't" into "didn t"
    // silently broke every contraction pattern below, and the only symptom was
    // a complaint reading as neutral — failing in the flattering direction,
    // which is the one direction this module must never fail in.
    .replace(/['‘’ʼ]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Clear positives ─────────────────────────────────────────────────────────
// Gratitude and acknowledgement, in the registers this market actually uses.
// Deliberately NOT including bare "ok" or "haan": on their own they acknowledge
// receipt, not satisfaction, and counting them would inflate the one number
// this exists to make honest.
const POSITIVE = [
  /\b(thanks|thank you|thanku|thankyou|thx|tysm)\b/,
  /\b(dhanyavaad|dhanyawad|shukriya|shukriyaa)\b/,
  /\b(perfect|great|excellent|awesome|superb|wonderful|brilliant)\b/,
  /\b(got it|understood|makes sense|that helps|helpful|clear now)\b/,
  /\b(theek hai|thik hai|thik h|theek h|sahi hai|badhiya|bahut achha|achha hai)\b/,
  /\b(ok (thanks|thank you|great|perfect|got it))\b/,
  /\b(will do|sounds good|works for me|that works)\b/,
];

// Committing to the thing the agent proposed. The strongest textual signal
// there is, because it is a decision rather than a courtesy.
const COMMITTED = [
  /\b(booked|booking confirmed|confirmed|i ?a?m coming|i will come|coming on)\b/,
  /\b(please (book|schedule|proceed|go ahead)|go ahead|proceed)\b/,
  /\b(paid|payment done|transferred|sent the (payment|money))\b/,
  /\b(kar do|kar dijiye|book kar|confirm kar)\b/,
];

// ── Clear negatives ─────────────────────────────────────────────────────────
const WANTS_HUMAN = [
  /\b(talk to|speak to|connect me|put me through|transfer me)\b.*\b(human|person|someone|agent|manager|owner|staff)\b/,
  /\b(real (person|human)|actual (person|human))\b/,
  /\b(call me|phone karo|baat karao|kisi se baat)\b/,
];

const DISSATISFIED = [
  /\b(not what i (asked|meant|wanted)|thats not|that is not|didnt answer|did not answer)\b/,
  /\b(wrong|incorrect|galat|nahi ye nahi)\b/,
  /\b(already (told|said|asked)|i (just )?told you|asked this already)\b/,
  /\b(useless|no help|not helpful|waste of time|bakwas|bekar)\b/,
  /\b(still waiting|no response|koi jawab nahi)\b/,
  /\b(nahi chahiye|not interested|dont want)\b/,
];

/**
 * Read one customer reply.
 *
 * Order is deliberate: a message asking for a human is negative even when it
 * says "thanks" first — "thanks but can I speak to someone" is a failure with
 * good manners, and reading the courtesy instead of the request is how a
 * satisfaction metric ends up measuring politeness.
 */
export function classifyCustomerReply(text: string): ReplyReading {
  const t = normalise(text);
  if (!t) return NEUTRAL;

  for (const re of WANTS_HUMAN) {
    if (re.test(t)) return { polarity: 'negative', reason: 'asked for a person', strength: 'strong' };
  }
  for (const re of DISSATISFIED) {
    if (re.test(t)) return { polarity: 'negative', reason: 'said it was wrong', strength: 'strong' };
  }
  for (const re of COMMITTED) {
    if (re.test(t)) return { polarity: 'positive', reason: 'acted on it', strength: 'strong' };
  }
  for (const re of POSITIVE) {
    if (re.test(t)) return { polarity: 'positive', reason: 'said thanks', strength: 'moderate' };
  }

  // A bare question mark, or a very short message that is only a question, on
  // the heels of an answer, reads as "that did not land". Kept narrow: a long
  // question is a NEW question, which is ordinary conversation, not a failure.
  if (/^\??$/.test(t) || (t.length <= 24 && /\?$/.test(t) && /\b(what|kya|matlab|meaning|samajh)\b/.test(t))) {
    return { polarity: 'negative', reason: 'confused by the answer', strength: 'moderate' };
  }

  return NEUTRAL;
}

/**
 * Did the customer ask the same thing again?
 *
 * A repeated question is one of the strongest free negatives available: nobody
 * asks twice when the first answer worked. Compared on content words only, so
 * "what are your timings" and "timings kya hai" are recognised as the same
 * question asked in two registers.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'what', 'when', 'where', 'how', 'why', 'who', 'your', 'you', 'my', 'i', 'me', 'to',
  'of', 'for', 'in', 'on', 'at', 'and', 'or', 'it', 'this', 'that', 'please', 'pls',
  'hai', 'hain', 'kya', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'hi', 'h',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    normalise(text).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function isRepeatedQuestion(earlier: string, later: string): boolean {
  const a = contentWords(earlier);
  const b = contentWords(later);
  // Two words of overlap on a two-word question is coincidence, not repetition.
  if (a.size < 2 || b.size < 2) return false;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared += 1;
  const overlap = shared / Math.min(a.size, b.size);
  return overlap >= 0.6;
}
