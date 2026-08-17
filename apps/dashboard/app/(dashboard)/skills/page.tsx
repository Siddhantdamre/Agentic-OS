import React from 'react';
import Link from 'next/link';
import { Layers, ShieldAlert } from 'lucide-react';

type FirstPartySkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  requiresTools: string[];
};

/**
 * First-party skill versions shipped with Darex (atomic-agent custom-skills).
 * Third-party packs are design-only — see docs/current-working/marketplace-preview.md.
 * No public store. Unreviewed packs must not run in a tenant.
 */
const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  {
    id: 'calendar-playbook',
    name: 'Google Calendar',
    version: '1.0.0',
    description: 'List events, create events, free/busy.',
    requiresTools: ['mcp.darex.calendar_list_events', 'mcp.darex.calendar_create_event'],
  },
  {
    id: 'gmail-playbook',
    name: 'Gmail',
    version: '1.0.0',
    description: 'Fetch, triage, draft, and send mail.',
    requiresTools: ['mcp.darex.gmail_fetch', 'mcp.darex.gmail_send'],
  },
  {
    id: 'sheets-playbook',
    name: 'Google Sheets',
    version: '1.0.0',
    description: 'Read/write spreadsheet rows used as a system of record.',
    requiresTools: ['mcp.darex.sheets_read', 'mcp.darex.sheets_append_row'],
  },
  {
    id: 'docs-playbook',
    name: 'Google Docs',
    version: '1.0.0',
    description: 'Read and draft Google Docs.',
    requiresTools: ['mcp.darex.docs_create', 'mcp.darex.docs_read'],
  },
  {
    id: 'drive-playbook',
    name: 'Google Drive',
    version: '1.0.0',
    description: 'List and fetch Drive files.',
    requiresTools: ['mcp.darex.drive_search', 'mcp.darex.drive_get_text'],
  },
  {
    id: 'notion-playbook',
    name: 'Notion',
    version: '1.0.0',
    description: 'Search and update Notion pages.',
    requiresTools: ['mcp.darex.notion_search'],
  },
  {
    id: 'sales-crm',
    name: 'Sales CRM',
    version: '1.0.0',
    description: 'HubSpot / CRM contact and deal operations.',
    requiresTools: ['mcp.darex.hubspot_create_contact', 'mcp.darex.hubspot_update_contact'],
  },
  {
    id: 'support-tickets',
    name: 'Support tickets',
    version: '1.0.0',
    description: 'Inbox and ticket playbooks.',
    requiresTools: ['mcp.darex.zendesk_fetch_tickets', 'mcp.darex.intercom_fetch_conversations'],
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    version: '1.0.0',
    description: 'Shopify products and orders.',
    requiresTools: ['mcp.darex.shopify_fetch_products', 'mcp.darex.shopify_fetch_orders'],
  },
  {
    id: 'payments',
    name: 'Org payment links',
    version: '1.0.0',
    description:
      'Stripe/Razorpay payment links for the tenant. Not Darex SaaS billing — those live at /billing.',
    requiresTools: ['mcp.darex.stripe_create_payment_link', 'mcp.darex.razorpay_create_payment_link'],
  },
  {
    id: 'nango-integrations-playbook',
    name: 'Nango integrations',
    version: '1.0.0',
    description: 'Connector session and catalog helpers.',
    requiresTools: ['mcp.darex.gmail_fetch', 'mcp.darex.whatsapp_send'],
  },
];

export default function SkillsPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">First-party skills</h1>
        <p className="text-slate-500 text-sm mt-1">
          Versions of Darex-shipped playbooks. There is no public third-party store. Unreviewed
          packs cannot run in a tenant.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Marketplace preview (design only)</p>
          <p className="mt-1">
            Third-party packs need a written review: executor-only (no raw tokens), eval-runner
            goldens, and an admin install. See{' '}
            <code className="text-xs">docs/current-working/marketplace-preview.md</code>.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIRST_PARTY_SKILLS.map((skill) => (
          <article
            key={skill.id}
            className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-amber-700" />
                <h2 className="text-lg font-serif font-bold text-heading">{skill.name}</h2>
              </div>
              <span className="text-xs font-mono font-bold bg-cream-200 text-slate-700 px-2 py-1 rounded-lg">
                v{skill.version}
              </span>
            </div>
            <p className="text-sm text-slate-600">{skill.description}</p>
            <p className="text-xs font-mono text-slate-400">{skill.id}</p>
            <ul className="text-xs text-slate-500 space-y-1">
              {skill.requiresTools.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className="text-xs text-slate-400">
        Darex subscription billing is at{' '}
        <Link href="/billing" className="text-amber-700 font-bold">
          /billing
        </Link>
        .
      </p>
    </div>
  );
}
