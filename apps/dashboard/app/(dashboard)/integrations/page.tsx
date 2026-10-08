'use client';

import React, { useState, useEffect } from 'react';
import {
  Layers,
  CheckCircle2,
  RefreshCw,
  MessageSquare,
  Mail,
  Calendar,
  Database,
  CreditCard,
  Megaphone,
  BarChart2,
  ExternalLink,
  ShieldCheck,
  X,
  AlertCircle,
  Play,
  Terminal,
  FolderOpen,
  FileText,
  Table,
  BookOpen,
  Slack,
  ShoppingBag,
  Headphones,
  MessageCircle,
  Github,
  Presentation,
  FileCheck,
  Video,
  Users,
  CheckSquare,
  TrendingUp,
  Search,
  Store,
  Cloud,
} from 'lucide-react';
import { disconnectProvider, startRealNangoOAuth } from '@/lib/nango-client';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';

interface Integration {
  id: string;
  name: string;
  category: string;
  desc: string;
  connected: boolean;
  status: string;
  nangoConnectionId?: string | null;
  lastSyncedAt?: string | null;
  authMode?: string;
  oauthConfigured?: boolean;
  missingConfigReason?: string;
  extraConnectFields?: Array<{ key: string; label: string; placeholder: string; required: boolean }>;
  extraTestFields?: Array<{ key: string; label: string; placeholder: string; type?: string }>;
  operatorHint?: string;
}

interface LogEntry {
  channel_type: string;
  event_type: string;
  status: string;
  status_code: number;
  message: string;
  created_at: string;
}

