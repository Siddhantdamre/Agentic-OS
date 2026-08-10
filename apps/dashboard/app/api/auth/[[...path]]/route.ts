import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import crypto from 'crypto';
import { ensureUserOrg, createOrgForEmail } from '@/lib/db';

let EmailPassword: any = null;
try {
  const { ensureSuperTokensInit } = require('@/lib/supertokens');
  ensureSuperTokensInit();
  EmailPassword =
    require('supertokens-node/recipe/emailpassword').default ||
    require('supertokens-node/recipe/emailpassword');
} catch (e) {
  console.warn('SuperTokens Node SDK init fallback mode:', (e as Error).message);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD, // Must be set via env — no insecure fallback
  database: process.env.DB_NAME || 'darex',
});

/**
 * Hash a password with a random salt using scrypt (Node built-in).
 * Format: scrypt$<saltHex>$<hashHex>
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Verify a password against a stored scrypt hash.
 */
function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// GET: Handle session check and logout
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];
  const url = new URL(request.url);

  // ── /api/auth/session ──────────────────────────────────────────
  if (pathSegments.includes('session')) {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const session = cookieStore.get('darex_session')?.value;
    const orgId = cookieStore.get('darex_org_id')?.value;

    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    const client = await pool.connect();
    try {
      const userRes = await client.query(
        `SELECT id, email, role, org_id FROM users WHERE id = $1 LIMIT 1`,
        [session]
      );
      if (userRes.rows.length === 0) {
        const res = NextResponse.json({ authenticated: false }, { status: 401 });
        res.cookies.delete('darex_session');
        res.cookies.delete('darex_org_id');
        return res;
      }
      const user = userRes.rows[0];
      return NextResponse.json({
        authenticated: true,
        userId: user.id,
        email: user.email,
        role: user.role,
        orgId: user.org_id || orgId,
      });
    } finally {
      client.release();
    }
  }

  // ── /api/auth/logout ──────────────────────────────────────────
  if (pathSegments.includes('logout') || pathSegments.includes('signout')) {
    const res = NextResponse.redirect(new URL('/login', url.origin));
    res.cookies.delete('darex_session');
    res.cookies.delete('darex_org_id');
    return res;
  }

  return NextResponse.json({ message: 'Not found' }, { status: 404 });
}

