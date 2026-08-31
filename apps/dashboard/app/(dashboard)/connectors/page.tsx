'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { connectRazorpayByok, connectWhatsAppByok, disconnectProvider, startRealNangoOAuth } from '@/lib/nango-client';
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
  FolderOpen,
  FileText,
  Table,
  Check,
  ExternalLink,
  AlertCircle,
  Presentation,
  FileCheck,
  Video,
  Users,
  CheckSquare,
  TrendingUp,
  Store,
  Cloud,
} from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';

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
  authMode?: string;
  oauthConfigured?: boolean;
  missingConfigReason?: string;
  extraConnectFields?: Array<{ key: string; label: string; placeholder: string; required: boolean; secret?: boolean; type?: string }>;
  operatorHint?: string;
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
  'Productivity',
  'Meetings',
  'Contacts',
  'Analytics',
  'SEO',
  'Marketing',
  'Infrastructure',
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
  const [showRazorpayModal, setShowRazorpayModal] = useState(false);
  const [rzpKeyId, setRzpKeyId] = useState('');
  const [rzpKeySecret, setRzpKeySecret] = useState('');
  const [rzpConnecting, setRzpConnecting] = useState(false);
  const [extraModal, setExtraModal] = useState<Integration | null>(null);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});

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
      const result = await connectWhatsAppByok({ accessToken: waToken, phoneNumberId: waPhoneId, wabaId: waWabaId });
      if (result.success) {
        setStatusNotification({ type: 'success', message: 'WhatsApp connected (token verified against Meta Graph).' });
        setShowWhatsAppModal(false);
        fetchIntegrations();
      } else {
        setStatusNotification({ type: 'error', message: result.error || 'Failed to connect WhatsApp' });
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
        const result = await disconnectProvider(item.id);
        if (result.success) {
          setStatusNotification({ type: 'success', message: `Disconnected ${item.name}` });
        } else {
          setStatusNotification({ type: 'error', message: result.error || `Failed to disconnect ${item.name}` });
        }
        fetchIntegrations();
      } else if (item.authMode === 'service_account') {
        setStatusNotification({
          type: 'error',
          message: item.missingConfigReason || item.operatorHint || `${item.name} is not OAuth and cannot be connected from the dashboard.`,
        });
      } else if (item.authMode === 'byok' || item.id === 'whatsapp') {
        setShowWhatsAppModal(true);
      } else if (item.authMode === 'api_key' || item.id === 'razorpay') {
        setShowRazorpayModal(true);
      } else if ((item.extraConnectFields || []).some((f) => f.required)) {
        setExtraModal(item);
        setExtraValues({});
      } else {
        const oauthResult = await startRealNangoOAuth(item.id);
        if (oauthResult.success) {
          setStatusNotification({ type: 'success', message: `Successfully connected ${item.name} via OAuth!` });
        } else {
          setStatusNotification({
            type: 'error',
            message: oauthResult.error || `OAuth flow for ${item.name} was cancelled or closed.`,
          });
        }
        fetchIntegrations();
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
      case 'FolderOpen': return <FolderOpen className="w-6 h-6 text-sky-700" />;
      case 'FileText': return <FileText className="w-6 h-6 text-blue-700" />;
      case 'Table': return <Table className="w-6 h-6 text-emerald-700" />;
      case 'Presentation': return <Presentation className="w-6 h-6 text-orange-600" />;
      case 'FileCheck': return <FileCheck className="w-6 h-6 text-teal-700" />;
      case 'Video': return <Video className="w-6 h-6 text-green-700" />;
      case 'Users': return <Users className="w-6 h-6 text-sky-800" />;
      case 'CheckSquare': return <CheckSquare className="w-6 h-6 text-lime-700" />;
      case 'TrendingUp': return <TrendingUp className="w-6 h-6 text-rose-700" />;
      case 'Search': return <Search className="w-6 h-6 text-slate-700" />;
      case 'Store': return <Store className="w-6 h-6 text-amber-800" />;
      case 'Cloud': return <Cloud className="w-6 h-6 text-slate-600" />;
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
    <div className="max-w-7xl mx-auto space-y-8 pb-20 md:pb-16">
      <LiveRegion message={statusNotification?.message || ''} />
      {/*
        Sticky, and opaque rather than translucent, because of where the click is.
        There are 27 provider cards down a ~4,700px scroll container, so a
        Connect press happens thousands of pixels below the top of the page. This
        banner used to render in flow at the very top: the explanation existed,
        was correct, and was invisible to the person who had just asked for it —
        the button read as dead. Sticking it to the scrollport keeps the answer
        next to the question, and a solid background keeps it legible over the
        cards that now scroll underneath.
      */}
      {statusNotification && (
        <div
          className={`sticky top-0 z-40 p-4 rounded-2xl border flex items-center justify-between shadow-md text-xs font-semibold ${
            statusNotification.type === 'success'
              ? 'bg-emerald-50 border-emerald-500/30 text-emerald-800'
              : 'bg-amber-50 border-amber-500/30 text-amber-900'
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Connection Hub & Integrations</h1>
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
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

                    <StatusBadge
                      label={item.connected ? 'Connected' : 'Disconnected'}
                      tone={item.connected ? 'success' : 'neutral'}
                      icon={item.connected ? 'connected' : 'plug'}
                    />
                  </div>

                  {/* Description */}
                  <p className="text-xs text-slate-600 leading-relaxed min-h-[3rem] line-clamp-3">
                    {item.desc}
                  </p>
                </div>

                {/* Bottom Connection Action */}
                <div className="pt-4 border-t border-cream-200 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-mono flex items-center space-x-1">
                    <Link href={`/connectors/${item.id}`} className="flex items-center space-x-1 hover:text-amber-700">
                      <ExternalLink className="w-3 h-3" />
                      <span>Test & details</span>
                    </Link>
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

      {showRazorpayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white p-8 rounded-3xl max-w-lg w-full shadow-2xl space-y-6">
            <h2 className="text-2xl font-serif font-bold text-heading">Connect Razorpay</h2>
            <p className="text-sm text-slate-500">
              Keys are verified against Razorpay before this org is marked connected. Agent Razorpay tools still use RAZORPAY_KEY_ID/SECRET env.
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setRzpConnecting(true);
                const result = await connectRazorpayByok({ keyId: rzpKeyId, keySecret: rzpKeySecret });
                setRzpConnecting(false);
                if (result.success) {
                  setStatusNotification({ type: 'success', message: 'Razorpay keys verified for this org.' });
                  setShowRazorpayModal(false);
                  fetchIntegrations();
                } else {
                  setStatusNotification({ type: 'error', message: result.error || 'Razorpay connect failed' });
                }
              }}
              className="space-y-4"
            >
              <input required type="text" value={rzpKeyId} onChange={(e) => setRzpKeyId(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm" placeholder="rzp_live_..." />
              <input required type="password" value={rzpKeySecret} onChange={(e) => setRzpKeySecret(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm" placeholder="Key secret" />
              <div className="flex justify-end space-x-3 pt-2">
                <button type="button" onClick={() => setShowRazorpayModal(false)} className="px-5 py-2 text-sm font-semibold text-slate-500">Cancel</button>
                <button type="submit" disabled={rzpConnecting} className="px-5 py-2 bg-amber-500 text-heading text-sm font-semibold rounded-xl">
                  {rzpConnecting ? 'Verifying...' : 'Verify & Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {extraModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white p-8 rounded-3xl max-w-lg w-full shadow-2xl space-y-6">
            <h2 className="text-2xl font-serif font-bold text-heading">Connect {extraModal.name}</h2>
            <p className="text-sm text-slate-500">{extraModal.missingConfigReason || extraModal.operatorHint || 'These fields are required before the Nango OAuth popup.'}</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setConnectingId(extraModal.id);
                const oauthResult = await startRealNangoOAuth(extraModal.id, { extraParams: extraValues });
                setConnectingId(null);
                setExtraModal(null);
                if (oauthResult.success) {
                  setStatusNotification({ type: 'success', message: `Connected ${extraModal.name}` });
                } else {
                  setStatusNotification({ type: 'error', message: oauthResult.error || 'OAuth failed' });
                }
                fetchIntegrations();
              }}
              className="space-y-4"
            >
              {(extraModal.extraConnectFields || []).map((field) => (
                <div key={field.key} className="space-y-1">
                  <label className="text-xs font-bold text-slate-700">{field.label}</label>
                  <input
                    required={field.required}
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={extraValues[field.key] || ''}
                    onChange={(e) => setExtraValues({ ...extraValues, [field.key]: e.target.value })}
                    className="w-full px-4 py-2 border rounded-xl text-sm"
                    placeholder={field.placeholder}
                  />
                </div>
              ))}
              <div className="flex justify-end space-x-3 pt-2">
                <button type="button" onClick={() => setExtraModal(null)} className="px-5 py-2 text-sm font-semibold text-slate-500">Cancel</button>
                <button type="submit" className="px-5 py-2 bg-amber-500 text-heading text-sm font-semibold rounded-xl">Continue to OAuth</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
