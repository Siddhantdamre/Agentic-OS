'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  MessageSquare,
  Mail,
  Calendar,
  Database,
  CreditCard,
  Megaphone,
  BarChart2,
  CheckCircle2,
  ArrowLeft,
  RefreshCw,
  Terminal,
  Play,
  Copy,
  Check,
  Webhook,
  Activity,
  Key,
  AlertCircle,
  Cloud,
} from 'lucide-react';
import {
  connectRazorpayByok,
  disconnectProvider,
  startRealNangoOAuth,
} from '@/lib/nango-client';
import WhatsAppConnectModal from '@/components/connectors/whatsapp-connect-modal';
import { networkErrorMessage } from '@/lib/client-error';

interface ConnectorSpec {
  name: string;
  category: string;
  desc: string;
  icon: any;
  authMode: string;
  nangoKey: string;
  envVars: Array<{ name: string; desc: string }>;
  scopes: string[];
  testFields: Array<{ key: string; label: string; placeholder: string; type?: string }>;
  codeSnippet: string;
  webhookEvents: string[];
}

interface ConnectorDisplay {
  name: string;
  desc: string;
  nangoKey: string;
  authMode: string;
  envVars: Array<{ name: string; desc: string }>;
  scopes: string[];
  testFields: Array<{ key: string; label: string; placeholder: string; type?: string }>;
  codeSnippet: string;
  webhookEvents: string[];
}

