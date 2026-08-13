import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

const DEFAULT_ROSTER = [
  {
    name: 'Sarah',
    role: 'Sales & Lead Gen',
    persona: 'Enthusiastic and persuasive sales specialist focused on lead qualification, product demos, and pricing negotiations.',
    tool_allowlist: ['gmail', 'whatsapp', 'hubspot'],
    status: 'active',
  },
  {
    name: 'Emma',
    role: 'Customer Support',
    persona: 'Empathetic and efficient customer support agent handling FAQs, order tracking, issue resolution, and refund processing.',
    tool_allowlist: ['gmail', 'whatsapp', 'google-calendar'],
    status: 'active',
  },
  {
    name: 'Marcus',
    role: 'Marketing & Analytics',
    persona: 'Data-driven marketing strategist monitoring campaign performance, ad conversions, customer feedback, and market trends.',
    tool_allowlist: ['meta-ads', 'google-ads', 'gmail'],
    status: 'active',
  },
];

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at 
         FROM ai_employees 
         WHERE org_id = $1 
         ORDER BY created_at ASC`,
        [orgId]
      );

      // Auto-seed default roster if empty for this org
      if (res.rows.length === 0) {
        const seeded = [];
        for (const emp of DEFAULT_ROSTER) {
          const insertRes = await client.query(
            `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status) 
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) 
             RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at`,
            [
              orgId,
              emp.name,
              emp.role,
              JSON.stringify(emp.persona),
              emp.tool_allowlist,
              `default-${emp.name.toLowerCase()}`,
              emp.status,
            ]
          );
          seeded.push(insertRes.rows[0]);
        }
        return NextResponse.json({ employees: seeded });
      }

      return NextResponse.json({ employees: res.rows });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { name, role, persona, tool_allowlist, status } = body;

      if (!name || !role) {
        return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
      }

      const tools = Array.isArray(tool_allowlist)
        ? tool_allowlist.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
        : [];
      const empStatus = status === 'paused' ? 'paused' : 'active';
      const personaJson = JSON.stringify(typeof persona === 'string' ? persona : persona ?? '');

      const res = await client.query(
        `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status) 
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) 
         RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at`,
        [orgId, name, role, personaJson, tools, `emp-${crypto.randomUUID()}`, empStatus]
      );

      return NextResponse.json({ employee: res.rows[0] }, { status: 201 });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
