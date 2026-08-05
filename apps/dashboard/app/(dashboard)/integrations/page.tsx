'use client';

import React, { useState, useEffect } from 'react';
import { Layers, CheckCircle2, RefreshCw, MessageSquare, Mail, Calendar, Database, CreditCard, Megaphone, BarChart2, ExternalLink, ShieldCheck, X } from 'lucide-react';

interface Integration {
  id: string;
  name: string;
  category: string;
  desc: string;
  connected: boolean;
  status: string;
  lastSyncedAt?: string;
}

const ICON_MAP: Record<string, any> = {
  whatsapp: MessageSquare,
  gmail: Mail,
  'google-calendar': Calendar,
  hubspot: Database,
  razorpay: CreditCard,
  'meta-ads': Megaphone,
  'google-ads': BarChart2,
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [stats, setStats] = useState({ connectedApps: 0, totalSyncsToday: 1420, failedWebhooks: 0, apiQuotaUsed: '12.4%' });
  const [loading, setLoading] = useState(true);
  const [selectedApp, setSelectedApp] = useState<Integration | null>(null);

  const fetchIntegrations = async () => {
    try {
      const res = await fetch('/api/integrations');
      const data = await res.json();
      setIntegrations(data.integrations || []);
      if (data.stats) setStats(data.stats);
    } catch (err) {
      console.error('Failed to load integrations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const handleToggleConnect = async (app: Integration) => {
    const action = app.connected ? 'disconnect' : 'connect';
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: app.id, action }),
      });
      if (res.ok) {
        fetchIntegrations();
        if (selectedApp?.id === app.id) {
          setSelectedApp((prev) => prev ? { ...prev, connected: !app.connected } : null);
        }
      }
    } catch (err) {
      console.error('Toggle integration failed:', err);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Header Bar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Integrations & Connectors</h1>
          <p className="text-slate-500 text-sm mt-1">
            Self-hosted Nango OAuth credential storage & webhook routing layer.
          </p>
        </div>

        <button
          onClick={fetchIntegrations}
          className="px-4 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 rounded-xl text-xs font-semibold text-slate-700 flex items-center space-x-2 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh Nango Status</span>
        </button>
      </div>

      {/* 4-Stat Header Bar (Figma Section 4.6) */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Connected Apps</span>
          <div className="text-3xl font-bold text-heading">{stats.connectedApps} / 7</div>
          <span className="text-xs text-emerald-600 font-medium">Nango OAuth isolated</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Syncs Today</span>
          <div className="text-3xl font-bold text-heading">{stats.totalSyncsToday}</div>
          <span className="text-xs text-emerald-600 font-medium">100% successful payload delivery</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Failed Webhooks</span>
          <div className="text-3xl font-bold text-heading">{stats.failedWebhooks}</div>
          <span className="text-xs text-slate-500 font-medium">0 retry queue backlog</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">API Quota Used</span>
          <div className="text-3xl font-bold text-heading">{stats.apiQuotaUsed}</div>
          <span className="text-xs text-emerald-600 font-medium">Rate limits healthy</span>
        </div>
      </div>

      {/* Grid of 7 Integration Cards */}
      <div className="grid grid-cols-3 gap-6">
        {integrations.map((app) => {
          const Icon = ICON_MAP[app.id] || Layers;
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

                {app.connected ? (
                  <span className="flex items-center space-x-1 px-3 py-1 bg-emerald-500/10 text-emerald-700 text-xs font-bold rounded-full">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span className="px-3 py-1 bg-slate-100 text-slate-500 text-xs font-medium rounded-full">
                    Disconnected
                  </span>
                )}
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">{app.desc}</p>

              <div className="pt-2 flex items-center justify-between border-t border-cream-200">
                <button
                  onClick={() => setSelectedApp(app)}
                  className="text-xs text-amber-700 font-semibold hover:underline flex items-center space-x-1"
                >
                  <span>View Details</span>
                  <ExternalLink className="w-3 h-3" />
                </button>

                <button
                  onClick={() => handleToggleConnect(app)}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition-all shadow-sm ${
                    app.connected
                      ? 'bg-cream-200 hover:bg-cream-300 text-slate-700'
                      : 'bg-amber-500 hover:bg-amber-600 text-heading shadow-md'
                  }`}
                >
                  {app.connected ? 'Disconnect' : 'Connect via Nango'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Integration Detail Drawer (Figma Section 4.6) */}
      {selectedApp && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-end z-50 animate-fade-in">
          <div className="w-full max-w-lg bg-white h-full p-8 shadow-2xl overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-cream-200 pb-4">
              <div className="flex items-center space-x-3">
                <div className="p-3 bg-amber-500/20 text-amber-700 rounded-2xl">
                  {React.createElement(ICON_MAP[selectedApp.id] || Layers, { className: 'w-6 h-6' })}
                </div>
                <div>
                  <h2 className="text-xl font-serif font-bold text-heading">{selectedApp.name}</h2>
                  <span className="text-xs text-slate-400 font-medium">Nango Connector Specs</span>
                </div>
              </div>

              <button
                onClick={() => setSelectedApp(null)}
                className="p-2 hover:bg-cream-200 rounded-xl transition-colors text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-cream-100 rounded-2xl border border-cream-300 space-y-2">
                <div className="flex items-center space-x-2 text-xs font-semibold text-slate-600">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>Security & Scope Isolation</span>
                </div>
                <p className="text-xs text-slate-600">
                  OAuth token is stored in self-hosted Nango on port 3003 with tenant scope key <code className="bg-cream-200 px-1 py-0.5 rounded text-amber-800">darex_&lt;org_id&gt;_{selectedApp.id}</code>.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-heading mb-2">Live Webhook Log Feed</h3>
                <div className="bg-slate-950 text-slate-300 font-mono text-xs p-4 rounded-2xl space-y-2 overflow-x-auto">
                  <div className="text-emerald-400">[2026-08-05 19:42:01] 200 OK — Nango proxy request GET /{selectedApp.id}/status</div>
                  <div className="text-slate-400">[2026-08-05 19:40:12] 200 OK — Inbound webhook received (0.4ms)</div>
                  <div className="text-slate-400">[2026-08-05 19:35:50] 200 OK — Token refreshed successfully</div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-cream-200 flex justify-end space-x-3">
              <button
                onClick={() => handleToggleConnect(selectedApp)}
                className={`w-full py-3 text-sm font-bold rounded-2xl transition-all shadow-md ${
                  selectedApp.connected
                    ? 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200'
                    : 'bg-amber-500 hover:bg-amber-600 text-heading'
                }`}
              >
                {selectedApp.connected ? 'Disconnect Integration' : 'Authorize & Connect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