const CONNECTOR_SPECS: Record<string, ConnectorSpec> = {
  'google-workspace': {
    name: 'Google Workspace (All-in-One)',
    category: 'Productivity',
    desc: 'Unified Google Workspace connection authorizing Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, and Tasks with a single sign-in.',
    icon: Cloud,
    authMode: 'OAuth 2.0 (Google Workspace)',
    nangoKey: 'google',
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', desc: 'Google Cloud Console Client ID' },
      { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Cloud Console Client Secret' },
    ],
    scopes: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/forms.body',
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/tasks',
    ],
    testFields: [],
    codeSnippet: "import { testGoogleWorkspace } from '@darex/connectors';\n\nconst result = await testGoogleWorkspace(nangoClient, orgId);\nconsole.log(result.services);",
    webhookEvents: ['gmail.message_received', 'calendar.event_created', 'drive.file_updated'],
  },
  google: {
    name: 'Google Workspace (All-in-One)',
    category: 'Productivity',
    desc: 'Unified Google Workspace connection authorizing Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, and Tasks with a single sign-in.',
    icon: Cloud,
    authMode: 'OAuth 2.0 (Google Workspace)',
    nangoKey: 'google',
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', desc: 'Google Cloud Console Client ID' },
      { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Cloud Console Client Secret' },
    ],
    scopes: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/forms.body',
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/tasks',
    ],
    testFields: [],
    codeSnippet: "import { testGoogleWorkspace } from '@darex/connectors';\n\nconst result = await testGoogleWorkspace(nangoClient, orgId);\nconsole.log(result.services);",
    webhookEvents: ['gmail.message_received', 'calendar.event_created', 'drive.file_updated'],
  },
  whatsapp: {
    name: 'WhatsApp Business',
    category: 'Messaging',
    desc: 'Link WhatsApp by scanning a QR code, or use the official WhatsApp Business connection, to chat with customers. Your AI employees reply either way.',
    icon: MessageSquare,
    authMode: 'OAuth 2.0 (Meta Cloud API)',
    nangoKey: 'whatsapp',
    envVars: [
      { name: 'META_APP_ID', desc: 'Meta Developer App ID' },
      { name: 'META_APP_SECRET', desc: 'Meta Developer App Secret' },
      { name: 'WHATSAPP_PHONE_NUMBER_ID', desc: 'WhatsApp Business Phone Number ID' },
    ],
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    testFields: [
      { key: 'recipient', label: 'Recipient Phone Number', placeholder: '+14155552671' },
      { key: 'text', label: 'Message Text', placeholder: 'Hello from DareX AI Employee!' },
    ],
    codeSnippet: "import { NangoConnectorClient, sendWhatsAppMessage } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst result = await sendWhatsAppMessage(client, orgId, phoneNumberId, {\n  recipient: '+14155552671',\n  text: 'Hi! Your appointment has been confirmed by Sarah - Sales Rep.',\n});",
    webhookEvents: ['messages', 'message_template_status_update', 'phone_number_name_update'],
  },
  gmail: {
    name: 'Gmail / Email',
    category: 'Email',
    desc: 'Gmail RFC 2822 base64 API wrapper for inbound email triage, response drafting, and automated sending.',
    icon: Mail,
    authMode: 'OAuth 2.0 (Google APIs)',
    nangoKey: 'gmail',
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', desc: 'Google Cloud Console Client ID' },
      { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Cloud Console Client Secret' },
    ],
    scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    testFields: [
      { key: 'recipient', label: 'Recipient Email Address', placeholder: 'client@example.com' },
      { key: 'text', label: 'Email Content', placeholder: 'Here is your requested proposal from DareX AI.' },
    ],
    codeSnippet: "import { NangoConnectorClient, sendGmailEmail } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst result = await sendGmailEmail(client, orgId, {\n  recipient: 'client@example.com',\n  text: 'Hello, thank you for reaching out to our team.',\n});",
    webhookEvents: ['message_received', 'thread_replied', 'bounce_detected'],
  },
  'google-calendar': {
    name: 'Google Calendar',
    category: 'Calendar',
    desc: 'Google Calendar API wrapper for real-time availability slot checking and appointment scheduling.',
    icon: Calendar,
    authMode: 'OAuth 2.0 (Google APIs)',
    nangoKey: 'google-calendar',
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', desc: 'Google Cloud Console Client ID' },
      { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Cloud Console Client Secret' },
    ],
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
    testFields: [
      { key: 'title', label: 'Event Title', placeholder: 'DareX Strategy Call' },
      { key: 'attendeesStr', label: 'Attendee Emails (comma separated)', placeholder: 'lead@example.com, owner@darex.dev' },
    ],
    codeSnippet: "import { NangoConnectorClient, createGoogleCalendarEvent } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst result = await createGoogleCalendarEvent(client, orgId, {\n  title: 'AI Consultation Call',\n  attendeeEmails: ['lead@example.com'],\n  startTime: new Date().toISOString(),\n  endTime: new Date(Date.now() + 3600000).toISOString(),\n});",
    webhookEvents: ['event_created', 'event_updated', 'event_cancelled'],
  },
  hubspot: {
    name: 'HubSpot CRM',
    category: 'CRM',
    desc: 'HubSpot CRM API wrapper for automatic contact creation, lead sync, and deal stage updates.',
    icon: Database,
    authMode: 'OAuth 2.0 (HubSpot Apps)',
    nangoKey: 'hubspot',
    envVars: [
      { name: 'HUBSPOT_CLIENT_ID', desc: 'HubSpot Developer App Client ID' },
      { name: 'HUBSPOT_CLIENT_SECRET', desc: 'HubSpot Developer App Client Secret' },
    ],
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read'],
    testFields: [
      { key: 'email', label: 'Contact Email', placeholder: 'lead@example.com' },
      { key: 'firstName', label: 'First Name', placeholder: 'Alex' },
      { key: 'lastName', label: 'Last Name', placeholder: 'Morgan' },
    ],
    codeSnippet: "import { NangoConnectorClient, createHubspotContact } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst result = await createHubspotContact(client, orgId, {\n  email: 'lead@example.com',\n  firstName: 'Alex',\n  lastName: 'Morgan',\n});",
    webhookEvents: ['contact.creation', 'contact.propertyChange', 'deal.creation'],
  },
  razorpay: {
    name: 'Razorpay / Payments',
    category: 'Payments',
    desc: 'Razorpay API key wrapper for instant payment link creation and payment status tracking.',
    icon: CreditCard,
    authMode: 'API Key (Key_ID & Key_Secret)',
    nangoKey: 'razorpay',
    envVars: [
      { name: 'RAZORPAY_KEY_ID', desc: 'Razorpay Dashboard Key ID' },
      { name: 'RAZORPAY_KEY_SECRET', desc: 'Razorpay Dashboard Key Secret' },
    ],
    scopes: ['invoices.write', 'payments.read'],
    testFields: [
      { key: 'customerEmail', label: 'Customer Email', placeholder: 'customer@example.com' },
      { key: 'amountInPaisa', label: 'Amount (in Paisa — e.g. 499900)', placeholder: '499900', type: 'number' },
    ],
    codeSnippet: "import { NangoConnectorClient, createRazorpayInvoice } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst result = await createRazorpayInvoice(client, orgId, {\n  customerEmail: 'customer@example.com',\n  amountInPaisa: 499900,\n  description: 'Darex invoice',\n});",
    webhookEvents: ['payment.authorized', 'payment.failed', 'invoice.paid'],
  },
  'meta-ads': {
    name: 'Meta Ads',
    category: 'Advertising',
    desc: 'Meta Marketing API wrapper for ROAS monitoring, ad set performance, and campaign telemetry.',
    icon: Megaphone,
    authMode: 'OAuth 2.0 (Meta Marketing API)',
    nangoKey: 'meta-ads',
    envVars: [
      { name: 'META_APP_ID', desc: 'Meta App ID' },
      { name: 'META_APP_SECRET', desc: 'Meta App Secret' },
      { name: 'META_AD_ACCOUNT_ID', desc: 'Meta Ad Account ID' },
    ],
    scopes: ['ads_management', 'ads_read'],
    testFields: [
      { key: 'adAccountId', label: 'Meta Ad Account ID', placeholder: 'act_123456789' },
    ],
    codeSnippet: "import { NangoConnectorClient, getMetaAdsInsights } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst insights = await getMetaAdsInsights(client, orgId, 'act_123456789');",
    webhookEvents: ['leadgen', 'campaign_updated', 'ad_review_approved'],
  },
  'google-ads': {
    name: 'Google Ads',
    category: 'Advertising',
    desc: 'Google Ads API wrapper for search campaign metrics, conversion tracking, and keyword analytics.',
    icon: BarChart2,
    authMode: 'OAuth 2.0 (Google Ads API)',
    nangoKey: 'google-ads',
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', desc: 'Google Client ID' },
      { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Client Secret' },
      { name: 'GOOGLE_ADS_DEVELOPER_TOKEN', desc: 'Google Ads Developer Access Token' },
    ],
    scopes: ['https://www.googleapis.com/auth/adwords'],
    testFields: [
      { key: 'customerId', label: 'Google Ads Customer ID', placeholder: '123-456-7890' },
    ],
    codeSnippet: "import { NangoConnectorClient, getGoogleAdsPerformance } from '@darex/connectors';\n\nconst client = new NangoConnectorClient();\nconst perf = await getGoogleAdsPerformance(client, orgId, '123-456-7890');",
    webhookEvents: ['conversion_recorded', 'campaign_budget_exceeded'],
  },
};