// POST: Handle login and register
export async function POST(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];

  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { status: 'ERROR', message: 'Email and password are required' },
        { status: 400 }
      );
    }

    const isLogin = pathSegments.includes('login') || pathSegments.includes('signin');
    const isRegister = pathSegments.includes('signup') || pathSegments.includes('register');

    // ── LOGIN ──────────────────────────────────────────────────────
    if (isLogin) {
      // 1. Try SuperTokens if available
      if (EmailPassword) {
        try {
          const response = await EmailPassword.signIn('public', email, password);
          if (response.status === 'OK') {
            const userId = response.user.id;
            const client = await pool.connect();
            try {
              const userRes = await client.query(
                `SELECT id, org_id FROM users WHERE email = $1 OR supertokens_id = $2 LIMIT 1`,
                [email, userId]
              );
              const dbUser = userRes.rows[0];
              const orgId = dbUser?.org_id
                ? dbUser.org_id
                : dbUser
                  ? await ensureUserOrg(client, dbUser.id, email)
                  : await createOrgForEmail(client, email);
              const userEmail = response.user.emails?.[0] || email;

              // Session must reference the users.id PK, not the SuperTokens id
              const sessionUserId = dbUser?.id || userId;

              const res = NextResponse.json({ status: 'OK', userId: sessionUserId, email: userEmail, orgId });
              res.cookies.set('darex_session', sessionUserId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 7, // 7 days
              });
              res.cookies.set('darex_org_id', orgId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 7,
              });
              return res;
            } finally {
              client.release();
            }
          }
          // Wrong password from SuperTokens
          if (response.status === 'WRONG_CREDENTIALS_ERROR') {
            return NextResponse.json(
              { status: 'ERROR', message: 'Incorrect email or password.' },
              { status: 401 }
            );
          }
        } catch (stErr: any) {
          console.warn('SuperTokens signIn fallback to Postgres DB:', stErr.message);
        }
      }

      // 2. Direct Postgres Fallback Authentication (password verified, no auto-provision)
      const client = await pool.connect();
      try {
        const userRes = await client.query(
          `SELECT id, email, role, org_id, password_hash FROM users WHERE email = $1 LIMIT 1`,
          [email]
        );

        const user = userRes.rows[0];
        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
          return NextResponse.json(
            { status: 'ERROR', message: 'Incorrect email or password.' },
            { status: 401 }
          );
        }

        const orgId = user.org_id || (await ensureUserOrg(client, user.id, user.email));
        const res = NextResponse.json({ status: 'OK', userId: user.id, email: user.email, orgId });
        res.cookies.set('darex_session', user.id, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        });
        res.cookies.set('darex_org_id', orgId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        });
        return res;
      } finally {
        client.release();
      }
    }

    // ── REGISTER / SIGNUP ──────────────────────────────────────────
    if (isRegister) {
      if (EmailPassword) {
        try {
          const response = await EmailPassword.signUp('public', email, password);
          if (response.status === 'OK') {
            const userId = response.user.id;
            const client = await pool.connect();
            try {
              const orgId = await createOrgForEmail(client, email);
              await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

              // Capture the users.id PK for the session cookie (never the SuperTokens id)
              const insertRes = await client.query(
                `INSERT INTO users (org_id, email, role, supertokens_id)
                 VALUES ($1, $2, 'owner', $3)
                 ON CONFLICT (supertokens_id) DO UPDATE SET org_id = EXCLUDED.org_id
                 RETURNING id`,
                [orgId, email, userId]
              );
              const sessionUserId = insertRes.rows[0]?.id || userId;

              const userEmail = response.user.emails?.[0] || email;
              const res = NextResponse.json({ status: 'OK', userId: sessionUserId, email: userEmail, orgId });
              res.cookies.set('darex_session', sessionUserId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 7,
              });
              res.cookies.set('darex_org_id', orgId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 7,
              });
              return res;
            } finally {
              client.release();
            }
          }
          if (response.status === 'EMAIL_ALREADY_EXISTS_ERROR') {
            return NextResponse.json(
              { status: 'ERROR', message: 'An account with this email already exists. Please sign in.' },
              { status: 409 }
            );
          }
        } catch (stErr: any) {
          console.warn('SuperTokens signUp fallback to Postgres DB:', stErr.message);
        }
      }

      // Postgres Fallback Registration
      const client = await pool.connect();
      try {
        const orgId = await createOrgForEmail(client, email);
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

        const existingUser = await client.query(
          `SELECT id FROM users WHERE email = $1 LIMIT 1`,
          [email]
        );
        if (existingUser.rows.length > 0) {
          return NextResponse.json(
            { status: 'ERROR', message: 'An account with this email already exists. Please sign in.' },
            { status: 409 }
          );
        }

        const newUser = await client.query(
          `INSERT INTO users (org_id, email, role, supertokens_id, password_hash)
           VALUES ($1, $2, 'owner', $3, $4)
           RETURNING id`,
          [orgId, email, `st_${crypto.randomUUID()}`, hashPassword(password)]
        );

        const userId = newUser.rows[0].id;
        const res = NextResponse.json({ status: 'OK', userId, email, orgId });
        res.cookies.set('darex_session', userId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        });
        res.cookies.set('darex_org_id', orgId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        });
        return res;
      } finally {
        client.release();
      }
    }

    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  } catch (err: any) {
    console.error('Auth API Error:', err);
    return NextResponse.json(
      { status: 'ERROR', message: err.message || 'Authentication error' },
      { status: 500 }
    );
  }
}
