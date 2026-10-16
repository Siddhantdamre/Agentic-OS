/**
 * Deterministic obligation extractor used by the demo and as the cheap
 * pre-LLM path. Seed inputs, never outcomes — if this misses a promise
 * the demo fails. Never tags obligor=us on a customer-sent message.
 */

export type Speaker = 'us' | 'them';
export type DueBasis = 'explicit' | 'relative' | 'default';

export interface ExtractedLoop {
  obligor: 'us' | 'them';
  promiseSummary: string;
  sourceQuote: string;
  dueBasis: DueBasis;
  targetCheckAt: Date;
}

export interface ExtractInput {
  message: string;
  speaker: Speaker;
  at: Date;
}

const US_PROMISE = /\bI(?:['’]ll| will)\s+([^.!?\n]{5,160})/gi;
const EXPLICIT_DUE = /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}\s+\w+)/i;
const RELATIVE_DUE = /\b(shortly|soon|later today|this afternoon|in an hour|in a bit)\b/i;

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function nextWeekday(from: Date, weekday: number): Date {
  const out = new Date(from.getTime());
  const delta = (weekday + 7 - out.getDay()) % 7 || 7;
  out.setDate(out.getDate() + delta);
  out.setHours(17, 0, 0, 0);
  return out;
}

function dueFrom(text: string, at: Date): { dueBasis: DueBasis; targetCheckAt: Date } {
  const explicit = text.match(EXPLICIT_DUE);
  if (explicit) {
    const token = explicit[1].toLowerCase();
    const weekday = WEEKDAYS[token];
    if (typeof weekday === 'number') {
      return { dueBasis: 'explicit', targetCheckAt: nextWeekday(at, weekday) };
    }
    const out = new Date(at.getTime());
    if (token === 'tomorrow') out.setDate(out.getDate() + 1);
    out.setHours(17, 0, 0, 0);
    return { dueBasis: 'explicit', targetCheckAt: out };
  }
  if (RELATIVE_DUE.test(text)) {
    const out = new Date(at.getTime() + 4 * 60 * 60 * 1000);
    return { dueBasis: 'relative', targetCheckAt: out };
  }
  const out = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  return { dueBasis: 'default', targetCheckAt: out };
}

export function extractOpenLoops(input: ExtractInput): ExtractedLoop[] {
  const loops: ExtractedLoop[] = [];
  if (!input.message) return loops;
  US_PROMISE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = US_PROMISE.exec(input.message))) {
    if (input.speaker !== 'us') continue;
    const quote = match[0].trim();
    const due = dueFrom(input.message, input.at);
    loops.push({
      obligor: 'us',
      promiseSummary: match[1].trim(),
      sourceQuote: quote,
      dueBasis: due.dueBasis,
      targetCheckAt: due.targetCheckAt,
    });
  }
  return loops;
}
