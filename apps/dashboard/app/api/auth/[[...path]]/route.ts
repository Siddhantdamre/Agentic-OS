import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { pool, createOrgForEmail, ensureUserOrg } from '@/lib/db';
import { ensureSuperTokensInit } from '@/lib/supertokens';
import {
  applySessionCookies,
  clearSessionCookies,
  parseSessionCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REMEMBER_MAX_AGE_SECONDS,
} from '@/lib/session-cookie';
import { hashPassword, isValidEmail, normalizeEmail, verifyPassword } from '@/lib/password';
import {
  acceptInviteToken,
  insertAuthUser,
  isOnboardingComplete,
  linkSuperTokensId,
  lookupInviteByToken,
  lookupUserByEmail,
  lookupUserById,
  pgErrorCode,
  pgErrorMessage,
  updatePasswordHash,
} from '@/lib/auth-user';

ensureSuperTokensInit();

function jsonError(message: string, status: number) {
  return NextResponse.json({ status: 'ERROR', message }, { status });
}

async function issueSession(
  userId: string,
  email: string,
  orgId: string,
  onboardingComplete: boolean,
  rememberMe: boolean
) {
  const res = NextResponse.json({
    status: 'OK',
    userId,
    email,
    orgId,
    onboardingComplete,
  });
  await applySessionCookies(res, {
    userId,
    orgId,
    onboardingComplete,
    maxAgeSeconds: rememberMe ? SESSION_REMEMBER_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS,
  });
  return res;
}

async function maybeAcceptInvite(
  client: Parameters<typeof lookupInviteByToken>[0],
  userId: string,
  email: string,
  inviteToken: string | undefined,
  currentOrgId: string
): Promise<{ orgId: string; onboardingComplete: boolean }> {
  if (!inviteToken) {
    const onboardingComplete = await isOnboardingComplete(client, currentOrgId);
    return { orgId: currentOrgId, onboardingComplete };
  }
  const invite = await lookupInviteByToken(client, inviteToken);
  if (!invite) {
    const onboardingComplete = await isOnboardingComplete(client, currentOrgId);
    return { orgId: currentOrgId, onboardingComplete };
  }
  if (normalizeEmail(invite.email) !== normalizeEmail(email)) {
    throw new Error('INVITE_EMAIL_MISMATCH');
  }
  const accepted = await acceptInviteToken(client, inviteToken, userId);
  return { orgId: accepted.orgId, onboardingComplete: true };
}

