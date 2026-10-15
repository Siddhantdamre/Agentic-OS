'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { connectRazorpayByok, disconnectProvider, startRealNangoOAuth } from '@/lib/nango-client';
import WhatsAppConnectModal from '@/components/connectors/whatsapp-connect-modal';
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
  Activity,
  Sparkles,
  X,
} from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';

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
  /** Safe-to-show identity of the connection (never a token). */
  meta?: { provider?: string; phone?: string; verifiedName?: string; tokenHint?: string };
  /** WhatsApp only: every linked number (the primary is the card itself). */
  whatsappNumbers?: Array<{
    id: string;
    primary: boolean;
    provider: string;
    connected: boolean;
    pairing: boolean;
    phone: string | null;
    name: string | null;
  }>;
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

const lastAutoStart: { id: string; at: number } = { id: '', at: 0 };

function claimAutoStart(id: string): boolean {
  const now = Date.now();
  if (lastAutoStart.id === id && now - lastAutoStart.at < 3000) return false;
  lastAutoStart.id = id;
  lastAutoStart.at = now;
  return true;
}

function ConnectorsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const connectTarget = searchParams?.get('connect') || '';
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
  const [waStartAt, setWaStartAt] = useState<'choose' | 'auto-reply'>('choose');
  // Extra numbers: `waAdd` links a new one, `waChannelId` edits one already linked.
  const [waAdd, setWaAdd] = useState(false);
  const [waChannelId, setWaChannelId] = useState<string | null>(null);
  const [showRazorpayModal, setShowRazorpayModal] = useState(false);
  const [rzpKeyId, setRzpKeyId] = useState('');
  const [rzpKeySecret, setRzpKeySecret] = useState('');
  const [rzpConnecting, setRzpConnecting] = useState(false);
  const [extraModal, setExtraModal] = useState<Integration | null>(null);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [nangoPublicKeyConfigured, setNangoPublicKeyConfigured] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Google Workspace Single-Connect & Suite Diagnostics
  const [gwConnecting, setGwConnecting] = useState(false);
  const [gwTesting, setGwTesting] = useState(false);
  const [gwDiagnosticResult, setGwDiagnosticResult] = useState<any | null>(null);
  const [showGwModal, setShowGwModal] = useState(false);

  const openWhatsApp = (start: 'choose' | 'auto-reply', opts: { add?: boolean; channelId?: string } = {}) => {
    setWaStartAt(start);
    setWaAdd(opts.add === true);
    setWaChannelId(opts.channelId ?? null);
    setShowWhatsAppModal(true);
  };

  const disconnectWhatsAppNumberById = async (channelId: string) => {
    setStatusNotification(null);
    try {
      const res = await fetch(`/api/integrations/whatsapp/numbers?channelId=${encodeURIComponent(channelId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      setStatusNotification({
        type: res.ok ? 'success' : 'error',
        message: data.message || (res.ok ? 'WhatsApp number disconnected' : `HTTP ${res.status}`),
      });
      await fetchIntegrations();
    } catch (err: any) {
      setStatusNotification({ type: 'error', message: err.message || 'Connection error' });
    }
  };

  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await fetch('/api/integrations');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIntegrations([]);
        setLoadError(data.error || data.message || `Failed to load connectors (HTTP ${res.status})`);
        return;
      }
      setIntegrations(data.integrations || []);
      if (data.stats) setStats(data.stats);
      if (data.nango && typeof data.nango.publicKeyConfigured === 'boolean') {
        setNangoPublicKeyConfigured(data.nango.publicKeyConfigured);
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
      setIntegrations([]);
      setLoadError(networkErrorMessage(err, 'Failed to load connectors'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);


  const isGoogleWorkspaceConnected =
    integrations.some((i) => (i.id === 'google-workspace' || i.id === 'google') && i.connected) ||
    integrations.filter((i) => i.id.startsWith('google') || i.id === 'gmail').some((i) => i.connected);

  const googleConnectedCount = integrations.filter(
    (i) => (i.id.startsWith('google') || i.id === 'gmail') && i.connected
  ).length;

  const handleConnectGoogleWorkspace = async () => {
    setGwConnecting(true);
    setStatusNotification(null);
    try {
      const oauthResult = await startRealNangoOAuth('google');
      if (oauthResult.success) {
        setStatusNotification({
          type: 'success',
          message: 'Google Workspace connected! All Workspace services (Gmail, Calendar, Drive, Docs, Sheets, etc.) are active.',
        });
        await fetchIntegrations();
      } else {
        setStatusNotification({
          type: 'error',
          message: oauthResult.error || 'Google Workspace authorization was cancelled or closed.',
        });
      }
    } catch (err: any) {
      setStatusNotification({ type: 'error', message: err.message || 'Connection error' });
    } finally {
      setGwConnecting(false);
    }
  };

  const handleDisconnectGoogleWorkspace = async () => {
    setGwConnecting(true);
    setStatusNotification(null);
    try {
      const result = await disconnectProvider('google-workspace');
      if (result.success) {
        setStatusNotification({
          type: 'success',
          message: 'Google Workspace and all associated apps disconnected.',
        });
        await fetchIntegrations();
      } else {
        setStatusNotification({
          type: 'error',
          message: result.error || 'Failed to disconnect Google Workspace.',
        });
      }
    } catch (err: any) {
      setStatusNotification({ type: 'error', message: err.message || 'Disconnect error' });
    } finally {
      setGwConnecting(false);
    }
  };

  const handleTestGoogleWorkspace = async () => {
    setGwTesting(true);
    setShowGwModal(true);
    setGwDiagnosticResult(null);
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google-workspace' }),
      });
      const data = await res.json();
      setGwDiagnosticResult(data.result || data);
    } catch (err: any) {
      setGwDiagnosticResult({
        ok: false,
        message: err.message || 'Network error running Google Workspace diagnostic',
        services: [],
      });
    } finally {
      setGwTesting(false);
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
          message: item.missingConfigReason || item.operatorHint || `${item.name} can’t be connected from the dashboard.`,
        });
      } else if (item.authMode === 'byok' || item.id === 'whatsapp') {
        openWhatsApp('choose');
      } else if (item.authMode === 'api_key' || item.id === 'razorpay') {
        setShowRazorpayModal(true);
      } else if (item.oauthConfigured === false) {
        // Skip the popup: the OAuth app is not registered, so it can only fail.
        setStatusNotification({
          type: 'error',
          message:
            item.missingConfigReason ||
            item.operatorHint ||
            `Connecting ${item.name} isn’t switched on yet. Ask your administrator to set it up.`,
        });
      } else if ((item.extraConnectFields || []).some((f) => f.required)) {
        setExtraModal(item);
        setExtraValues({});
      } else {
        const oauthResult = await startRealNangoOAuth(item.id);
        if (oauthResult.success) {
          setStatusNotification({ type: 'success', message: `Connected ${item.name}.` });
        } else {
          setStatusNotification({
            type: 'error',
            message: oauthResult.error || `The ${item.name} sign-in was cancelled or closed.`,
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

  const toggleRef = useRef(handleToggleConnection);
  toggleRef.current = handleToggleConnection;

  useEffect(() => {
    if (!connectTarget || loading || loadError) return;
    if (!claimAutoStart(connectTarget)) return;
    const item = integrations.find((row) => row.id === connectTarget);
    router.replace('/connectors', { scroll: false });
    if (!item) {
      setStatusNotification({ type: 'error', message: `No connector matches “${connectTarget}”.` });
      return;
    }
    if (item.connected) {
      setStatusNotification({ type: 'success', message: `${item.name} is already signed in.` });
      return;
    }
    void toggleRef.current(item);
  }, [connectTarget, loading, loadError, integrations, router]);

  const renderIcon = (iconName: string) => {
    switch (iconName) {
      case 'MessageSquare': return <MessageSquare className="w-6 h-6 text-emerald-700" />;
      case 'Mail': return <Mail className="w-6 h-6 text-blue-600" />;
      case 'Calendar': return <Calendar className="w-6 h-6 text-sky-600" />;
      case 'BarChart2': return <BarChart2 className="w-6 h-6 text-red-600" />;
      case 'Megaphone': return <Megaphone className="w-6 h-6 text-purple-600" />;
      case 'Database': return <Database className="w-6 h-6 text-amber-700" />;
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
      case 'Activity': return <Activity className="w-6 h-6 text-amber-700" />;
      case 'Sparkles': return <Sparkles className="w-6 h-6 text-amber-700" />;
      default: return <Plug className="w-6 h-6 text-amber-700" />;
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

      {loadError ? (
        <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Could not load connectors</p>
            <p className="text-xs mt-1 text-red-900/80">{loadError}</p>
          </div>
        </div>
      ) : null}

      {!nangoPublicKeyConfigured ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Connecting tools isn’t switched on yet</p>
            <p className="text-xs mt-1 text-amber-900/80">
              Ask the person who set this up to switch on app connections for your workspace. Until then the Connect
              buttons cannot start — nothing is pretended to be connected.
            </p>
          </div>
        </div>
      ) : null}

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
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
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
            Connect your business tools. You sign in on the tool’s own page — we never see your password.
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
          <div className="text-3xl font-bold text-emerald-700">{stats.connectedApps} / {integrations.length}</div>
          <span className="text-xs text-emerald-700 font-medium">Securely signed in</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sync Events Today</span>
          <div className="text-3xl font-bold text-heading">{stats.totalSyncsToday}</div>
          <span className="text-xs text-slate-500 font-medium">Received automatically</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Connection service</span>
          <div className="text-3xl font-bold text-heading">Ready</div>
          <span className="text-xs text-emerald-700 font-medium">Running</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sign-in security</span>
          <div className="text-3xl font-bold text-heading">Secure</div>
          <span className="text-xs text-emerald-700 font-medium">Renews automatically</span>
        </div>
      </div>

      {/* Google Workspace Unified Connection Card */}
      <div className="relative overflow-hidden rounded-3xl border border-cream-300 bg-gradient-to-br from-white via-cream-100/50 to-amber-500/10 p-6 sm:p-8 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-3 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-500/20 text-amber-800">
                <Sparkles className="w-4 h-4 text-amber-700" />
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-amber-800">
                Single Connect Suite
              </span>
              {isGoogleWorkspaceConnected && (
                <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{googleConnectedCount > 0 ? `${googleConnectedCount} Google Apps Active` : 'Connected'}</span>
                </span>
              )}
            </div>

            <div>
              <h2 className="text-xl sm:text-2xl font-serif font-bold text-heading">
                Google Workspace (All-in-One Connect)
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 mt-1 leading-relaxed">
                Connect once to authorize <strong className="text-heading font-semibold">Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, and Tasks</strong> simultaneously with zero redundant logins.
              </p>
            </div>

            {/* Service Badges */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {[
                { name: 'Gmail', icon: Mail },
                { name: 'Calendar', icon: Calendar },
                { name: 'Drive', icon: FolderOpen },
                { name: 'Docs', icon: FileText },
                { name: 'Sheets', icon: Table },
                { name: 'Slides', icon: Presentation },
                { name: 'Forms', icon: FileCheck },
                { name: 'Contacts', icon: Users },
                { name: 'Tasks', icon: CheckSquare },
              ].map((svc) => {
                const IconComponent = svc.icon;
                return (
                  <span
                    key={svc.name}
                    className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-xl text-[11px] font-medium bg-white/90 border border-cream-300 text-slate-700 shadow-2xs"
                  >
                    <IconComponent className="w-3 h-3 text-slate-500" />
                    <span>{svc.name}</span>
                  </span>
                );
              })}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end justify-center gap-2.5 shrink-0">
            {isGoogleWorkspaceConnected ? (
              <>
                <button
                  type="button"
                  onClick={handleTestGoogleWorkspace}
                  disabled={gwTesting}
                  className="px-5 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-2xl flex items-center justify-center space-x-2 text-xs shadow-sm transition-all"
                >
                  <Activity className={`w-4 h-4 ${gwTesting ? 'animate-spin' : ''}`} />
                  <span>{gwTesting ? 'Testing Services...' : 'Test All Services (Diagnostic)'}</span>
                </button>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={handleConnectGoogleWorkspace}
                    disabled={gwConnecting}
                    className="px-3.5 py-2 bg-cream-200 hover:bg-cream-300 text-slate-700 font-semibold rounded-xl text-xs transition-all flex items-center space-x-1.5"
                    title="Re-authorize with latest scopes"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${gwConnecting ? 'animate-spin' : ''}`} />
                    <span>Re-auth</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDisconnectGoogleWorkspace}
                    disabled={gwConnecting}
                    className="px-3.5 py-2 bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 font-semibold rounded-xl text-xs transition-all"
                  >
                    Disconnect Suite
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={handleConnectGoogleWorkspace}
                disabled={gwConnecting}
                className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-heading font-bold rounded-2xl flex items-center justify-center space-x-2 text-sm shadow-md transition-all"
              >
                {gwConnecting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Opening Google sign-in...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 fill-heading" />
                    <span>Connect Google Workspace</span>
                  </>
                )}
              </button>
            )}
          </div>
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

                    {!item.connected && item.authMode === 'oauth' && item.oauthConfigured === false ? (
                      <span title={item.missingConfigReason || 'Connecting this app isn’t switched on yet.'}>
                        <StatusBadge label="Needs setup" tone="warning" icon="warn" />
                      </span>
                    ) : (
                      <StatusBadge
                        label={item.connected ? 'Connected' : 'Disconnected'}
                        tone={item.connected ? 'success' : 'neutral'}
                        icon={item.connected ? 'connected' : 'plug'}
                      />
                    )}
                  </div>

                  {/* Description */}
                  <p className="text-xs text-slate-600 leading-relaxed min-h-[3rem] line-clamp-3">
                    {item.desc}
                  </p>
                  {item.id === 'whatsapp' && item.connected && (
                    <p className="text-[11px] text-slate-500" data-testid="whatsapp-identity">
                      {item.meta?.provider === 'evolution' ? 'Linked by QR' : 'Official API'}
                      {item.meta?.phone ? ` · ${item.meta.phone}` : ''}
                      {item.meta?.verifiedName ? ` · ${item.meta.verifiedName}` : ''}
                      {item.meta?.tokenHint ? ` · token ${item.meta.tokenHint}` : ''}
                    </p>
                  )}
                  {item.id === 'whatsapp' && (item.whatsappNumbers || []).some((n) => !n.primary) && (
                    <ul className="space-y-1.5" data-testid="whatsapp-extra-numbers">
                      {(item.whatsappNumbers || [])
                        .filter((n) => !n.primary)
                        .map((n) => (
                          <li key={n.id} className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                            <span className="truncate">
                              {n.provider === 'evolution' ? 'Linked by QR' : 'Official API'}
                              {n.phone ? ` · ${n.phone}` : ''}
                              {n.name ? ` · ${n.name}` : ''}
                              {n.connected ? '' : n.pairing ? ' · waiting for scan' : ' · not linked'}
                            </span>
                            <span className="flex gap-1 shrink-0">
                              {n.connected && (
                                <button
                                  onClick={() => openWhatsApp('auto-reply', { channelId: n.id })}
                                  className="px-2 py-1 rounded-lg font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-700"
                                >
                                  Auto-reply
                                </button>
                              )}
                              <button
                                onClick={() => disconnectWhatsAppNumberById(n.id)}
                                className="px-2 py-1 rounded-lg font-bold bg-slate-100 hover:bg-slate-200 text-slate-700"
                              >
                                Disconnect
                              </button>
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                  {item.id === 'whatsapp' && item.connected && (
                    <button
                      onClick={() => openWhatsApp('choose', { add: true })}
                      className="text-[11px] font-bold text-amber-700 hover:text-amber-800"
                    >
                      + Add another number
                    </button>
                  )}
                </div>

                {/* Bottom Connection Action */}
                <div className="pt-4 border-t border-cream-200 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-mono flex items-center space-x-1">
                    <Link href={`/connectors/${item.id}`} className="touch-target flex items-center space-x-1 hover:text-amber-700">
                      <ExternalLink className="w-3 h-3" />
                      <span>Test & details</span>
                    </Link>
                  </span>

                  {item.id === 'whatsapp' && item.connected && (
                    <button
                      onClick={() => openWhatsApp('auto-reply')}
                      className="px-4 py-2 rounded-xl text-xs font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-700"
                    >
                      Auto-reply
                    </button>
                  )}
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
                        <span>
                          {item.connected
                            ? 'Disconnecting...'
                            : item.authMode === 'byok' || item.authMode === 'api_key'
                              ? 'Opening form...'
                              : 'Opening sign-in...'}
                        </span>
                      </>
                    ) : item.connected ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-700" />
                        <span>Disconnect</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        <span>
                          {item.authMode === 'byok' || item.authMode === 'api_key'
                            ? 'Connect'
                            : 'Connect'}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <WhatsAppConnectModal
        open={showWhatsAppModal}
        startAt={waStartAt}
        add={waAdd}
        channelId={waChannelId}
        onClose={() => setShowWhatsAppModal(false)}
        onConnected={(message) => {
          setStatusNotification({ type: 'success', message });
          setShowWhatsAppModal(false);
          fetchIntegrations();
        }}
      />

      {showRazorpayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white p-8 rounded-3xl max-w-lg w-full shadow-2xl space-y-6">
            <h2 className="text-2xl font-serif font-bold text-heading">Connect Razorpay</h2>
            <p className="text-sm text-slate-500">
              Keys are verified against Razorpay before this org is marked connected. Agent tools use these per-org keys.
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
            <p className="text-sm text-slate-500">{extraModal.missingConfigReason || extraModal.operatorHint || 'Fill these in before you sign in.'}</p>
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
                  setStatusNotification({ type: 'error', message: oauthResult.error || 'The sign-in didn’t work.' });
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
                <button type="submit" className="px-5 py-2 bg-amber-500 text-heading text-sm font-semibold rounded-xl">Continue to sign-in</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Google Workspace Diagnostic Modal */}
      {showGwModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white p-6 sm:p-8 rounded-3xl max-w-xl w-full shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl sm:text-2xl font-serif font-bold text-heading flex items-center space-x-2">
                  <Activity className="w-5 h-5 text-amber-700" />
                  <span>Google Workspace Diagnostic</span>
                </h2>
                <p className="text-xs sm:text-sm text-slate-500 mt-1">
                  Live connectivity and API scope verification across all 9 Google services.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGwModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {gwTesting && (
              <div className="flex flex-col items-center justify-center py-10 space-y-3">
                <RefreshCw className="w-8 h-8 animate-spin text-amber-500" />
                <p className="text-sm font-semibold text-slate-700">Checking all 9 Google Workspace services...</p>
                <p className="text-xs text-slate-400">Checking your sign-in, the permissions you gave, and that each service answers</p>
              </div>
            )}

            {!gwTesting && gwDiagnosticResult && (
              <div className="space-y-4">
                <div
                  className={`p-4 rounded-2xl border ${
                    gwDiagnosticResult.ok
                      ? 'bg-emerald-50 border-emerald-200'
                      : gwDiagnosticResult.connected
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-red-50 border-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      {gwDiagnosticResult.ok
                        ? 'All Services Operational'
                        : gwDiagnosticResult.connected
                        ? 'Partial Service Success'
                        : 'Not Connected'}
                    </span>
                    <span className="text-xs font-mono font-semibold">
                      {gwDiagnosticResult.passedCount ?? 0} / {gwDiagnosticResult.totalCount ?? 0} Passed
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">{gwDiagnosticResult.message}</p>
                  {gwDiagnosticResult.accountEmail && (
                    <p className="text-xs font-mono text-slate-500 mt-1">
                      Account: {gwDiagnosticResult.accountEmail}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  {(gwDiagnosticResult.services || []).map((svc: any) => (
                    <div
                      key={svc.id}
                      className="flex items-center justify-between p-3 rounded-xl border border-cream-200 bg-cream-50/50 text-xs"
                    >
                      <div className="flex items-center space-x-2.5">
                        {svc.ok ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                        )}
                        <div>
                          <p className="font-semibold text-heading">{svc.name}</p>
                          <p className="text-[11px] text-slate-500">{svc.message}</p>
                        </div>
                      </div>
                      {typeof svc.latencyMs === 'number' && (
                        <span className="text-[10px] font-mono text-slate-400 shrink-0">
                          {svc.latencyMs}ms
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowGwModal(false)}
                className="px-5 py-2 bg-cream-200 hover:bg-cream-300 text-slate-700 text-sm font-semibold rounded-xl"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConnectorsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500">Loading connectors...</div>}>
      <ConnectorsScreen />
    </Suspense>
  );
}
