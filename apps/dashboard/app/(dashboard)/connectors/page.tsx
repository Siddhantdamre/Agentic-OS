'use client';

import React, { useState, useEffect } from 'react';
import { startRealNangoOAuth } from '@/lib/nango-client';
import {
  Plug,
  MessageSquare,
  Mail,
  Calendar,
  Database,
  CreditCard,
  Megaphone,
  BarChart2,
  CheckCircle2,
  RefreshCw,
  Search,
  Zap,
  BookOpen,
  Slack,
  ShoppingBag,
  Headphones,
  MessageCircle,
  Github,
  Check,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';

interface Integration {
  id: string;
  name: string;
  category: string;
  icon: string;
  desc: string;
  connected: boolean;
  status: string;
  nangoConnectionId?: string | null;
  lastSyncedAt?: string | null;
}

const CATEGORIES = [
  'All',
  'Messaging',
  'Advertising',
  'Email',
  'Calendar',
  'CRM',
  'Payments',
  'E-Commerce',
  'Knowledge',
  'Support',
  'Development',
];

export default function ConnectorsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [statusNotification, setStatusNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Stats
  const [stats, setStats] = useState({
    connectedApps: 0,
    totalSyncsToday: 0,
    failedWebhooks: 0,
    apiQuotaUsed: '0%',
  });

  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [waToken, setWaToken] = useState('');
  const [waPhoneId, setWaPhoneId] = useState('');
  const [waWabaId, setWaWabaId] = useState('');
  const [waConnecting, setWaConnecting] = useState(false);

  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/integrations');
      if (res.ok) {
        const data = await res.json();
        setIntegrations(data.integrations || []);
        if (data.stats) setStats(data.stats);
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const handleManualWhatsAppConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setWaConnecting(true);
    setStatusNotification(null);

    try {
      const res = await fetch('/api/integrations/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: waToken, phoneNumberId: waPhoneId, wabaId: waWabaId }),
      });

      if (res.ok) {
        setStatusNotification({ type: 'success', message: 'WhatsApp manually connected successfully!' });
        setShowWhatsAppModal(false);
        fetchIntegrations();
      } else {
        const errorData = await res.json();
        setStatusNotification({ type: 'error', message: errorData.message || 'Failed to connect WhatsApp' });
      }
    } catch (err: any) {
      setStatusNotification({ type: 'error', message: err.message || 'Network error' });
    } finally {
      setWaConnecting(false);
    }
  };

  const handleToggleConnection = async (item: Integration) => {
    setStatusNotification(null);
    setConnectingId(item.id);

    try {
      if (item.connected) {
        // Disconnect
        const res = await fetch('/api/integrations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: item.id, action: 'disconnect' }),
        });

        if (res.ok) {
          setStatusNotification({ type: 'success', message: `Disconnected ${item.name}` });
          fetchIntegrations();
        }
      } else if (item.id === 'whatsapp') {
        setShowWhatsAppModal(true);
      } else {
        // Connect — Launch Real Nango OAuth Popup
        console.log(`Launching Real Nango OAuth Popup for ${item.name} (${item.id})...`);
        const oauthResult = await startRealNangoOAuth(item.id);

        if (oauthResult.success) {
          setStatusNotification({ type: 'success', message: `Successfully connected ${item.name} via OAuth!` });
          fetchIntegrations();
        } else {
          // If popup failed or fell back
          setStatusNotification({
            type: 'error',
            message: oauthResult.error || `OAuth flow for ${item.name} was cancelled or closed.`,
          });
          fetchIntegrations();
        }
      }
    } catch (err: any) {
      console.error('Failed to toggle connection:', err);
      setStatusNotification({ type: 'error', message: err.message || 'Connection error' });
      fetchIntegrations();
    } finally {
      setConnectingId(null);
    }
  };

  const renderIcon = (iconName: string) => {
    switch (iconName) {
      case 'MessageSquare': return <MessageSquare className="w-6 h-6 text-emerald-600" />;
      case 'Mail': return <Mail className="w-6 h-6 text-blue-600" />;
      case 'Calendar': return <Calendar className="w-6 h-6 text-sky-600" />;
      case 'BarChart2': return <BarChart2 className="w-6 h-6 text-red-600" />;
      case 'Megaphone': return <Megaphone className="w-6 h-6 text-purple-600" />;
      case 'Database': return <Database className="w-6 h-6 text-amber-600" />;
      case 'CreditCard': return <CreditCard className="w-6 h-6 text-indigo-600" />;
      case 'BookOpen': return <BookOpen className="w-6 h-6 text-stone-700" />;
      case 'Slack': return <Slack className="w-6 h-6 text-fuchsia-600" />;
      case 'ShoppingBag': return <ShoppingBag className="w-6 h-6 text-emerald-700" />;
      case 'Headphones': return <Headphones className="w-6 h-6 text-emerald-800" />;
      case 'MessageCircle': return <MessageCircle className="w-6 h-6 text-blue-500" />;
      case 'Github': return <Github className="w-6 h-6 text-slate-800" />;
      default: return <Plug className="w-6 h-6 text-amber-600" />;
    }
  };

  const filteredIntegrations = integrations.filter((item) => {
    const matchesSearch =
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.desc.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || item.category.toLowerCase() === selectedCategory.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-16">
      {/* Notification Toast */}
      {statusNotification && (
        <div
          className={`p-4 rounded-2xl border flex items-center justify-between shadow-md text-xs font-semibold ${
            statusNotification.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-900'
          }`}
        >
          <div className="flex items-center space-x-2">
            {statusNotification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            )}
            <span>{statusNotification.message}</span>
          </div>
          <button onClick={() => setStatusNotification(null)} className="text-slate-400 hover:text-slate-600">
            &times;
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Connection Hub & Integrations</h1>
          <p className="text-slate-500 text-sm mt-1">
            Connect your business tools via real OAuth popups (Nango Gateway running on port 3003).
          </p>
        </div>

        <button
          onClick={fetchIntegrations}
          className="px-4 py-2.5 bg-cream-200 hover:bg-cream-300 border border-cream-300 text-slate-700 font-semibold rounded-2xl flex items-center space-x-2 text-xs transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh Status</span>
        </button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Connected Tools</span>
          <div className="text-3xl font-bold text-emerald-600">{stats.connectedApps} / {integrations.length}</div>
          <span className="text-xs text-emerald-600 font-medium">Real OAuth credentials</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sync Events Today</span>
          <div className="text-3xl font-bold text-heading">{stats.totalSyncsToday}</div>
          <span className="text-xs text-slate-500 font-medium">Automated webhooks</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">OAuth Gateway</span>
          <div className="text-3xl font-bold text-heading">Port 3003</div>
          <span className="text-xs text-emerald-600 font-medium">Nango Live Server</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Security Engine</span>
          <div className="text-3xl font-bold text-heading">OAuth 2.0</div>
          <span className="text-xs text-emerald-600 font-medium">PKCE & Refresh Tokens</span>
        </div>
      </div>

      {/* Controls: Search Bar & Category Filter Pills */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
            <input
              type="text"
              placeholder="Search connectors by name or functionality..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-cream-300 rounded-2xl text-xs font-medium text-heading focus:outline-none focus:border-amber-500 shadow-sm"
            />
          </div>

          <div className="flex items-center space-x-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3.5 py-2 text-xs font-bold rounded-xl transition-all ${
                  selectedCategory === cat
                    ? 'bg-amber-500 text-heading shadow-sm'
                    : 'bg-cream-200 hover:bg-cream-300 text-slate-600'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Connectors Grid */}
      {loading && integrations.length === 0 ? (
        <div className="grid grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-56 bg-cream-200/50 rounded-3xl animate-pulse border border-cream-300" />
          ))}
        </div>
      ) : filteredIntegrations.length === 0 ? (
        <div className="bg-white border-2 border-dashed border-cream-300 rounded-3xl p-12 text-center space-y-3">
          <Plug className="w-12 h-12 text-slate-300 mx-auto" />
          <h3 className="text-lg font-bold text-heading font-serif">No Connectors Found</h3>
          <p className="text-slate-500 text-xs">Try adjusting your search query or category filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {filteredIntegrations.map((item) => {
            const isConnecting = connectingId === item.id;
            return (
              <div
                key={item.id}
                className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all flex flex-col justify-between space-y-5"
              >
                <div className="space-y-4">
                  {/* Top Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-12 h-12 rounded-2xl bg-cream-200/70 border border-cream-300 flex items-center justify-center shrink-0">
                        {renderIcon(item.icon)}
                      </div>
                      <div>
                        <h3 className="font-serif font-bold text-base text-heading">{item.name}</h3>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cream-200 text-slate-600">
                          {item.category}
                        </span>
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full flex items-center space-x-1 ${
                        item.connected
                          ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                          : 'bg-slate-100 text-slate-400 border border-slate-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${item.connected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      <span>{item.connected ? 'Connected' : 'Disconnected'}</span>
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-slate-600 leading-relaxed min-h-[3rem] line-clamp-3">
                    {item.desc}
                  </p>
                </div>

                {/* Bottom Connection Action */}
                <div className="pt-4 border-t border-cream-200 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-mono flex items-center space-x-1">
                    <ExternalLink className="w-3 h-3 text-slate-400" />
                    <span>{item.connected ? 'OAuth Verified' : 'Launch OAuth'}</span>
                  </span>

                  <button
                    onClick={() => handleToggleConnection(item)}
                    disabled={isConnecting}
                    className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition-all shadow-sm ${
                      item.connected
                        ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                        : 'bg-amber-500 hover:bg-amber-600 text-heading'
                    }`}
                  >
                    {isConnecting ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Opening OAuth...</span>
                      </>
                    ) : item.connected ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Disconnect</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        <span>Connect OAuth</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Manual WhatsApp Connect Modal */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white p-8 rounded-3xl max-w-lg w-full shadow-2xl space-y-6">
            <h2 className="text-2xl font-serif font-bold text-heading">Connect WhatsApp (BYOK)</h2>
            <p className="text-sm text-slate-500">
              Provide your Meta Developer credentials to manually connect your WhatsApp Business Account without going through OAuth App Review.
            </p>
            <form onSubmit={handleManualWhatsAppConnect} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700">Access Token (System User Token)</label>
                <input required type="password" value={waToken} onChange={e => setWaToken(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm" placeholder="EAAG..." />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700">Phone Number ID</label>
                <input required type="text" value={waPhoneId} onChange={e => setWaPhoneId(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm" placeholder="e.g. 1045..." />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700">WhatsApp Business Account ID (Optional)</label>
                <input type="text" value={waWabaId} onChange={e => setWaWabaId(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm" placeholder="e.g. 109..." />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setShowWhatsAppModal(false)} className="px-5 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
                <button type="submit" disabled={waConnecting} className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl flex items-center space-x-2">
                  {waConnecting && <RefreshCw className="w-4 h-4 animate-spin" />}
                  <span>Secure Connect</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