const ICON_MAP: Record<string, any> = {
  whatsapp: MessageSquare,
  gmail: Mail,
  'google-calendar': Calendar,
  'google-drive': FolderOpen,
  'google-docs': FileText,
  'google-sheets': Table,
  'google-slides': Presentation,
  'google-forms': FileCheck,
  'google-chat': MessageSquare,
  'google-meet': Video,
  'google-contacts': Users,
  'google-tasks': CheckSquare,
  'google-analytics': TrendingUp,
  'google-search-console': Search,
  'google-business-profile': Store,
  'google-cloud': Cloud,
  hubspot: Database,
  razorpay: CreditCard,
  stripe: CreditCard,
  notion: BookOpen,
  slack: Slack,
  shopify: ShoppingBag,
  zendesk: Headphones,
  intercom: MessageCircle,
  github: Github,
  'meta-ads': Megaphone,
  'google-ads': BarChart2,
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [stats, setStats] = useState({ connectedApps: 0, totalSyncsToday: 0, failedWebhooks: 0, apiQuotaUsed: '0.0%' });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<Integration | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Test Runner state
  const [testPayload, setTestPayload] = useState<Record<string, any>>({});
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const fetchIntegrations = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/integrations');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIntegrations([]);
        setLogs([]);
        setLoadError(data.error || data.message || `Failed to load integrations (HTTP ${res.status})`);
        return;
      }
      setIntegrations(data.integrations || []);
      if (data.stats) setStats(data.stats);
      if (data.logs) setLogs(data.logs);
    } catch (err) {
      console.error('Failed to load integrations:', err);
      setIntegrations([]);
      setLogs([]);
      setLoadError(networkErrorMessage(err, 'Failed to load integrations'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const handleConnectOAuth = async (app: Integration) => {
    setConnectingId(app.id);
    setNotification(null);

    try {
      if (app.authMode === 'service_account') {
        throw new Error(app.missingConfigReason || 'This app can’t be connected here.');
      }
      if (app.authMode === 'byok' || app.id === 'whatsapp') {
        throw new Error('WhatsApp connects with an access token from Meta. Go to Connectors and paste it there; we check it with Meta before showing it as connected.');
      }
      if (app.authMode === 'api_key' || app.id === 'razorpay') {
        throw new Error('Razorpay connects with API keys. Go to Connectors and paste your key ID and key secret; we check them with Razorpay before saving.');
      }
      const extras: Record<string, string> = {};
      for (const field of app.extraConnectFields || []) {
        const value = testPayload[field.key];
        if (value) extras[field.key] = String(value);
      }
      const result = await startRealNangoOAuth(app.id, { extraParams: extras });
      if (result.success) {
        setNotification({ type: 'success', message: `${app.name} is now connected.` });
      } else {
        setNotification({ type: 'error', message: result.error || `Failed to connect ${app.name}` });
      }
      fetchIntegrations();
    } catch (err: any) {
      console.warn('Nango OAuth popup failed:', err);
      setNotification({
        type: 'error',
        message: `${app.name} not connected — ${err?.message || 'unknown error'}`,
      });
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (app: Integration) => {
    setConnectingId(app.id);
    try {
      const result = await disconnectProvider(app.id);
      if (result.success) {
        setNotification({ type: 'success', message: `${app.name} disconnected.` });
      } else {
        setNotification({ type: 'error', message: result.error || 'Failed to disconnect.' });
      }
      fetchIntegrations();
    } catch (err: any) {
      setNotification({ type: 'error', message: err.message || 'Failed to disconnect.' });
    } finally {
      setConnectingId(null);
    }
  };

  const handleRunTestCall = async (providerId: string) => {
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, payload: testPayload }),
      });
      const data = await res.json();
      setTestResult(data);
      fetchIntegrations(); // Refresh logs & stats
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTestRunning(false);
    }
  };

  const filteredLogs = logs.filter((log) => !selectedApp || log.channel_type === selectedApp.id);

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-20 md:pb-8">
      <LiveRegion message={notification?.message || ''} />
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Integrations & Connectors</h1>
          <p className="text-slate-500 text-sm mt-1">
            Connect the tools your business uses. Sign-in details are stored securely and never shared with other businesses.
          </p>
        </div>

        <button
          onClick={fetchIntegrations}
          className="px-4 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 rounded-xl text-xs font-semibold text-slate-700 flex items-center space-x-2 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh status</span>
        </button>
      </div>

      {loadError && (
        <div className="p-4 rounded-2xl border border-red-200 bg-red-50 text-red-800 text-sm font-medium flex items-start space-x-2 shadow-sm">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
          <div>
            <p className="font-semibold">Could not load integrations</p>
            <p className="text-xs mt-1 text-red-900/80">{loadError}</p>
          </div>
        </div>
      )}

      {notification && (
        <div className={`p-4 rounded-2xl border text-sm font-medium flex items-center justify-between shadow-sm ${
          notification.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          <div className="flex items-center space-x-2">
            {notification.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <AlertCircle className="w-5 h-5 text-red-600" />}
            <span>{notification.message}</span>
          </div>
          <button onClick={() => setNotification(null)} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 4-Stat Header Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Connected Tools</span>
          <div className="text-3xl font-bold text-heading">{stats.connectedApps} / {integrations.length}</div>
          <span className="text-xs text-emerald-600 font-medium">Secure sign-in</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Syncs Today</span>
          <div className="text-3xl font-bold text-heading">{stats.totalSyncsToday}</div>
          <span className="text-xs text-emerald-600 font-medium">Updates received automatically</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Failed updates</span>
          <div className="text-3xl font-bold text-heading">{stats.failedWebhooks}</div>
          <span className="text-xs text-slate-500 font-medium">Nothing waiting to retry</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">API Quota Used</span>
          <div className="text-3xl font-bold text-heading">{stats.apiQuotaUsed}</div>
          <span className="text-xs text-emerald-600 font-medium">Rate limits healthy</span>
        </div>
      </div>

      {/* Grid of 7 Integration Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        {integrations.map((app) => {
          const Icon = ICON_MAP[app.id] || Layers;
          const isBusy = connectingId === app.id;

          return (
            <div
              key={app.id}
              className={`bg-white border rounded-3xl p-6 space-y-4 shadow-sm transition-all hover:shadow-md ${
                app.connected ? 'border-amber-500/40 bg-gradient-to-b from-cream-50/50 to-white' : 'border-cream-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-3">
                  <div className={`p-3 rounded-2xl ${app.connected ? 'bg-amber-500/20 text-amber-700' : 'bg-cream-200 text-slate-500'}`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-heading">{app.name}</h3>
                    <span className="text-xs text-slate-400 font-medium">{app.category}</span>
                  </div>
                </div>

                <StatusBadge
                  label={app.connected ? 'Connected' : 'Disconnected'}
                  tone={app.connected ? 'success' : 'neutral'}
                  icon={app.connected ? 'connected' : 'plug'}
                />
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">{app.desc}</p>

              <div className="pt-2 flex items-center justify-between border-t border-cream-200">
                <button
                  onClick={() => {
                    setSelectedApp(app);
                    setTestPayload({});
                    setTestResult(null);
                  }}
                  className="touch-target text-xs text-amber-700 font-semibold hover:underline flex items-center space-x-1"
                >
                  <span>View Details & Test</span>
                  <ExternalLink className="w-3 h-3" />
                </button>

                {app.connected ? (
                  <button
                    onClick={() => handleDisconnect(app)}
                    disabled={isBusy}
                    className="px-4 py-2 bg-cream-200 hover:bg-cream-300 text-slate-700 text-xs font-bold rounded-xl transition-all shadow-sm disabled:opacity-50"
                  >
                    {isBusy ? 'Processing...' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnectOAuth(app)}
                    disabled={isBusy}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-xl transition-all shadow-md hover:shadow-lg disabled:opacity-50 flex items-center space-x-1.5"
                  >
                    <span>{isBusy ? 'Connecting...' : 'Connect'}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Integration Detail & Test Runner Drawer */}
      {selectedApp && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-end z-50 animate-fade-in">
          <div className="w-full max-w-xl bg-white h-full p-8 shadow-2xl overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-cream-200 pb-4">
              <div className="flex items-center space-x-3">
                <div className="p-3 bg-amber-500/20 text-amber-700 rounded-2xl">
                  {React.createElement(ICON_MAP[selectedApp.id] || Layers, { className: 'w-6 h-6' })}
                </div>
                <div>
                  <h2 className="text-xl font-serif font-bold text-heading">{selectedApp.name}</h2>
                  <span className="text-xs text-slate-400 font-medium">Tool details</span>
                </div>
              </div>

              <button
                onClick={() => setSelectedApp(null)}
                className="p-2 hover:bg-cream-200 rounded-xl transition-colors text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-6">
              {/* Credentials Summary */}
              <div className="p-4 bg-cream-100 rounded-2xl border border-cream-300 space-y-2">
                <div className="flex items-center space-x-2 text-xs font-semibold text-slate-600">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>Your connection</span>
                </div>
                <p className="text-xs text-slate-600">
                  Connection ID: <code className="bg-cream-200 px-1.5 py-0.5 rounded text-amber-800 font-mono">{selectedApp.nangoConnectionId}</code>
                </p>
                <p className="text-xs text-slate-500">
                  Connected with: <span className="font-semibold text-slate-700">{selectedApp.id === 'razorpay' ? 'an API key' : 'your account sign-in'}</span>
                </p>
              </div>

              {/* Interactive Test Runner Section */}
              <div className="border border-cream-300 rounded-2xl p-5 space-y-4 bg-cream-50/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Terminal className="w-4 h-4 text-amber-700" />
                    <h3 className="text-sm font-bold text-heading">Execute `@darex/connectors` Function</h3>
                  </div>
                  <span className="text-xs bg-amber-500/10 text-amber-800 font-semibold px-2.5 py-0.5 rounded-full">
                    Runs for real
                  </span>
                </div>

                {/* Form Inputs tailored by provider */}
                <div className="space-y-3">
                  {selectedApp.id === 'whatsapp' && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Recipient Phone Number</label>
                        <input
                          type="text"
                          placeholder="+14155552671"
                          value={testPayload.recipient || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, recipient: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Message Text</label>
                        <input
                          type="text"
                          placeholder="Hello from DareX AI Employee!"
                          value={testPayload.text || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, text: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                    </>
                  )}

                  {selectedApp.id === 'gmail' && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Recipient Email</label>
                        <input
                          type="email"
                          placeholder="user@example.com"
                          value={testPayload.recipient || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, recipient: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Email Content</label>
                        <input
                          type="text"
                          placeholder="Here is your requested update from DareX AI."
                          value={testPayload.text || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, text: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                    </>
                  )}

                  {selectedApp.id === 'google-calendar' && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Event Title</label>
                        <input
                          type="text"
                          placeholder="DareX AI Strategy Session"
                          value={testPayload.title || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, title: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Attendee Emails (comma separated)</label>
                        <input
                          type="text"
                          placeholder="client@example.com, manager@example.com"
                          value={testPayload.attendeesStr || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, attendeesStr: e.target.value, attendeeEmails: e.target.value.split(',').map(s=>s.trim()) })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                    </>
                  )}

                  {selectedApp.id === 'hubspot' && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Contact Email</label>
                        <input
                          type="email"
                          placeholder="lead@example.com"
                          value={testPayload.email || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, email: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="First Name"
                          value={testPayload.firstName || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, firstName: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                        <input
                          type="text"
                          placeholder="Last Name"
                          value={testPayload.lastName || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, lastName: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                    </>
                  )}

                  {selectedApp.id === 'razorpay' && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Customer Email</label>
                        <input
                          type="email"
                          placeholder="customer@example.com"
                          value={testPayload.customerEmail || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, customerEmail: e.target.value })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 block mb-1">Amount (in Paisa — e.g. 499900 = ₹4999)</label>
                        <input
                          type="number"
                          placeholder="499900"
                          value={testPayload.amountInPaisa || ''}
                          onChange={(e) => setTestPayload({ ...testPayload, amountInPaisa: parseInt(e.target.value, 10) })}
                          className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                        />
                      </div>
                    </>
                  )}

                  {selectedApp.id === 'meta-ads' && (
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Meta Ad Account ID</label>
                      <input
                        type="text"
                        placeholder="act_123456789"
                        value={testPayload.adAccountId || ''}
                        onChange={(e) => setTestPayload({ ...testPayload, adAccountId: e.target.value })}
                        className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                      />
                    </div>
                  )}

                  {selectedApp.id === 'google-ads' && (
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Google Ads Customer ID</label>
                      <input
                        type="text"
                        placeholder="123-456-7890"
                        value={testPayload.customerId || ''}
                        onChange={(e) => setTestPayload({ ...testPayload, customerId: e.target.value })}
                        className="w-full text-xs p-2.5 rounded-xl border border-cream-300 bg-white"
                      />
                    </div>
                  )}

                  <button
                    onClick={() => handleRunTestCall(selectedApp.id)}
                    disabled={testRunning}
                    className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-xl transition-all shadow-md flex items-center justify-center space-x-2"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>{testRunning ? 'Running…' : `Run ${selectedApp.name} Action`}</span>
                  </button>

                  {testResult && (
                    <div className="mt-3 p-3 bg-slate-950 text-slate-200 font-mono text-xs rounded-xl overflow-x-auto space-y-1">
                      <div className="flex items-center justify-between text-slate-400 border-b border-slate-800 pb-1">
                        <span>Response Output</span>
                        <span className={testResult.success ? 'text-emerald-400' : 'text-amber-400'}>
                          {testResult.success ? '200 OK' : 'Proxy Response'}
                        </span>
                      </div>
                      <pre className="text-[11px] whitespace-pre-wrap">{JSON.stringify(testResult, null, 2)}</pre>
                    </div>
                  )}
                </div>
              </div>

              {/* Real Database Event Logs Feed */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-heading">Recent activity</h3>
                  <span className="text-xs text-slate-400 font-medium">{filteredLogs.length} entries</span>
                </div>

                <div className="bg-slate-950 text-slate-300 font-mono text-xs p-4 rounded-2xl space-y-2 max-h-60 overflow-y-auto">
                  {filteredLogs.length === 0 ? (
                    <div className="text-slate-500 italic text-center py-4">No events logged yet for {selectedApp.name}. Execute an API action above to log events!</div>
                  ) : (
                    filteredLogs.map((log, idx) => (
                      <div key={idx} className="border-b border-slate-900 pb-1 text-[11px] space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className={log.status === 'success' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                            [{log.status_code || 200}] {log.event_type.toUpperCase()}
                          </span>
                          <span className="text-slate-500 text-[10px]">{new Date(log.created_at).toLocaleTimeString()}</span>
                        </div>
                        <div className="text-slate-300">{log.message}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Connect / Disconnect Action Footer */}
            <div className="pt-4 border-t border-cream-200 flex justify-end space-x-3">
              {selectedApp.connected ? (
                <button
                  onClick={() => handleDisconnect(selectedApp)}
                  className="w-full py-3 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-sm font-bold rounded-2xl transition-all shadow-md"
                >
                  Disconnect Integration
                </button>
              ) : (
                <button
                  onClick={() => handleConnectOAuth(selectedApp)}
                  className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-heading text-sm font-bold rounded-2xl transition-all shadow-md"
                >
                  Connect securely
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