export default function ConnectorDetailPage() {
  const params = useParams();
  const connectorId = (params?.id as string) || 'whatsapp';

  const spec = CONNECTOR_SPECS[connectorId];
  const Icon = spec?.icon || Key;

  const [liveAuthMode, setLiveAuthMode] = useState<string>(spec?.authMode || 'oauth');
  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [operatorHint, setOperatorHint] = useState<string | null>(null);
  const [liveName, setLiveName] = useState(spec?.name || connectorId);
  const [liveDesc, setLiveDesc] = useState(spec?.desc || '');
  const [extraConnectFields, setExtraConnectFields] = useState<Array<{ key: string; label: string; placeholder: string; required: boolean; secret?: boolean; type?: string }>>([]);
  const [testFieldsFromApi, setTestFieldsFromApi] = useState<Array<{ key: string; label: string; placeholder: string; type?: string }>>([]);
  const [connectExtras, setConnectExtras] = useState<Record<string, string>>({});
  const [showWaModal, setShowWaModal] = useState(false);
  const [waStartAt, setWaStartAt] = useState<'choose' | 'auto-reply'>('choose');
  const [rzpKeyId, setRzpKeyId] = useState('');
  const [rzpKeySecret, setRzpKeySecret] = useState('');

  const [activeTab, setActiveTab] = useState<'specs' | 'test' | 'webhooks' | 'logs'>('test');
  const [connected, setConnected] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Test Runner State
  const [payload, setPayload] = useState<Record<string, any>>({});
  const [executing, setExecuting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Database Logs State
  const [logs, setLogs] = useState<any[]>([]);

  const checkConnectionStatus = useCallback(async () => {
    setLoadingStatus(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/integrations');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || data.message || `Failed to load connector status (HTTP ${res.status})`);
        return;
      }
      const current = data.integrations?.find((i: any) => i.id === connectorId);
      if (current) {
        setConnected(current.connected);
        setLiveAuthMode(current.authMode || 'oauth');
        setOauthConfigured(current.oauthConfigured ?? null);
        setOperatorHint(current.missingConfigReason || current.operatorHint || null);
        setLiveName(current.name || connectorId);
        setLiveDesc(current.desc || '');
        setExtraConnectFields(current.extraConnectFields || []);
        if (Array.isArray(current.extraTestFields)) {
          setTestFieldsFromApi(current.extraTestFields);
        }
      } else if (!CONNECTOR_SPECS[connectorId]) {
        setLoadError(`Unknown connector "${connectorId}". Go to Connectors to see what you can connect.`);
      }
      if (data.logs) {
        setLogs(data.logs.filter((l: any) => l.channel_type === connectorId));
      }
    } catch (err) {
      console.error('Failed to load connector status:', err);
      setLoadError(networkErrorMessage(err, 'Failed to load connector status'));
    } finally {
      setLoadingStatus(false);
    }
  }, [connectorId]);

  useEffect(() => {
    checkConnectionStatus();
  }, [checkConnectionStatus]);

  const handleToggleConnect = async () => {
    setConnecting(true);
    setConnectError(null);
    setConnectSuccess(null);

    try {
      if (connected) {
        const result = await disconnectProvider(connectorId);
        if (!result.success) throw new Error(result.error || 'Disconnect failed');
        setConnected(false);
        setConnectSuccess('Disconnected. Access to this tool has been removed.');
        await checkConnectionStatus();
        return;
      }

      if (liveAuthMode === 'service_account') {
        throw new Error(operatorHint || 'This app can’t be connected from the dashboard.');
      }

      if (liveAuthMode === 'byok' || connectorId === 'whatsapp') {
        // QR or official API: the modal offers both and reports back via onConnected.
        setWaStartAt('choose');
        setShowWaModal(true);
        return;
      }

      if (liveAuthMode === 'api_key' || connectorId === 'razorpay') {
        const result = await connectRazorpayByok({ keyId: rzpKeyId, keySecret: rzpKeySecret });
        if (!result.success) throw new Error(result.error || 'Razorpay connect failed');
        setConnected(true);
        setConnectSuccess('Razorpay keys verified for this org.');
        await checkConnectionStatus();
        return;
      }

      if (oauthConfigured === false) {
        // The OAuth app is not registered in Nango: the popup can only fail.
        throw new Error(
          operatorHint || `Connecting ${liveName} isn’t switched on yet. Ask your administrator to set it up.`
        );
      }

      const extras: Record<string, string> = { ...connectExtras };
      const result = await startRealNangoOAuth(connectorId, { extraParams: extras });
      if (!result.success) {
        throw new Error(result.error || 'The sign-in was cancelled or didn’t work.');
      }
      setConnected(true);
      setConnectSuccess(`${liveName} is connected.`);
      await checkConnectionStatus();
    } catch (err: any) {
      setConnected(false);
      setConnectError(err.message || 'Connection failed. Please try again.');
      await checkConnectionStatus();
    } finally {
      setConnecting(false);
    }
  };

  const handleRunAction = async () => {
    setExecuting(true);
    setTestResult(null);

    const requestPayload = { ...payload };
    if (requestPayload.attendeesStr) {
      requestPayload.attendeeEmails = requestPayload.attendeesStr.split(',').map((s: string) => s.trim());
    }

    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: connectorId, payload: requestPayload }),
      });
      const data = await res.json();
      setTestResult(data);
      checkConnectionStatus();
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setExecuting(false);
    }
  };

  const testFields: ConnectorDisplay['testFields'] = spec?.testFields?.length ? spec.testFields : testFieldsFromApi;
  const display: ConnectorDisplay = {
    name: liveName || spec?.name || connectorId,
    desc: liveDesc || spec?.desc || '',
    nangoKey: spec?.nangoKey || connectorId,
    authMode: liveAuthMode || spec?.authMode || 'oauth',
    envVars: spec?.envVars || [],
    scopes: spec?.scopes || [],
    testFields,
    codeSnippet:
      spec?.codeSnippet ||
      `await fetch('/api/integrations/test', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ provider: '${connectorId}', payload: {} }),\n});`,
    webhookEvents: spec?.webhookEvents || [],
  };

  const copyCode = () => {
    navigator.clipboard.writeText(display.codeSnippet);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      {/* Toast */}
      {(connectError || connectSuccess) && (
        <div className={`fixed top-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-xl text-sm font-semibold ${
          connectError ? 'bg-red-950 border border-red-700 text-red-300' : 'bg-emerald-950 border border-emerald-600 text-emerald-200'
        }`}>
          {connectError || connectSuccess}
        </div>
      )}
      {loadError && (
        <div className="p-4 rounded-2xl border border-red-300 bg-red-50 text-red-950 text-sm font-medium flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}
      {/* Top Back Link */}
      <div>
        <Link
          href="/connectors"
          className="inline-flex items-center space-x-2 text-xs font-bold text-slate-500 hover:text-amber-800 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Connectors Directory</span>
        </Link>
      </div>

      {/* Header Card */}
      <div className="bg-white border border-cream-300 rounded-3xl p-8 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center space-x-5">
          <div className="p-4 bg-amber-500/20 text-amber-700 rounded-3xl shrink-0">
            <Icon className="w-8 h-8" />
          </div>
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-2xl font-serif font-bold text-heading">{display.name}</h1>
              <span
                className={`px-3 py-1 text-xs font-bold rounded-full flex items-center gap-1 ${
                  connected
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {connected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />}
                <span>{connected ? 'Connected' : 'Disconnected'}</span>
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-xl leading-relaxed">{display.desc}</p>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center space-x-3 w-full md:w-auto">
          <button
            onClick={checkConnectionStatus}
            className="p-2.5 bg-cream-200 hover:bg-cream-300 rounded-xl text-slate-600 transition"
            title="Refresh status"
          >
            <RefreshCw className={`w-4 h-4 ${loadingStatus ? 'animate-spin' : ''}`} />
          </button>

          {connected && connectorId === 'whatsapp' && (
            <button
              type="button"
              onClick={() => {
                setWaStartAt('auto-reply');
                setShowWaModal(true);
              }}
              className="px-5 py-2.5 text-xs font-bold rounded-xl bg-white border border-cream-300 hover:bg-slate-50 text-slate-700 mr-2"
            >
              Auto-reply settings
            </button>
          )}
          <button
            onClick={handleToggleConnect}
            disabled={connecting || (!connected && liveAuthMode === 'service_account')}
            className={`px-5 py-2.5 text-xs font-bold rounded-xl transition shadow-md disabled:opacity-50 ${
              connected
                ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                : 'bg-amber-500 hover:bg-amber-600 text-heading'
            }`}
          >
            {connecting
              ? 'Updating...'
              : connected
                ? 'Disconnect'
                : liveAuthMode === 'byok'
                  ? 'Connect WhatsApp'
                  : liveAuthMode === 'api_key'
                    ? 'Save API Keys'
                    : liveAuthMode === 'service_account'
                      ? 'Can’t connect here'
                      : 'Connect'}
          </button>
        </div>
      </div>

      {operatorHint && !connected && (
        <div className="p-4 rounded-2xl border border-amber-300 bg-amber-50 text-amber-950 text-xs font-medium flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{operatorHint}</span>
        </div>
      )}

      {!connected && liveAuthMode === 'byok' && (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 text-xs text-slate-600">
          Connect WhatsApp by scanning a QR code or with the official WhatsApp Business connection. You pick when you click Connect.
        </div>
      )}

      {!connected && liveAuthMode === 'api_key' && (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-3">
          <h3 className="text-sm font-bold text-heading">Razorpay API keys (verified before connect)</h3>
          <input type="text" placeholder="rzp_live_..." value={rzpKeyId} onChange={(e) => setRzpKeyId(e.target.value)} className="w-full text-xs p-3 rounded-xl border border-cream-300" />
          <input type="password" placeholder="Key secret" value={rzpKeySecret} onChange={(e) => setRzpKeySecret(e.target.value)} className="w-full text-xs p-3 rounded-xl border border-cream-300" />
        </div>
      )}

      {!connected && liveAuthMode === 'oauth' && extraConnectFields.length > 0 && (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-3">
          <h3 className="text-sm font-bold text-heading">Needed before you sign in</h3>
          {extraConnectFields.map((field) => (
            <input
              key={field.key}
              type={field.type === 'password' ? 'password' : 'text'}
              placeholder={field.placeholder}
              value={connectExtras[field.key] || ''}
              onChange={(e) => setConnectExtras({ ...connectExtras, [field.key]: e.target.value })}
              className="w-full text-xs p-3 rounded-xl border border-cream-300"
            />
          ))}
        </div>
      )}

      <WhatsAppConnectModal
        open={showWaModal}
        startAt={waStartAt}
        onClose={() => setShowWaModal(false)}
        onConnected={async (message) => {
          setShowWaModal(false);
          setConnected(true);
          setConnectSuccess(message);
          await checkConnectionStatus();
        }}
      />

      {/* Tab Navigation */}
      <div className="flex items-center space-x-2 border-b border-cream-300 pb-2">
        {[
          { id: 'test', label: 'Try an action', icon: Terminal },
          { id: 'specs', label: 'Access & permissions', icon: Key },
          { id: 'webhooks', label: 'Incoming updates', icon: Webhook },
          { id: 'logs', label: `Activity log (${logs.length})`, icon: Activity },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition ${
              activeTab === tab.id
                ? 'bg-amber-500 text-heading shadow-sm'
                : 'hover:bg-cream-200 text-slate-600'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* TAB 1: INTERACTIVE API RUNNER */}
      {activeTab === 'test' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Form: Test Parameters */}
          <div className="lg:col-span-7 bg-white border border-cream-300 rounded-3xl p-6 space-y-5 shadow-sm">
            <div className="flex items-center justify-between border-b border-cream-200 pb-3">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-amber-700" />
                <h3 className="font-bold text-heading text-sm">Try an action on {display.name}</h3>
              </div>
              <span className="text-[10px] font-mono bg-cream-200 text-amber-800 font-bold px-2 py-0.5 rounded">
                Runs for real
              </span>
            </div>

            <div className="space-y-4">
              {display.testFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{field.label}</label>
                  <input
                    type={field.type || 'text'}
                    placeholder={field.placeholder}
                    value={payload[field.key] || ''}
                    onChange={(e) => setPayload({ ...payload, [field.key]: e.target.value })}
                    className="w-full text-xs p-3 rounded-xl border border-cream-300 bg-cream-50/50 focus:outline-none focus:border-amber-500 text-heading font-medium"
                  />
                </div>
              ))}

              <button
                onClick={handleRunAction}
                disabled={executing}
                className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl transition shadow-md flex items-center justify-center space-x-2 disabled:opacity-50"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{executing ? 'Running…' : `Run ${display.name} action`}</span>
              </button>
            </div>

            {/* Test Result Response Box */}
            {testResult && (
              <div className="mt-4 p-4 bg-slate-950 text-slate-200 font-mono text-xs rounded-2xl space-y-2 border border-slate-800">
                <div className="flex items-center justify-between text-slate-400 border-b border-slate-800 pb-1.5 text-[11px]">
                  <span>Result</span>
                  <span className={testResult.success ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                    {testResult.success ? 'Done — saved to your activity log' : 'Response'}
                  </span>
                </div>
                <pre className="text-[11px] whitespace-pre-wrap max-h-60 overflow-y-auto">{JSON.stringify(testResult, null, 2)}</pre>
              </div>
            )}
          </div>

          {/* Right Panel: TypeScript Code Snippet */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-slate-950 text-slate-200 rounded-3xl p-6 border border-slate-800 space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="text-xs font-semibold text-slate-400 font-mono">Example for developers</span>
                <button
                  onClick={copyCode}
                  className="text-xs text-slate-400 hover:text-amber-400 flex items-center space-x-1 transition"
                >
                  {copiedSnippet ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSnippet ? 'Copied' : 'Copy example'}</span>
                </button>
              </div>

              <pre className="text-xs font-mono text-emerald-300 leading-relaxed overflow-x-auto whitespace-pre-wrap">
                {display.codeSnippet}
              </pre>
            </div>

            <div className="p-4 bg-cream-100 border border-cream-300 rounded-2xl text-xs text-slate-600 space-y-1">
              <span className="font-bold text-heading block">Safe to retry</span>
              <p className="text-[11px] leading-relaxed">
                When an AI employee uses this connection during a customer conversation, the call is retried safely if something goes wrong, and only ever touches your own business’s data.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: CREDENTIALS & SCOPES */}
      {activeTab === 'specs' && (
        <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-6 shadow-sm">
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-heading">Your connection</h3>
            <p className="text-xs text-slate-500">
              Your sign-in details for this tool are stored securely and kept separate from every other business.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="p-5 bg-cream-50 border border-cream-300 rounded-2xl space-y-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Connection name</span>
              <code className="text-sm font-bold font-mono text-amber-800 bg-cream-200 px-2 py-1 rounded">{display.nangoKey}</code>
            </div>

            <div className="p-5 bg-cream-50 border border-cream-300 rounded-2xl space-y-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Auth Scheme</span>
              <span className="text-sm font-bold text-heading">{display.authMode}</span>
            </div>
          </div>

          {/* Required Env Vars */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Settings your administrator needs to provide</h4>
            <div className="border border-cream-300 rounded-2xl overflow-hidden divide-y divide-cream-200">
              {display.envVars.map((env, idx) => (
                <div key={idx} className="p-4 flex items-center justify-between bg-white text-xs">
                  <code className="font-mono font-bold text-amber-800">{env.name}</code>
                  <span className="text-slate-500">{env.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Scopes List */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Permissions requested</h4>
            <div className="flex flex-wrap gap-2">
              {display.scopes.map((scope, idx) => (
                <span key={idx} className="px-3 py-1.5 bg-cream-200 text-slate-800 font-mono text-xs rounded-xl border border-cream-300">
                  {scope}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: WEBHOOK LISTENERS */}
      {activeTab === 'webhooks' && (
        <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-6 shadow-sm">
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-heading">How updates reach you</h3>
            <p className="text-xs text-slate-500">
              When {display.name} sends news — like a new message — it is received automatically and appears in your activity log. There is nothing to set up here.
            </p>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Updates we listen for</h4>
            <div className="grid grid-cols-3 gap-3">
              {display.webhookEvents.map((evt, idx) => (
                <div key={idx} className="p-3 bg-cream-100 border border-cream-300 rounded-xl text-xs font-mono text-slate-700 flex items-center space-x-2">
                  <Webhook className="w-3.5 h-3.5 text-amber-700" />
                  <span>{evt}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: DATABASE EVENT LOGS */}
      {activeTab === 'logs' && (
        <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-heading">Live Database Event & Audit Logs</h3>
            <span className="text-xs text-slate-400 font-mono font-medium">{logs.length} entries for {display.name}</span>
          </div>

          <div className="bg-slate-950 text-slate-300 font-mono text-xs p-5 rounded-2xl space-y-2 max-h-96 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="text-slate-500 italic text-center py-6">
                No logs recorded yet for {display.name}. Execute an API action in the Interactive Runner tab to generate logs!
              </div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className="border-b border-slate-900 pb-2 text-[11px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className={log.status === 'success' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                      [{log.status_code || 200}] {log.event_type.toUpperCase()}
                    </span>
                    <span className="text-slate-500 text-[10px]">{new Date(log.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-slate-300">{log.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
