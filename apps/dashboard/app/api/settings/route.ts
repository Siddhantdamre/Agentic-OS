import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { tryReadJson } from '@/lib/safe-json';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { lookupUserByEmail } from '@/lib/auth-user';
import { isValidEmail, normalizeEmail, randomToken, sha256Hex } from '@/lib/password';
import { appBaseUrl, sendTransactionalEmail } from '@/lib/mail';
import {
  loadWidgetSettings,
  parseAllowedOrigins,
  rotateWidgetSiteKey,
  updateWidgetAllowedOrigins,
} from '@/lib/widget-embed';
import { reserveInviteSeat } from '@/lib/usage-gate';
import { denyIfLimited } from '@/lib/rate-limit';
import { recordAuditEvent } from '@/lib/audit-events';
import { scheduleOrgPurge } from '@/lib/org-purge';

const INVITE_TTL_DAYS = 7;

type InviteRole = 'member' | 'admin' | 'billing' | 'auditor';

function parseInviteRole(value: unknown): InviteRole | null {
  if (value === 'member' || value === 'admin' || value === 'billing' || value === 'auditor') {
    return value;
  }
  if (value === undefined || value === null || value === '') return 'member';
  return null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled invite role: ${String(value)}`);
}

function roleLabel(role: InviteRole): string {
  switch (role) {
    case 'member':
      return 'member';
    case 'admin':
      return 'admin';
    case 'billing':
      return 'billing';
    case 'auditor':
      return 'auditor';
    default:
      return assertNever(role);
  }
}

function isMissingColumn(err: unknown): boolean {
  return (err as { code?: string })?.code === '42703';
}

const SUPPORT_ACCESS_UNAVAILABLE =
  'Support access opt-in is unavailable until migration 121 (orgs.support_access_enabled) is applied.';

const DELETION_UNAVAILABLE =
  'Workspace deletion is unavailable until migration 116 (orgs status lifecycle / deletion_requested_at) is applied.';

export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const orgRes = await client.query(
        'SELECT id, name, slug, plan, status, created_at FROM orgs WHERE id = $1',
        [orgId]
      );
      const org = orgRes.rows[0] || null;

      const membersRes = await client.query(
        'SELECT id, email, role, created_at FROM users WHERE org_id = $1 ORDER BY created_at ASC',
        [orgId]
      );

      const invitesRes = await client.query(
        `SELECT id, email, role, expires_at, created_at
         FROM org_invites
         WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [orgId]
      );

      const appUrl = appBaseUrl();
      const role = await loadHumanRole(client, userId);
      const canManage = canManageOrgSettings(role);
      const webhookDetails = {
        chatwootWebhookUrl: `${appUrl}/api/webhooks/chatwoot?org_id=${orgId}`,
        metaWebhookUrl: `${appUrl}/api/webhooks/whatsapp`,
        // Never leak the verify secret to members/auditors.
        verifyToken: canManage ? process.env.VERIFY_TOKEN || null : null,
      };
      const widget = await loadWidgetSettings(client, orgId, appUrl);

      let supportAccessEnabled: boolean | null = null;
      let supportAccessAvailable = true;
      try {
        const sa = await client.query<{ support_access_enabled: boolean }>(
          'SELECT support_access_enabled FROM orgs WHERE id = $1',
          [orgId]
        );
        supportAccessEnabled = Boolean(sa.rows[0]?.support_access_enabled);
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        supportAccessAvailable = false;
      }

      return NextResponse.json({
        org,
        members: membersRes.rows,
        pendingInvites: invitesRes.rows,
        webhookDetails,
        widget,
        mailConfigured: Boolean(process.env.RESEND_API_KEY),
        viewerRole: role,
        supportAccessEnabled,
        supportAccessAvailable,
        ...(supportAccessAvailable
          ? {}
          : { supportAccessError: SUPPORT_ACCESS_UNAVAILABLE }),
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/settings GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body?.orgId || body?.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }
      const { action, orgName, inviteEmail, inviteRole, allowedOrigins } = body;

      if (action === 'update_org' && typeof orgName === 'string' && orgName.trim()) {
        const name = orgName.trim();
        await client.query('UPDATE orgs SET name = $1, updated_at = NOW() WHERE id = $2', [
          name,
          orgId,
        ]);
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'settings.update',
              actor: { actorType: 'user', userId },
              action: 'settings.org_updated',
              resultStatus: 'ok',
              riskClass: 'medium',
              payload: { name },
            },
            { client, orgId }
          );
        } catch {
          // best-effort
        }
        realtimeHub.publish(orgId, { type: 'settings_updated', message: 'org' });
        return NextResponse.json({ success: true, message: 'Organization updated' });
      }

      if (action === 'invite_member') {
        const inviteLimited = denyIfLimited(
          orgId,
          'invite',
          'Team invitation rate limit exceeded. Try again later.'
        );
        if (inviteLimited) return inviteLimited;

        if (typeof inviteEmail !== 'string' || !isValidEmail(inviteEmail)) {
          return NextResponse.json({ error: 'A valid invite email is required' }, { status: 400 });
        }
        const role = parseInviteRole(inviteRole);
        if (!role) {
          return NextResponse.json(
            { error: 'Invite role must be member, admin, billing, or auditor' },
            { status: 400 }
          );
        }

        const email = normalizeEmail(inviteEmail);
        const existing = await lookupUserByEmail(client, email);
        if (existing?.org_id === orgId) {
          return NextResponse.json(
            { error: 'That email is already a member of this organization' },
            { status: 400 }
          );
        }
        if (existing?.org_id && existing.org_id !== orgId) {
          return NextResponse.json(
            { error: 'This email already belongs to another organization' },
            { status: 409 }
          );
        }

        const token = randomToken();
        const tokenHash = sha256Hex(token);
        const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

        // Seat check + invite write in one locked transaction; open invites count as seats.
        const seatBlock = await reserveInviteSeat(client, orgId, email, async () => {
          const updated = await client.query(
            `UPDATE org_invites
             SET role = $3, token_hash = $4, invited_by = $5, expires_at = $6
             WHERE org_id = $1 AND lower(email) = $2 AND accepted_at IS NULL
             RETURNING id`,
            [orgId, email, role, tokenHash, userId, expiresAt.toISOString()]
          );
          if (updated.rows.length === 0) {
            await client.query(
              `INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [orgId, email, role, tokenHash, userId, expiresAt.toISOString()]
            );
          }
        });
        if (seatBlock) {
          return NextResponse.json(
            {
              error: seatBlock.reason || 'Seat limit reached',
              seatsUsed: seatBlock.seatsUsed,
              seatLimit: seatBlock.seatLimit,
              source: seatBlock.source,
            },
            { status: 402 }
          );
        }

        const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
        const orgDisplayName = orgRes.rows[0]?.name || 'your organization';
        const inviteUrl = `${appBaseUrl()}/invite/${token}`;

        const mail = await sendTransactionalEmail({
          to: email,
          subject: `You were invited to ${orgDisplayName} on Darex`,
          text: [
            `You were invited to join ${orgDisplayName} as ${roleLabel(role)}.`,
            `Accept the invite: ${inviteUrl}`,
            `This link expires in ${INVITE_TTL_DAYS} days.`,
          ].join('\n'),
        });

        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'member.invite',
              actor: { actorType: 'user', userId },
              action: 'member.invited',
              resultStatus: 'ok',
              payload: { email, role, emailSent: mail.sent },
            },
            { client, orgId }
          );
        } catch {
          // best-effort
        }

        realtimeHub.publish(orgId, { type: 'settings_updated', message: 'invite' });
        return NextResponse.json({
          success: true,
          emailSent: mail.sent,
          emailReason: mail.sent ? undefined : mail.reason,
          inviteUrl,
          member: { email, role, expires_at: expiresAt.toISOString() },
        });
      }

      if (action === 'rotate_widget_key') {
        const rotated = await rotateWidgetSiteKey(client, orgId, appBaseUrl());
        const widget = await loadWidgetSettings(client, orgId, appBaseUrl());
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'settings.update',
              actor: { actorType: 'user', userId },
              action: 'settings.widget_key_rotated',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: {},
            },
            { client, orgId }
          );
        } catch {
          // best-effort
        }
        realtimeHub.publish(orgId, { type: 'settings_updated', message: 'widget' });
        return NextResponse.json({
          success: true,
          widget: { ...widget, siteKey: rotated.siteKey, snippet: rotated.snippet },
        });
      }

      if (action === 'update_widget_origins') {
        try {
          const origins = parseAllowedOrigins(allowedOrigins);
          const updated = await updateWidgetAllowedOrigins(client, orgId, origins);
          const widget = await loadWidgetSettings(client, orgId, appBaseUrl());
          try {
            await recordAuditEvent(
              {
                orgId,
                kind: 'settings.update',
                actor: { actorType: 'user', userId },
                action: 'settings.widget_origins_updated',
                resultStatus: 'ok',
                riskClass: 'medium',
                payload: { originCount: origins.length },
              },
              { client, orgId }
            );
          } catch {
            // best-effort
          }
          realtimeHub.publish(orgId, { type: 'settings_updated', message: 'widget' });
          return NextResponse.json({ success: true, widget: { ...widget, ...updated } });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Could not save origins';
          return NextResponse.json({ error: message }, { status: 400 });
        }
      }

      if (action === 'support_access') {
        if (role !== 'owner') {
          return NextResponse.json(
            { error: 'Only the organization owner can change support access' },
            { status: 403 }
          );
        }
        const enabled = body.enabled;
        if (typeof enabled !== 'boolean') {
          return NextResponse.json(
            { error: 'enabled must be a boolean' },
            { status: 400 }
          );
        }
        try {
          await client.query(
            'UPDATE orgs SET support_access_enabled = $1, updated_at = NOW() WHERE id = $2',
            [enabled, orgId]
          );
        } catch (err) {
          if (isMissingColumn(err)) {
            return NextResponse.json(
              { error: SUPPORT_ACCESS_UNAVAILABLE },
              { status: 503 }
            );
          }
          throw err;
        }
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'settings.update',
              actor: { actorType: 'user', userId },
              action: 'settings.support_access_updated',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: { enabled },
            },
            { client, orgId }
          );
        } catch {
          // best-effort
        }
        realtimeHub.publish(orgId, { type: 'settings_updated', message: 'support_access' });
        return NextResponse.json({
          success: true,
          supportAccessEnabled: enabled,
        });
      }

      if (action === 'request_deletion') {
        if (role !== 'owner') {
          return NextResponse.json(
            { error: 'Only the organization owner can request workspace deletion' },
            { status: 403 }
          );
        }
        if (body.confirm !== true) {
          return NextResponse.json(
            { error: 'confirm must be true to request deletion' },
            { status: 400 }
          );
        }
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 12) {
          return NextResponse.json(
            { error: 'reason must be at least 12 characters' },
            { status: 400 }
          );
        }
        try {
          await client.query(
            `UPDATE orgs
                SET status = 'soft_deleted',
                    deletion_requested_at = NOW(),
                    updated_at = NOW()
              WHERE id = $1`,
            [orgId]
          );
        } catch (err) {
          if (isMissingColumn(err)) {
            return NextResponse.json({ error: DELETION_UNAVAILABLE }, { status: 503 });
          }
          throw err;
        }
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'settings.update',
              actor: { actorType: 'user', userId },
              action: 'settings.deletion_requested',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: { reason },
            },
            { client, orgId }
          );
        } catch {
          // best-effort — skip rather than fail if kind check rejects
        }
        // Soft-delete already committed; do not await Temporal/Nango/memory.
        scheduleOrgPurge({
          orgId,
          actorUserId: userId,
          source: 'owner',
        });
        return NextResponse.json({
          success: true,
          status: 'soft_deleted',
          purge: 'scheduled',
          message: 'Workspace marked for deletion. Access is now blocked.',
        });
      }

      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('API /api/settings POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
