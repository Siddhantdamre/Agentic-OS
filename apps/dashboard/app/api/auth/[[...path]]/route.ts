import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { PoolClient } from 'pg';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { isSignupTermsAccepted } from '@/lib/signup-terms';
import { pool, createOrgForEmail, ensureUserOrg } from '@/lib/db';
import { ensureSuperTokensInit } from '@/lib/supertokens';
import {
  clearSessionCookies,
  parseSessionCookie,
  parseSessionCookieParts,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REMEMBER_MAX_AGE_SECONDS,
} from '@/lib/session-cookie';
import { issueSessionCookies, verifySessionCookie } from '@/lib/session-epoch';
import { hashPassword, isValidEmail, normalizeEmail, passwordLengthError, verifyPassword } from '@/lib/password';
import {
  acceptInviteToken,
  insertAuthUser,
  isOnboardingComplete,
  linkSuperTokensId,
  lookupInviteByToken,
  lookupUserByEmail,
  lookupUserById,
  markTermsAccepted,
  pgErrorCode,
  pgErrorMessage,
  updatePasswordHash,
} from '@/lib/auth-user';
import {
  clearFailedLogins,
  isAccountLocked,
  loadTotpState,
  recordFailedLogin,
} from '@/lib/auth-security';
import { verifyTotpCode } from '@/lib/totp';
import {
  clientIpFromRequest,
  denyAuthIfLimited,
} from '@/lib/rate-limit';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  emailVerificationRequired,
  isEmailVerified,
  markEmailVerified,
  sendVerificationEmail,
} from '@/lib/email-verification';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

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
  await issueSessionCookies(res, {
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
): Promise<{ orgId: string; onboardingComplete: boolean; inviteAccepted: boolean }> {
  if (!inviteToken) {
    const onboardingComplete = await isOnboardingComplete(client, currentOrgId);
    return { orgId: currentOrgId, onboardingComplete, inviteAccepted: false };
  }
  const invite = await lookupInviteByToken(client, inviteToken);
  if (!invite) {
    const onboardingComplete = await isOnboardingComplete(client, currentOrgId);
    return { orgId: currentOrgId, onboardingComplete, inviteAccepted: false };
  }
  if (normalizeEmail(invite.email) !== normalizeEmail(email)) {
    throw new Error('INVITE_EMAIL_MISMATCH');
  }
  const accepted = await acceptInviteToken(client, inviteToken, userId);
  return { orgId: accepted.orgId, onboardingComplete: true, inviteAccepted: true };
}

/**
 * After a password signup: an accepted invite proves the address (it was sent
 * there), so mark it verified; otherwise email a verification link. Returns a
 * no-session response when verification is enforced, null to continue login.
 */
async function afterRegister(
  client: PoolClient,
  userId: string,
  email: string,
  inviteAccepted: boolean
) {
  if (inviteAccepted) {
    await markEmailVerified(client, userId);
    return null;
  }
  try {
    await sendVerificationEmail(client, email);
  } catch (err) {
    console.error('[auth] verification email failed:', pgErrorMessage(err));
  }
  if (!emailVerificationRequired()) return null;
  return NextResponse.json({ status: 'VERIFY_EMAIL', email }, { status: 202 });
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
    const session = await parseSessionCookieParts(cookieStore.get(SESSION_COOKIE)?.value);

    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
    const { userId, epoch: cookieEpoch } = session;

    const client = await pool.connect();
    try {
      const user = await lookupUserById(client, userId);
      if (!user) {
        const res = NextResponse.json({ authenticated: false }, { status: 401 });
        clearSessionCookies(res);
        return res;
      }

      let sessionEpoch = 0;
      try {
        const epochRes = await client.query<{ session_epoch: number }>(
          `SELECT session_epoch FROM users WHERE id = $1 LIMIT 1`,
          [userId]
        );
        sessionEpoch = Number(epochRes.rows[0]?.session_epoch ?? 0);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42703') throw err;
        sessionEpoch = 0;
      }
      if (cookieEpoch !== sessionEpoch) {
        const res = NextResponse.json({ authenticated: false }, { status: 401 });
        clearSessionCookies(res);
        return res;
      }

      const onboardingComplete = user.org_id
        ? await isOnboardingComplete(client, user.org_id)
        : false;

      let isPlatformAdmin = false;
      try {
        await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
        const paRes = await client.query<{ platform_role: string }>(
          `SELECT platform_role FROM platform_admins WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        const role = paRes.rows[0]?.platform_role;
        isPlatformAdmin = role === 'operator' || role === 'support';
      } catch {
        isPlatformAdmin = false;
      }

      return NextResponse.json({
        authenticated: true,
        userId: user.id,
        email: user.email,
        role: user.role,
        orgId: user.org_id,
        onboardingComplete,
        isPlatformAdmin,
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
async function auditLoginDenied(
  orgId: string | null | undefined,
  userId: string,
  reason: 'wrong_password' | 'bad_mfa' | 'locked' | 'unverified_email'
): Promise<void> {
  if (!orgId) return;
  try {
    await recordAuditEvent({
      orgId,
      kind: 'login',
      actor: { actorType: 'user', userId },
      action: 'auth.login',
      resultStatus: 'denied',
      payload: { method: 'password', reason },
    });
  } catch {
    // forensic trail is best-effort; never block the auth response
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];
  const ip = clientIpFromRequest(request);

  try {
    const body = (await jsonBodyOrEmpty(request)) as {
      email?: string;
      password?: string;
      rememberMe?: boolean;
      inviteToken?: string;
      mfaCode?: string;
      agreedTerms?: boolean;
    };
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const rememberMe = body.rememberMe !== false;
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : undefined;
    const mfaCode = typeof body.mfaCode === 'string' ? body.mfaCode : '';

    if (!email || !password) {
      return jsonError('Email and password are required', 400);
    }
    if (!isValidEmail(email)) {
      return jsonError('A valid email address is required', 400);
    }

    const isLogin = pathSegments.includes('login') || pathSegments.includes('signin');
    const isRegister = pathSegments.includes('signup') || pathSegments.includes('register');

    if (isLogin) {
      const limited = denyAuthIfLimited(ip, 'login');
      if (limited) return limited;
      // Also key by email to slow credential stuffing against one account.
      const emailLimited = denyAuthIfLimited(`email:${email}`, 'login');
      if (emailLimited) return emailLimited;

      const finishLogin = async (
        client: PoolClient,
        userId: string,
        userEmail: string,
        orgId: string
      ) => {
        const locked = await isAccountLocked(client, userId);
        if (locked.locked) {
          await auditLoginDenied(orgId, userId, 'locked');
          return jsonError('Account temporarily locked due to failed sign-in attempts. Try again later.', 423);
        }
        if (emailVerificationRequired() && !(await isEmailVerified(client, userId))) {
          await auditLoginDenied(orgId, userId, 'unverified_email');
          return NextResponse.json(
            { status: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address before signing in.' },
            { status: 403 }
          );
        }
        const totp = await loadTotpState(client, userId);
        if (totp.enabled && totp.secret) {
          if (!mfaCode) {
            return NextResponse.json(
              { status: 'MFA_REQUIRED', message: 'Authenticator code required' },
              { status: 401 }
            );
          }
          if (!verifyTotpCode(totp.secret, mfaCode)) {
            await recordFailedLogin(client, userId);
            await auditLoginDenied(orgId, userId, 'bad_mfa');
            return jsonError('Invalid authenticator code.', 401);
          }
        }
        await clearFailedLogins(client, userId);
        const scoped = await maybeAcceptInvite(client, userId, userEmail, inviteToken, orgId);
        try {
          await recordAuditEvent({
            orgId: scoped.orgId,
            kind: 'login',
            actor: { actorType: 'user', userId },
            action: 'auth.login',
            resultStatus: 'ok',
            payload: { method: 'password', mfa: totp.enabled },
          });
        } catch {
          // best-effort
        }
        return issueSession(userId, userEmail, scoped.orgId, scoped.onboardingComplete, rememberMe);
      };

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
              return await finishLogin(client, sessionUserId, userEmail, orgId);
            }
            await linkSuperTokensId(client, dbUser.id, stUserId);
            if (!dbUser.password_hash) {
              await updatePasswordHash(client, dbUser.id, hashPassword(password));
            }
            const orgId = dbUser.org_id || (await ensureUserOrg(client, dbUser.id, userEmail));
            return await finishLogin(client, dbUser.id, userEmail, orgId);
          } finally {
            client.release();
          }
        }
        if (response.status === 'WRONG_CREDENTIALS_ERROR') {
          const client = await pool.connect();
          try {
            const u = await lookupUserByEmail(client, email);
            if (u) {
              await recordFailedLogin(client, u.id);
              await auditLoginDenied(u.org_id, u.id, 'wrong_password');
            }
          } finally {
            client.release();
          }
          return jsonError('Incorrect email or password.', 401);
        }
      } catch (stErr) {
        console.warn('SuperTokens signIn fallback to Postgres DB:', pgErrorMessage(stErr));
      }

      const client = await pool.connect();
      try {
        const user = await lookupUserByEmail(client, email);
        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
          if (user) {
            await recordFailedLogin(client, user.id);
            await auditLoginDenied(user.org_id, user.id, 'wrong_password');
          }
          return jsonError('Incorrect email or password.', 401);
        }
        const orgId = user.org_id || (await ensureUserOrg(client, user.id, user.email));
        return await finishLogin(client, user.id, user.email, orgId);
      } finally {
        client.release();
      }
    }

    if (isRegister) {
      if (!isSignupTermsAccepted(body.agreedTerms)) {
        return jsonError('Please agree to the Terms of Service & Privacy Policy.', 400);
      }
      const limited = denyAuthIfLimited(ip, 'register');
      if (limited) return limited;

      const lengthError = passwordLengthError(password);
      if (lengthError) {
        return jsonError(lengthError, 400);
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
            await markTermsAccepted(client, sessionUserId, orgId);
            const scoped = await maybeAcceptInvite(client, sessionUserId, userEmail, inviteToken, orgId);
            try {
              await recordAuditEvent({
                orgId: scoped.orgId,
                kind: 'register',
                actor: { actorType: 'user', userId: sessionUserId },
                action: 'auth.register',
                resultStatus: 'ok',
              });
            } catch {
              // best-effort
            }
            const verifyGate = await afterRegister(client, sessionUserId, userEmail, scoped.inviteAccepted);
            if (verifyGate) return verifyGate;
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
        await markTermsAccepted(client, userId, orgId);
        const scoped = await maybeAcceptInvite(client, userId, email, inviteToken, orgId);
        try {
          await recordAuditEvent({
            orgId: scoped.orgId,
            kind: 'register',
            actor: { actorType: 'user', userId },
            action: 'auth.register',
            resultStatus: 'ok',
          });
        } catch {
          // best-effort
        }
        const verifyGate = await afterRegister(client, userId, email, scoped.inviteAccepted);
        if (verifyGate) return verifyGate;
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
    // Never echo raw exception / DB text to the client.
    return jsonError('Authentication error', 500);
  }
}

