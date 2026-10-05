'use client';

import React, { useState, useEffect } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import {
  Settings,
  Building,
  Users,
  Key,
  Copy,
  Check,
  Plus,
  Shield,
  ShieldAlert,
  X,
  Mail,
  UserPlus,
} from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { DsrPrivacyPanel } from '@/components/settings/DsrPrivacyPanel';

interface Member {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

interface WebhookDetails {
  chatwootWebhookUrl: string;
  metaWebhookUrl: string;
  verifyToken: string | null;
}

interface WidgetDetails {
  siteKey: string | null;
  hasActiveKey: boolean;
  snippet: string | null;
  scriptSrc: string;
  allowedOrigins: string[];
  hasPack: boolean;
}

const SETTINGS_EVENTS = ['settings_updated'] as const;

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'general' | 'team' | 'webhooks' | 'privacy'>('general');
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookDetails | null>(null);
  const [widget, setWidget] = useState<WidgetDetails | null>(null);
  const [widgetOrigins, setWidgetOrigins] = useState('');
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [mailConfigured, setMailConfigured] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ emailSent: boolean; inviteUrl?: string; emailReason?: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savingOrg, setSavingOrg] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [supportAccessEnabled, setSupportAccessEnabled] = useState(false);
  const [supportAccessAvailable, setSupportAccessAvailable] = useState(true);
  const [supportAccessError, setSupportAccessError] = useState<string | null>(null);
  const [supportAccessBusy, setSupportAccessBusy] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteDone, setDeleteDone] = useState(false);

  // Invite modal
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // `quiet` refreshes only server-owned lists. Form fields (org name, widget
  // origins) are left alone so an in-progress edit is never overwritten.
  const fetchSettings = async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      const res = await fetch('/api/settings');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) {
        if (quiet) {
          console.error('[settings] live refresh failed', res.status);
          return;
        }
        setLoadError('We couldn’t load settings. Please try again.');
        return;
      }
      const data = await res.json();
      if (!quiet) {
        setOrgName(data.org?.name || '');
        setOrgSlug(data.org?.slug || '');
        setWidgetOrigins((data.widget?.allowedOrigins || []).join('\n'));
      }
      setMembers(data.members || []);
      setPendingInvites(data.pendingInvites || []);
      setWebhooks(data.webhookDetails || null);
      setWidget(data.widget || null);
      setMailConfigured(Boolean(data.mailConfigured));
      setViewerRole(typeof data.viewerRole === 'string' ? data.viewerRole : null);
      setSupportAccessAvailable(data.supportAccessAvailable !== false);
      setSupportAccessEnabled(Boolean(data.supportAccessEnabled));
      setSupportAccessError(
        typeof data.supportAccessError === 'string' ? data.supportAccessError : null
      );
      setLoadError(null);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      if (!quiet) setLoadError('Failed to load settings');
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  useLiveRefresh({ events: SETTINGS_EVENTS, refetch: () => fetchSettings(true) });

  const handleCopy = (text: string, keyName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyName);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const applyWidgetPayload = (next: WidgetDetails | null | undefined) => {
    if (!next) return;
    setWidget(next);
    setWidgetOrigins((next.allowedOrigins || []).join('\n'));
  };

  const handleRotateWidgetKey = async () => {
    try {
      setWidgetBusy(true);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate_widget_key' }),
      });
      if (res.ok) {
        const data = await res.json();
        applyWidgetPayload(data.widget);
      }
    } catch (err) {
      console.error('Failed to rotate widget key:', err);
    } finally {
      setWidgetBusy(false);
    }
  };

  const handleSaveWidgetOrigins = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setWidgetBusy(true);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_widget_origins',
          allowedOrigins: widgetOrigins.split('\n'),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        applyWidgetPayload(data.widget);
      }
    } catch (err) {
      console.error('Failed to save widget origins:', err);
    } finally {
      setWidgetBusy(false);
    }
  };

  const handleSaveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;

    try {
      setSavingOrg(true);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_org', orgName }),
      });

      if (res.ok) {
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 3000);
      }
    } catch (err) {
      console.error('Failed to update org:', err);
    } finally {
      setSavingOrg(false);
    }
  };

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    try {
      setInviting(true);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'invite_member',
          inviteEmail,
          inviteRole,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setInviteResult({
          emailSent: Boolean(data.emailSent),
          inviteUrl: data.inviteUrl,
          emailReason: data.emailReason,
        });
        setInviteEmail('');
        fetchSettings();
      } else {
        const errData = await res.json();
        alert(errData.error || 'Failed to invite user');
      }
    } catch (err) {
      console.error('Failed to invite member:', err);
    } finally {
      setInviting(false);
    }
  };

  const handleSupportAccessToggle = async (nextEnabled: boolean) => {
    const previous = supportAccessEnabled;
    setSupportAccessEnabled(nextEnabled);
    setSupportAccessBusy(true);
    setSupportAccessError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'support_access', enabled: nextEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSupportAccessEnabled(Boolean(data.supportAccessEnabled));
        setSupportAccessAvailable(true);
        return;
      }
      setSupportAccessEnabled(previous);
      const message =
        typeof data.error === 'string'
          ? data.error
          : res.status === 503
            ? 'Support access opt-in is unavailable (migration pending).'
            : 'Failed to update support access';
      setSupportAccessError(message);
      if (res.status === 503) {
        setSupportAccessAvailable(false);
      }
    } catch (err) {
      console.error('Failed to update support access:', err);
      setSupportAccessEnabled(previous);
      setSupportAccessError('Failed to update support access');
    } finally {
      setSupportAccessBusy(false);
    }
  };

  const handleRequestDeletion = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError(null);
    if (deleteConfirmName.trim() !== orgName.trim()) {
      setDeleteError('Type the exact organization name to confirm.');
      return;
    }
    const reason = deleteReason.trim();
    if (reason.length < 12) {
      setDeleteError('Reason must be at least 12 characters.');
      return;
    }
    try {
      setDeleteBusy(true);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_deletion',
          confirm: true,
          reason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDeleteDone(true);
        return;
      }
      setDeleteError(
        typeof data.error === 'string'
          ? data.error
          : 'We couldn’t request deletion. Please try again.'
      );
    } catch (err) {
      console.error('Failed to request deletion:', err);
      setDeleteError('Failed to request deletion');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20 md:pb-12">
      <LiveRegion message={savedSuccess ? 'Organization updated' : ''} />
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Organization Settings</h1>
        <p className="text-slate-500 text-sm mt-1">
          Manage your business profile, team members, integration webhooks, and security.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center flex-wrap gap-2 border-b border-cream-300 pb-3">
        {[
          { id: 'general', label: 'General & Profile', icon: Building },
          { id: 'team', label: 'Team Members', icon: Users },
          { id: 'webhooks', label: 'Webhooks & API Keys', icon: Key },
          { id: 'privacy', label: 'Privacy & GDPR', icon: ShieldAlert },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center space-x-2 transition-all ${
                isActive
                  ? 'bg-amber-500 text-heading shadow-sm'
                  : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Content Sections */}
      {loading ? (
        <div className="h-64 bg-cream-200/50 rounded-3xl animate-pulse border border-cream-300" />
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 space-y-3">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => fetchSettings()}
            className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* TAB 1: GENERAL */}
          {activeTab === 'general' && (
            <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-6 shadow-sm max-w-2xl">
              <h2 className="text-lg font-serif font-bold text-heading">Organization Profile</h2>

              <form onSubmit={handleSaveOrg} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Business / Organization Name
                  </label>
                  <input
                    type="text"
                    required
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="flex items-center space-x-3 pt-2">
                  <button
                    type="submit"
                    disabled={savingOrg}
                    className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 font-semibold text-heading text-xs rounded-xl shadow-md transition-colors disabled:opacity-50"
                  >
                    {savingOrg ? 'Saving...' : 'Save Changes'}
                  </button>
                  {savedSuccess && (
                    <span className="text-xs font-bold text-emerald-600 flex items-center space-x-1">
                      <Check className="w-4 h-4" />
                      <span>Updated successfully</span>
                    </span>
                  )}
                </div>
              </form>

              {viewerRole === 'owner' && (
                <div className="pt-6 border-t border-cream-200 space-y-3">
                  <h3 className="text-sm font-serif font-bold text-heading flex items-center space-x-2">
                    <Shield className="w-4 h-4 text-amber-600" />
                    <span>Darex support access</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    When enabled, Darex support may start a consented, time-limited impersonation
                    session to help diagnose issues. You can turn this off at any time. Break-glass
                    operator access is separate and still audited.
                  </p>
                  {!supportAccessAvailable ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      {supportAccessError ||
                        'Support access opt-in is unavailable until migration 121 is applied.'}
                    </div>
                  ) : (
                    <label className="flex items-start space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={supportAccessEnabled}
                        disabled={supportAccessBusy}
                        onChange={(e) => handleSupportAccessToggle(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-cream-300 text-amber-600 focus:ring-amber-500 disabled:opacity-50"
                      />
                      <span className="text-sm font-medium text-heading">
                        Allow Darex support to access this organization with my consent
                      </span>
                    </label>
                  )}
                  {supportAccessAvailable && supportAccessError && (
                    <p className="text-xs text-red-700">{supportAccessError}</p>
                  )}
                  {supportAccessBusy && (
                    <p className="text-xs text-slate-500">Saving…</p>
                  )}
                </div>
              )}

              {viewerRole === 'owner' && (
                <div className="pt-6 border-t border-cream-200 space-y-3">
                  <h3 className="text-sm font-serif font-bold text-heading flex items-center space-x-2">
                    <ShieldAlert className="w-4 h-4 text-red-600" />
                    <span>Delete workspace</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    Soft-deletes this organization and immediately blocks further access. Data is
                    not wiped yet — permanent purge happens later. This cannot be undone from the
                    product.
                  </p>
                  {deleteDone ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                      Deletion requested. This workspace is now locked. Refresh or sign out if
                      pages stop loading.
                    </div>
                  ) : (
                    <form onSubmit={handleRequestDeletion} className="space-y-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                          Type &quot;{orgName || 'organization name'}&quot; to confirm
                        </label>
                        <input
                          type="text"
                          value={deleteConfirmName}
                          onChange={(e) => setDeleteConfirmName(e.target.value)}
                          autoComplete="off"
                          className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-red-400"
                          placeholder={orgName || 'Organization name'}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                          Reason (min 12 characters)
                        </label>
                        <textarea
                          value={deleteReason}
                          onChange={(e) => setDeleteReason(e.target.value)}
                          rows={3}
                          className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-red-400 resize-y"
                          placeholder="Why are you deleting this workspace?"
                        />
                      </div>
                      {deleteError && (
                        <p className="text-xs text-red-700">{deleteError}</p>
                      )}
                      <button
                        type="submit"
                        disabled={
                          deleteBusy ||
                          deleteConfirmName.trim() !== orgName.trim() ||
                          deleteReason.trim().length < 12
                        }
                        className="px-5 py-2.5 bg-red-600 hover:bg-red-700 font-semibold text-white text-xs rounded-xl shadow-md transition-colors disabled:opacity-50"
                      >
                        {deleteBusy ? 'Requesting…' : 'Request workspace deletion'}
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: TEAM MEMBERS */}
          {activeTab === 'team' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-serif font-bold text-heading">Team Members</h2>
                  <p className="text-xs text-slate-500">People with access to this business workspace</p>
                </div>
                <button
                  onClick={() => setIsInviteOpen(true)}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 font-semibold text-heading rounded-xl text-xs flex items-center space-x-2 shadow-sm"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Invite Member</span>
                </button>
              </div>

              <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-cream-100 border-b border-cream-300 text-xs font-bold text-slate-500 uppercase tracking-wider">
                      <th className="p-4">User Email</th>
                      <th className="p-4">Role</th>
                      <th className="p-4">Joined Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cream-200 text-sm">
                    {members.map((member) => (
                      <tr key={member.id} className="hover:bg-cream-50/50">
                        <td className="p-4 font-semibold text-heading flex items-center space-x-2">
                          <Mail className="w-4 h-4 text-amber-600" />
                          <span>{member.email}</span>
                        </td>
                        <td className="p-4">
                          <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-700">
                            {member.role}
                          </span>
                        </td>
                        <td className="p-4 text-slate-500 text-xs">
                          {new Date(member.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pendingInvites.length > 0 && (
                <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
                  <div className="p-4 border-b border-cream-300">
                    <h3 className="text-sm font-serif font-bold text-heading">Pending invites</h3>
                    <p className="text-xs text-slate-500">Not accepted yet. Links expire after 7 days.</p>
                  </div>
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-cream-100 border-b border-cream-300 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        <th className="p-4">Email</th>
                        <th className="p-4">Role</th>
                        <th className="p-4">Expires</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-cream-200 text-sm">
                      {pendingInvites.map((invite) => (
                        <tr key={invite.id}>
                          <td className="p-4 font-semibold text-heading">{invite.email}</td>
                          <td className="p-4 text-xs font-bold uppercase text-amber-700">{invite.role}</td>
                          <td className="p-4 text-slate-500 text-xs">
                            {new Date(invite.expires_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: PRIVACY / GDPR */}
          {activeTab === 'privacy' && (
            <DsrPrivacyPanel orgSlug={orgSlug} orgName={orgName} viewerRole={viewerRole} />
          )}

          {/* TAB 3: WEBHOOKS & API KEYS */}
          {activeTab === 'webhooks' && (
            <div className="space-y-6 max-w-3xl">
              {webhooks && (
              <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
                <h2 className="text-lg font-serif font-bold text-heading">Webhook Endpoints</h2>
                <p className="text-xs text-slate-500">Configure these URLs in your channel providers (Meta WhatsApp, Chatwoot, etc.)</p>

                <div className="space-y-4 pt-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      WhatsApp (Meta) Webhook URL
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        type="text"
                        readOnly
                        value={webhooks.metaWebhookUrl}
                        className="flex-1 px-4 py-2 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono font-medium text-slate-700"
                      />
                      <button
                        onClick={() => handleCopy(webhooks.metaWebhookUrl, 'metaUrl')}
                        className="p-2 bg-cream-200 hover:bg-cream-300 rounded-xl border border-cream-300 text-slate-700"
                      >
                        {copiedKey === 'metaUrl' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Chatwoot Webhook URL
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        type="text"
                        readOnly
                        value={webhooks.chatwootWebhookUrl}
                        className="flex-1 px-4 py-2 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono font-medium text-slate-700"
                      />
                      <button
                        onClick={() => handleCopy(webhooks.chatwootWebhookUrl, 'chatwootUrl')}
                        className="p-2 bg-cream-200 hover:bg-cream-300 rounded-xl border border-cream-300 text-slate-700"
                      >
                        {copiedKey === 'chatwootUrl' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Verify Token (Meta Webhook)
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        type="text"
                        readOnly
                        value={webhooks.verifyToken ?? 'VERIFY_TOKEN is not set'}
                        className="flex-1 px-4 py-2 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono font-medium text-slate-700"
                      />
                      <button
                        type="button"
                        disabled={!webhooks.verifyToken}
                        onClick={() => webhooks.verifyToken && handleCopy(webhooks.verifyToken, 'verifyToken')}
                        className="p-2 bg-cream-200 hover:bg-cream-300 rounded-xl border border-cream-300 text-slate-700 disabled:opacity-40"
                      >
                        {copiedKey === 'verifyToken' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              )}

              <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
                <h2 className="text-lg font-serif font-bold text-heading">Public chat widget</h2>
                <p className="text-xs text-slate-500">
                  Paste this snippet into your website to show the chat widget. Messages are saved straight away and never wait on the AI. The site key is safe to publish — it can only start chats for your business and cannot change any settings.
                </p>
                {!widget?.hasPack && (
                  <p className="text-xs text-amber-700 font-semibold">
                    Install a pack (finish onboarding) before the widget will accept messages.
                  </p>
                )}
                {widget?.snippet ? (
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Embed snippet
                    </label>
                    <div className="flex items-start space-x-2">
                      <textarea
                        readOnly
                        rows={3}
                        value={widget.snippet}
                        className="flex-1 px-4 py-2 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono font-medium text-slate-700"
                      />
                      <button
                        type="button"
                        onClick={() => handleCopy(widget.snippet || '', 'widgetSnippet')}
                        className="p-2 bg-cream-200 hover:bg-cream-300 rounded-xl border border-cream-300 text-slate-700"
                      >
                        {copiedKey === 'widgetSnippet' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    {widget.siteKey && (
                      <p className="mt-2 text-[11px] text-slate-500 font-mono break-all">Site key: {widget.siteKey}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    {widget?.hasActiveKey
                      ? 'A key exists but cannot be re-shown. Rotate to get a copyable snippet.'
                      : 'Generate a site key to copy the embed snippet.'}
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={widgetBusy}
                    onClick={handleRotateWidgetKey}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 font-semibold text-heading text-xs rounded-xl shadow-sm disabled:opacity-50"
                  >
                    {widgetBusy ? 'Working…' : widget?.hasActiveKey ? 'Rotate site key' : 'Generate site key'}
                  </button>
                </div>
                <form onSubmit={handleSaveWidgetOrigins} className="space-y-2 pt-2">
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Allowed origins (optional)
                  </label>
                  <p className="text-[11px] text-slate-500">
                    One origin per line, e.g. <code>https://www.example.com</code>. Empty allowlist accepts any origin. Use <code>*</code> to allow all.
                  </p>
                  <textarea
                    rows={3}
                    value={widgetOrigins}
                    onChange={(e) => setWidgetOrigins(e.target.value)}
                    placeholder="https://www.example.com"
                    className="w-full px-4 py-2 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono font-medium text-slate-700"
                  />
                  <button
                    type="submit"
                    disabled={widgetBusy || !widget?.hasActiveKey}
                    className="px-4 py-2 bg-cream-200 hover:bg-cream-300 font-semibold text-heading text-xs rounded-xl border border-cream-300 disabled:opacity-50"
                  >
                    Save origins
                  </button>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {/* Invite Member Modal */}
      {isInviteOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-cream-300 rounded-3xl p-8 max-w-md w-full max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-cream-200 pb-4">
              <h2 className="text-xl font-serif font-bold text-heading">Invite Team Member</h2>
              <button onClick={() => setIsInviteOpen(false)} className="p-2 text-slate-400 hover:text-heading">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleInviteMember} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@company.com"
                  className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Role
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full px-4 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm font-medium focus:outline-none focus:border-amber-500"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="billing">Billing</option>
                  <option value="auditor">Auditor</option>
                </select>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Billing manages subscriptions only. Auditor can read audit logs. Owner cannot be invited.
                </p>
              </div>

              {!mailConfigured && (
                <p className="text-xs text-slate-500">
                  Email delivery is off until <code>RESEND_API_KEY</code> (and production <code>MAIL_FROM</code>) are set. You will get a copyable invite link instead.
                </p>
              )}

              {inviteResult && (
                <div className="text-xs rounded-xl border border-cream-300 bg-cream-50 p-3 space-y-1">
                  {inviteResult.emailSent ? (
                    <p className="text-emerald-700 font-semibold">Invitation email sent.</p>
                  ) : (
                    <>
                      <p className="text-amber-700 font-semibold">
                        Invite saved, but email was not sent{inviteResult.emailReason ? `: ${inviteResult.emailReason}` : '.'}
                      </p>
                      {inviteResult.inviteUrl && (
                        <p className="break-all font-mono text-slate-700">{inviteResult.inviteUrl}</p>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="pt-4 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsInviteOpen(false)}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-cream-200 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 font-semibold text-heading text-xs rounded-xl shadow-md disabled:opacity-50"
                >
                  {inviting ? 'Inviting...' : 'Send Invitation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