// GET: Handle session check and logout
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];
  const url = new URL(request.url);

  if (pathSegments.includes('session')) {
    const cookieStore = await cookies();
    const userId = await parseSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);

    if (!userId) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    const client = await pool.connect();
    try {
      const user = await lookupUserById(client, userId);
      if (!user) {
        const res = NextResponse.json({ authenticated: false }, { status: 401 });
        clearSessionCookies(res);
        return res;
      }
      const onboardingComplete = user.org_id
        ? await isOnboardingComplete(client, user.org_id)
        : false;
      return NextResponse.json({
        authenticated: true,
        userId: user.id,
        email: user.email,
        role: user.role,
        orgId: user.org_id,
        onboardingComplete,
      });
    } finally {
      client.release();
    }
  }

  if (pathSegments.includes('logout') || pathSegments.includes('signout')) {
    const res = NextResponse.redirect(new URL('/login', url.origin));
    clearSessionCookies(res);
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
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      rememberMe?: boolean;
      inviteToken?: string;
    };
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const rememberMe = body.rememberMe !== false;
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : undefined;

    if (!email || !password) {
      return jsonError('Email and password are required', 400);
    }
    if (!isValidEmail(email)) {
      return jsonError('A valid email address is required', 400);
    }

    const isLogin = pathSegments.includes('login') || pathSegments.includes('signin');
    const isRegister = pathSegments.includes('signup') || pathSegments.includes('register');

    if (isLogin) {
      try {
        const response = await EmailPassword.signIn('public', email, password);
        if (response.status === 'OK') {
          const stUserId = response.user.id;
          const userEmail = response.user.emails?.[0] || email;
          const client = await pool.connect();
          try {
            const dbUser = await lookupUserByEmail(client, userEmail);
            if (!dbUser) {
              const orgId = await createOrgForEmail(client, userEmail);
              const sessionUserId = await insertAuthUser(client, {
                orgId,
                email: userEmail,
                role: 'owner',
                supertokensId: stUserId,
                passwordHash: hashPassword(password),
              });
              const scoped = await maybeAcceptInvite(client, sessionUserId, userEmail, inviteToken, orgId);
              return issueSession(sessionUserId, userEmail, scoped.orgId, scoped.onboardingComplete, rememberMe);
            }
            await linkSuperTokensId(client, dbUser.id, stUserId);
            if (!dbUser.password_hash) {
              await updatePasswordHash(client, dbUser.id, hashPassword(password));
            }
            const orgId = dbUser.org_id || (await ensureUserOrg(client, dbUser.id, userEmail));
            const scoped = await maybeAcceptInvite(client, dbUser.id, userEmail, inviteToken, orgId);
            return issueSession(dbUser.id, userEmail, scoped.orgId, scoped.onboardingComplete, rememberMe);
          } finally {
            client.release();
          }
        }
        if (response.status === 'WRONG_CREDENTIALS_ERROR') {
          return jsonError('Incorrect email or password.', 401);
        }
      } catch (stErr) {
        console.warn('SuperTokens signIn fallback to Postgres DB:', pgErrorMessage(stErr));
      }

      const client = await pool.connect();
      try {
        const user = await lookupUserByEmail(client, email);
        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
          return jsonError('Incorrect email or password.', 401);
        }
        const orgId = user.org_id || (await ensureUserOrg(client, user.id, user.email));
        const scoped = await maybeAcceptInvite(client, user.id, user.email, inviteToken, orgId);
        return issueSession(user.id, user.email, scoped.orgId, scoped.onboardingComplete, rememberMe);
      } finally {
        client.release();
      }
    }

    if (isRegister) {
      if (password.length < 8) {
        return jsonError('Password must be at least 8 characters.', 400);
      }

      const passwordHash = hashPassword(password);

      try {
        const response = await EmailPassword.signUp('public', email, password);
        if (response.status === 'OK') {
          const stUserId = response.user.id;
          const userEmail = response.user.emails?.[0] || email;
          const client = await pool.connect();
          try {
            const existing = await lookupUserByEmail(client, userEmail);
            if (existing) {
              return jsonError('An account with this email already exists. Please sign in.', 409);
            }
            let orgId: string;
            if (inviteToken) {
              const invite = await lookupInviteByToken(client, inviteToken);
              if (!invite || normalizeEmail(invite.email) !== userEmail) {
                orgId = await createOrgForEmail(client, userEmail);
              } else {
                orgId = invite.org_id;
              }
            } else {
              orgId = await createOrgForEmail(client, userEmail);
            }
            const sessionUserId = await insertAuthUser(client, {
              orgId,
              email: userEmail,
              role: inviteToken ? 'member' : 'owner',
              supertokensId: stUserId,
              passwordHash,
            });
            const scoped = await maybeAcceptInvite(client, sessionUserId, userEmail, inviteToken, orgId);
            return issueSession(sessionUserId, userEmail, scoped.orgId, scoped.onboardingComplete, true);
          } catch (err) {
            if (pgErrorCode(err) === '23505') {
              return jsonError('An account with this email already exists. Please sign in.', 409);
            }
            throw err;
          } finally {
            client.release();
          }
        }
        if (response.status === 'EMAIL_ALREADY_EXISTS_ERROR') {
          return jsonError('An account with this email already exists. Please sign in.', 409);
        }
      } catch (stErr) {
        console.warn('SuperTokens signUp fallback to Postgres DB:', pgErrorMessage(stErr));
      }

      const client = await pool.connect();
      try {
        const existingUser = await lookupUserByEmail(client, email);
        if (existingUser) {
          return jsonError('An account with this email already exists. Please sign in.', 409);
        }

        let orgId: string;
        let role = 'owner';
        if (inviteToken) {
          const invite = await lookupInviteByToken(client, inviteToken);
          if (invite && normalizeEmail(invite.email) === email) {
            orgId = invite.org_id;
            role = invite.role;
          } else {
            orgId = await createOrgForEmail(client, email);
          }
        } else {
          orgId = await createOrgForEmail(client, email);
        }

        const userId = await insertAuthUser(client, {
          orgId,
          email,
          role,
          supertokensId: `st_${crypto.randomUUID()}`,
          passwordHash,
        });
        const scoped = await maybeAcceptInvite(client, userId, email, inviteToken, orgId);
        return issueSession(userId, email, scoped.orgId, scoped.onboardingComplete, true);
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          return jsonError('An account with this email already exists. Please sign in.', 409);
        }
        throw err;
      } finally {
        client.release();
      }
    }

    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  } catch (err) {
    const message = pgErrorMessage(err);
    if (message.includes('INVITE_EMAIL_MISMATCH')) {
      return jsonError('This invite was sent to a different email address.', 403);
    }
    if (message.includes('USER_ALREADY_IN_ORG')) {
      return jsonError('This account already belongs to another organization.', 409);
    }
    console.error('Auth API Error:', err);
    return jsonError(message || 'Authentication error', 500);
  }
}

