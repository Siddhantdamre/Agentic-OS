import { NextResponse } from 'next/server';
import { ensureSuperTokensInit } from '@/lib/supertokens';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Session from 'supertokens-node/recipe/session';
import { Pool } from 'pg';

ensureSuperTokensInit();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

export async function POST(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    const body = await request.json();

    // Login endpoint
    if (path.endsWith('/login') || path.endsWith('/signin')) {
      const { email, password } = body;
      const response = await EmailPassword.signIn('public', email, password);

      if (response.status === 'OK') {
        const userId = response.user.id;
        
        // Find user's org in Postgres
        const client = await pool.connect();
        try {
          const userRes = await client.query(`SELECT org_id FROM users WHERE email = $1 OR supertokens_id = $2 LIMIT 1`, [email, userId]);
          const orgId = userRes.rows[0]?.org_id || null;

          const res = NextResponse.json({
            status: 'OK',
            userId,
            email: response.user.emails?.[0] || email,
            orgId,
          });

          // Set auth cookie
          res.cookies.set('darex_session', userId, { httpOnly: true, path: '/' });
          if (orgId) res.cookies.set('darex_org_id', orgId, { httpOnly: true, path: '/' });

          return res;
        } finally {
          client.release();
        }
      } else {
        return NextResponse.json({ status: 'WRONG_CREDENTIALS_ERROR', message: 'Invalid email or password' }, { status: 400 });
      }
    }

    // Register / Signup endpoint
    if (path.endsWith('/signup') || path.endsWith('/register')) {
      const { email, password } = body;
      const response = await EmailPassword.signUp('public', email, password);

      if (response.status === 'OK') {
        const userId = response.user.id;
        const res = NextResponse.json({
          status: 'OK',
          userId,
          email: response.user.emails?.[0] || email,
        });

        res.cookies.set('darex_session', userId, { httpOnly: true, path: '/' });
        return res;
      } else {
        return NextResponse.json({ status: 'EMAIL_ALREADY_EXISTS_ERROR', message: 'Email already registered' }, { status: 400 });
      }
    }

    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  } catch (err: any) {
    console.error('SuperTokens Auth API Error:', err);
    return NextResponse.json({ message: err.message || 'Authentication error' }, { status: 500 });
  }
}
