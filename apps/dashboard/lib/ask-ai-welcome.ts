/**
 * What a person reads first in Ask AI: the greeting and the starter prompts. Plain business language only
 * (no tool ids, no "OAuth", no raw paths), and nothing is offered that needs an app that is not connected.
 */

const KNOWN: Record<string, string> = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-sheets': 'Google Sheets',
  'google-drive': 'Google Drive',
  'google-ads': 'Google Ads',
  'meta-ads': 'Meta Ads',
  whatsapp: 'WhatsApp',
  hubspot: 'HubSpot',
  slack: 'Slack',
  outlook: 'Outlook',
  email: 'Email',
  instagram: 'Instagram',
  facebook: 'Facebook',
  shopify: 'Shopify',
  zendesk: 'Zendesk',
  stripe: 'Stripe',
  razorpay: 'Razorpay',
  notion: 'Notion',
  salesforce: 'Salesforce',
};

/** "google-calendar" -> "Google Calendar"; an unknown code is made readable rather than printed raw. */
export function channelName(code: string): string {
  const key = String(code || '').trim().toLowerCase();
  if (!key) return '';
  if (KNOWN[key]) return KNOWN[key];
  const words = key.replace(/[-_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function welcomeText(orgName: string, channels: string[]): string {
  const apps = Array.from(new Set(channels.map(channelName).filter(Boolean)));
  if (apps.length === 0) {
    return `### Hi, I’m your assistant for ${orgName}

I can answer questions about your business, look things up on the web and work from the documents you have added.

[Connect your apps](/connectors) such as Gmail, WhatsApp or Google Calendar and I can reply to customers and book appointments too. I always show you a message before it is sent.`;
  }
  return `### Hi, I’m your assistant for ${orgName}

I can answer questions about your business, look things up on the web, and work with ${list(apps)}.

I always show you a message before it is sent, and you decide whether it goes.`;
}

export type Starter = { label: string; prompt: string };

const ALWAYS: Starter[] = [
  { label: 'What needs me today?', prompt: 'What needs my attention today? List anything waiting on me, oldest first.' },
  { label: 'Summarise this week', prompt: 'Summarise this week: how many conversations and enquiries came in, and anything that stands out.' },
  { label: 'Who is still waiting for a reply?', prompt: 'Which customers are still waiting for a reply from us? Start with the longest wait.' },
  { label: 'What can you do for me?', prompt: 'What can you do for my business today, and what would I need to connect to unlock more?' },
];

const WITH_APP: Array<{ needs: string[]; starter: Starter }> = [
  { needs: ['gmail', 'outlook', 'email'], starter: { label: 'Reply to my latest emails', prompt: 'Show my latest unanswered emails and write a reply to each one for me to approve.' } },
  { needs: ['whatsapp'], starter: { label: 'Catch up on WhatsApp', prompt: 'Show the WhatsApp chats that are waiting for a reply and draft answers for me to approve.' } },
  { needs: ['google-calendar'], starter: { label: 'What is on tomorrow?', prompt: 'What is on my calendar tomorrow, and is anything double-booked?' } },
  { needs: ['hubspot'], starter: { label: 'Review my open deals', prompt: 'Which open deals in HubSpot have gone quiet for more than a week?' } },
  { needs: ['google-ads', 'meta-ads'], starter: { label: 'How are my ads doing?', prompt: 'How are my ads performing this week compared with last week?' } },
];

/** Four starters: what the connected apps can do first, then the always-available ones. */
export function starterPrompts(channels: string[]): Starter[] {
  const have = new Set(channels.map((c) => String(c || '').toLowerCase()));
  const app = WITH_APP.filter((s) => s.needs.some((n) => have.has(n))).map((s) => s.starter);
  return [...app, ...ALWAYS].slice(0, 4);
}
