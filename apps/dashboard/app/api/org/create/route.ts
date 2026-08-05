import { NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

export async function POST(request: Request) {
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { businessName, teamSize, businessType, channels } = body;

    if (!businessName) {
      return NextResponse.json({ message: 'Business name is required' }, { status: 400 });
    }

    await client.query('BEGIN');

    // 1. Create Organization
    const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(Math.random() * 1000);
    const orgRes = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'free', 'provisioning') RETURNING id`,
      [businessName, slug]
    );
    const orgId = orgRes.rows[0].id;

    // Set session RLS context for remaining inserts
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    // 2. Create Owner User
    await client.query(
      `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner')`,
      [orgId, `owner@${slug}.com`]
    );

    // 3. Create Default Roster of AI Employees (Sales, Support, Marketing)
    const defaultEmployees = [
      { name: 'Sarah', role: 'sales', graph_id: 'sales_agent_v1', tool_allowlist: ['hubspot', 'razorpay', 'google_calendar'] },
      { name: 'Emma', role: 'support', graph_id: 'support_agent_v1', tool_allowlist: ['whatsapp', 'email', 'razorpay'] },
      { name: 'Marcus', role: 'marketing', graph_id: 'marketing_agent_v1', tool_allowlist: ['meta_ads', 'google_ads'] },
    ];

    for (const emp of defaultEmployees) {
      await client.query(
        `INSERT INTO ai_employees (org_id, name, role, graph_id, tool_allowlist, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [orgId, emp.name, emp.role, emp.graph_id, emp.tool_allowlist]
      );
    }

    // 4. Register Channels
    if (Array.isArray(channels)) {
      for (const ch of channels) {
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status) VALUES ($1, $2, 'connecting')`,
          [orgId, ch]
        );
      }
    }

    // 5. Create Onboarding State Record
    await client.query(
      `INSERT INTO org_onboarding (org_id, wizard_step, business_name, team_size, business_type, channels_selected, provisioning_started_at)
       VALUES ($1, 'complete', $2, $3, $4, $5, NOW())`,
      [orgId, businessName, teamSize, businessType, channels]
    );

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      orgId,
      slug,
      message: 'Organization created successfully',
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Org creation error:', error);
    return NextResponse.json({ message: error.message || 'Internal server error' }, { status: 500 });
  } finally {
    client.release();
  }
}
