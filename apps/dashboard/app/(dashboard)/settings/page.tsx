'use client';

import React, { useState, useEffect } from 'react';
import {
  Settings,
  Building,
  Users,
  Key,
  Copy,
  Check,
  Plus,
  Shield,
  X,
  Mail,
  UserPlus,
} from 'lucide-react';
import { LiveRegion } from '@/components/a11y';

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

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'general' | 'team' | 'webhooks'>('general');
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState('');
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

  // Invite modal
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setOrgName(data.org?.name || '');
        setMembers(data.members || []);
        setPendingInvites(data.pendingInvites || []);
        setWebhooks(data.webhookDetails || null);
        setWidget(data.widget || null);
        setWidgetOrigins((data.widget?.allowedOrigins || []).join('\n'));
        setMailConfigured(Boolean(data.mailConfigured));
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

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
                  Drop this script on your site. Messages persist immediately and return HTTP 200 without waiting on the model.
                  The site key is public; it cannot call admin APIs. Tenant is resolved from the key — never send <code>org_id</code>.
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
          <div className="bg-white border border-cream-300 rounded-3xl p-8 max-w-md w-full shadow-2xl space-y-6">
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
                </select>
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
