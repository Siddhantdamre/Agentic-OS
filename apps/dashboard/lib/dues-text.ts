/**
 * The words around money owed to the owner: reading a pasted list, and writing the reminder. Pure functions.
 * Every reminder is a draft the owner approves; it never blames the buyer, never threatens, and mentions the
 * statutory interest only for a registered small supplier and only as a figure to confirm.
 */
import type { ChaseTone } from './dues-engine';

const MAX_LINES = 200;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ParsedDue {
  buyerName: string;
  invoiceNo: string | null;
  amount: number;
  invoiceDate: string; // YYYY-MM-DD
  creditDays: number | null;
  buyerPhone: string | null;
}

export interface ParseResult {
  rows: ParsedDue[];
  /** One plain sentence per line that could not be read, naming the line. */
  problems: string[];
}

/** ₹1,20,000 or ₹4,170.50: whole rupees without decimals, paise only when there are some. */
export function formatRupees(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n);
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m || 1) - 1]} ${y}`;
}

function toIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return toIso(year, Number(m[2]), Number(m[1]));
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function splitLine(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(';') ? ';' : ',';
  return line.split(sep).map((p) => p.trim());
}

const HEADER = /(buyer|party|customer|name).*(amount|invoice|date)/i;

/** Reads dues pasted from a spreadsheet or typed one per line: buyer, invoice no, amount, invoice date, credit days, phone. */
export function parseDuesPaste(text: string, today: Date): ParseResult {
  const rows: ParsedDue[] = [];
  const problems: string[] = [];
  const todayIso = today.toISOString().slice(0, 10);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (HEADER.test(line) && !/\d{3,}/.test(line.replace(/inv\w*/gi, ''))) continue;
    if (rows.length >= MAX_LINES) {
      problems.push(`Only the first ${MAX_LINES} lines were read. Paste the rest in a second go.`);
      break;
    }
    const n = i + 1;
    const [buyer, invoice, amountRaw, dateRaw, daysRaw, phoneRaw] = splitLine(line);
    if (!buyer) { problems.push(`Line ${n}: the buyer's name is missing.`); continue; }
    const amount = parseAmount(amountRaw ?? '');
    if (amount === null) { problems.push(`Line ${n}: I could not read the amount "${amountRaw ?? ''}".`); continue; }
    if (!(amount > 0)) { problems.push(`Line ${n}: the amount must be more than zero.`); continue; }
    const iso = parseDate(dateRaw ?? '');
    if (!iso) { problems.push(`Line ${n}: I could not read the date "${dateRaw ?? ''}". Use day/month/year, for example 12/08/2026.`); continue; }
    if (iso > todayIso) { problems.push(`Line ${n}: the invoice date ${formatDay(iso)} is in the future.`); continue; }
    let creditDays: number | null = null;
    if (daysRaw) {
      const d = Number(daysRaw);
      if (!Number.isInteger(d) || d < 0 || d > 365) { problems.push(`Line ${n}: the credit days "${daysRaw}" should be a whole number from 0 to 365.`); continue; }
      creditDays = d;
    }
    const phone = phoneRaw ? phoneRaw.replace(/[^\d+]/g, '') : '';
    rows.push({ buyerName: buyer, invoiceNo: invoice || null, amount, invoiceDate: iso, creditDays, buyerPhone: phone || null });
  }
  return { rows, problems };
}

export interface ReminderInput {
  tone: ChaseTone;
  buyerName: string;
  invoiceNo: string | null;
  amount: number;
  dueDate: string; // YYYY-MM-DD
  daysLate: number;
  businessName: string;
  /** Interest owed so far, from msmeInterest. Used only when msmeRegistered is true. */
  interest: number;
  msmeRegistered: boolean;
  payLink: string | null;
  language?: 'en' | 'hinglish';
}

/** A short WhatsApp-ready draft. The owner reads and approves it before anything is sent. */
export function draftReminder(i: ReminderInput): string {
  const inv = i.invoiceNo ? `invoice ${i.invoiceNo}` : 'your invoice';
  const amt = formatRupees(i.amount);
  const due = formatDay(i.dueDate);
  const link = i.payLink ? (i.language === 'hinglish' ? `Payment yahan kar sakte hain: ${i.payLink}` : `You can pay here: ${i.payLink}`) : '';
  const interestOwed = i.tone === 'formal' && i.msmeRegistered && i.interest > 0;
  const interestLine = !interestOwed
    ? ''
    : i.language === 'hinglish'
      ? `Registered chhote supplier hone ke naate hum MSMED Act, 2006 ke tahat byaaj ke haqdaar hain. Is invoice par ab tak lagbhag ${formatRupees(i.interest)} banta hai (pushti baaki).`
      : `As a registered small supplier we are entitled to interest under the MSMED Act, 2006. On this invoice it comes to about ${formatRupees(i.interest)} so far (to be confirmed).`;

  if (i.language === 'hinglish') {
    const body =
      i.tone === 'friendly'
        ? `Namaste ${i.buyerName}, ek chhota sa yaad dilana: ${inv} (${amt}) ${due} ko due tha. Agar payment ho chuka hai to is message ko ignore karein. Dhanyavaad!`
        : i.tone === 'firm'
          ? `Namaste ${i.buyerName}, ${inv} (${amt}) ${due} ko due tha aur ab ${i.daysLate} din late hai. Kya aap is hafte payment kar sakte hain? Agar invoice mein koi dikkat hai to bata dijiye, hum mil kar hal kar lenge.`
          : `Namaste ${i.buyerName}, ${inv} (${amt}) ${i.daysLate} din se pending hai. ${interestLine} Kripya bataiye ki payment kis tareekh tak aa jayega.`;
    return [body.replace(/\s+/g, ' ').trim(), link, `- ${i.businessName}`].filter(Boolean).join('\n');
  }

  const body =
    i.tone === 'friendly'
      ? `Hi ${i.buyerName}, a gentle reminder that ${inv} for ${amt} was due on ${due}. If it is already paid, please ignore this message. Thank you!`
      : i.tone === 'firm'
        ? `Hi ${i.buyerName}, ${inv} for ${amt} was due on ${due} and is now ${i.daysLate} days late. Could you arrange the payment this week? If there is a problem with the invoice, please tell me so we can sort it out together.`
        : `Hi ${i.buyerName}, ${inv} for ${amt} has been pending for ${i.daysLate} days since ${due}. ${interestLine} Please let me know the date by which the payment will reach us.`;
  return [body.replace(/\s+/g, ' ').trim(), link, `- ${i.businessName}`].filter(Boolean).join('\n');
}
