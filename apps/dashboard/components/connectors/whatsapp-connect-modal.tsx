'use client';

import React, { useEffect, useRef, useState } from 'react';
import { QrCode, ShieldCheck, RefreshCw, ArrowLeft } from 'lucide-react';
import { connectWhatsAppByok, connectWhatsAppEmbedded, getWhatsAppQrStatus, startWhatsAppQr } from '@/lib/nango-client';
import { embeddedSignupAvailable, startEmbeddedSignup } from '@/lib/meta-embedded-signup';
import WhatsAppAutoReplyForm from '@/components/connectors/whatsapp-auto-reply-form';
import { networkErrorMessage } from '@/lib/client-error';

type Mode = 'choose' | 'qr' | 'api' | 'auto-reply';
type QrPhase = 'idle' | 'starting' | 'waiting' | 'error';

const inputCls = 'w-full px-4 py-2 border rounded-xl text-sm';

/**
 * WhatsApp connect: one card, two ways in.
 *  - Scan QR (WhatsApp Web via Evolution API): fastest, no Meta account.
 *  - Official API (Meta Cloud): paste a Meta token, production-grade.
 * Which one is saved decides the provider used for every send and receive.
 * After connecting, a last step picks how replies work (agent, simple AI,
 * fixed message, off). `startAt="auto-reply"` opens that step directly.
 */
export default function WhatsAppConnectModal(props: {
  open: boolean;
  onClose: () => void;
  onConnected: (message: string) => void;
  startAt?: 'choose' | 'auto-reply';
  /** Link an extra number instead of replacing the primary. */
  add?: boolean;
  /** With startAt 'auto-reply': which linked number's settings to edit (empty = primary). */
  channelId?: string | null;
}) {
  const { open, onClose, onConnected, startAt = 'choose', add = false, channelId: openChannelId = null } = props;
  // The number being set up: the one just linked, or the one the card asked for.
  const [channelId, setChannelId] = useState<string | null>(openChannelId);
  const [mode, setMode] = useState<Mode>(startAt);
  const [doneMessage, setDoneMessage] = useState('WhatsApp is connected.');

  const [qrPhase, setQrPhase] = useState<QrPhase>('idle');
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const [token, setToken] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    if (open) {
      setChannelId(openChannelId);
      setMode(startAt);
      setDoneMessage(startAt === 'auto-reply' ? 'Auto-reply settings saved.' : 'WhatsApp is connected.');
    } else {
      setMode('choose');
      setQrPhase('idle');
      setQr(null);
      setPairingCode(null);
      setQrError(null);
      setApiError(null);
      setToken('');
      setPhoneId('');
      setWabaId('');
    }
  }, [open, startAt, openChannelId]);

  async function beginQr() {
    setMode('qr');
    setQrPhase('starting');
    setQrError(null);
    const r = await startWhatsAppQr({ add, channelId });
    if (!r.success) {
      setQrPhase('error');
      setQrError(r.message || 'Could not start QR linking');
      return;
    }
    if (r.channelId) setChannelId(r.channelId);
    setQr(r.qrBase64 ?? null);
    setPairingCode(r.pairingCode ?? null);
    setQrPhase('waiting');
  }

  // Poll while the QR is on screen. Refresh the image every ~21s (QRs expire).
  useEffect(() => {
    if (!open || mode !== 'qr' || qrPhase !== 'waiting') return;
    let tick = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      tick += 1;
      const s = await getWhatsAppQrStatus(tick % 7 === 0, channelId);
      if (stopped) return;
      if (s.connected) {
        clearInterval(timer);
        setDoneMessage('WhatsApp linked by QR.');
        setMode('auto-reply');
        return;
      }
      if (!s.success) {
        setQrError(s.message || 'Status check failed');
        return;
      }
      setQrError(null);
      if (s.qrBase64) setQr(s.qrBase64);
      if (s.pairingCode) setPairingCode(s.pairingCode);
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, mode, qrPhase, channelId]);

  async function signInWithFacebook() {
    setBusy(true);
    setApiError(null);
    try {
      const signup = await startEmbeddedSignup();
      const r = await connectWhatsAppEmbedded({ ...signup, add });
      if (!r.success) throw new Error(r.error || 'Facebook signup failed');
      if (r.channelId) setChannelId(r.channelId);
      setDoneMessage('WhatsApp connected through Facebook.');
      setMode('auto-reply');
    } catch (e) {
      setApiError(networkErrorMessage(e, 'Facebook signup failed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitApi(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setApiError(null);
    const r = await connectWhatsAppByok({ accessToken: token, phoneNumberId: phoneId, wabaId, add });
    setBusy(false);
    if (r.success) {
      if (r.channelId) setChannelId(r.channelId);
      setDoneMessage('WhatsApp connected (token verified against Meta Graph).');
      setMode('auto-reply');
    } else {
      setApiError(r.error || 'Failed to connect WhatsApp');
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect WhatsApp"
        className="bg-white p-8 rounded-3xl max-w-lg w-full shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto"
      >
        {mode !== 'choose' && mode !== 'auto-reply' && (
          <button
            type="button"
            onClick={() => setMode('choose')}
            className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="w-3 h-3" /> Back
          </button>
        )}
        <h2 className="text-2xl font-serif font-bold text-heading">
          {mode === 'auto-reply' ? 'How should WhatsApp replies work?' : add ? 'Add another WhatsApp number' : 'Connect WhatsApp'}
        </h2>

        {mode === 'auto-reply' && (
          <WhatsAppAutoReplyForm
            onSaved={() => onConnected(doneMessage)}
            onSkip={() => onConnected(doneMessage)}
            skipLabel={startAt === 'auto-reply' ? 'Cancel' : 'Skip for now'}
            channelId={channelId}
          />
        )}

        {mode === 'choose' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">Pick how to link your number. Your AI employees auto-reply either way.</p>
            <button
              type="button"
              onClick={beginQr}
              className="w-full text-left p-4 border rounded-2xl hover:border-emerald-500 hover:bg-emerald-50/40 flex gap-3"
            >
              <QrCode className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
              <span>
                <span className="block text-sm font-bold text-heading">Scan a QR code</span>
                <span className="block text-xs text-slate-500">
                  Link your own WhatsApp in a minute. No Meta account needed. Uses WhatsApp Web, which is unofficial:
                  WhatsApp can restrict numbers that send bulk or unsolicited messages. Best for trying it out or small teams.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('api')}
              className="w-full text-left p-4 border rounded-2xl hover:border-emerald-500 hover:bg-emerald-50/40 flex gap-3"
            >
              <ShieldCheck className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
              <span>
                <span className="block text-sm font-bold text-heading">Official WhatsApp Business API</span>
                <span className="block text-xs text-slate-500">
                  Connect through the official WhatsApp Business connection with your own access token. Recommended for real use: message templates, delivery receipts, and no risk of your number being banned.
                </span>
              </span>
            </button>
            <p className="text-[11px] text-slate-400">
              QR linking is powered by Evolution API (Apache-2.0).
            </p>
            <div className="flex justify-end pt-2">
              <button type="button" onClick={onClose} className="px-5 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === 'qr' && (
          <div className="space-y-4">
            {qrPhase === 'starting' && (
              <p className="text-sm text-slate-500 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" /> Preparing your QR code...
              </p>
            )}
            {qrPhase === 'error' && (
              <div className="space-y-3">
                <p className="text-sm text-red-600">{qrError}</p>
                <button type="button" onClick={beginQr} className="px-4 py-2 text-sm font-semibold bg-emerald-700 text-white rounded-xl">
                  Try again
                </button>
              </div>
            )}
            {qrPhase === 'waiting' && (
              <>
                <ol className="text-sm text-slate-600 list-decimal pl-5 space-y-1">
                  <li>Open WhatsApp on your phone.</li>
                  <li>Go to Settings, then Linked devices, then Link a device.</li>
                  <li>Scan this code.</li>
                </ol>
                <div className="flex justify-center">
                  {qr ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qr} alt="WhatsApp QR code" className="w-56 h-56 border rounded-xl" />
                  ) : (
                    <div className="w-56 h-56 border rounded-xl flex items-center justify-center text-xs text-slate-400">
                      Waiting for QR...
                    </div>
                  )}
                </div>
                {pairingCode && (
                  <p className="text-xs text-slate-500 text-center">
                    Or link with a phone number and enter code <span className="font-mono font-bold">{pairingCode}</span>
                  </p>
                )}
                {qrError && <p className="text-xs text-amber-700 text-center">{qrError}</p>}
                <p className="text-xs text-slate-400 text-center flex items-center justify-center gap-2">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Waiting for the scan. The code refreshes on its own.
                </p>
              </>
            )}
            <p className="text-[11px] text-slate-400">QR linking is powered by Evolution API (Apache-2.0).</p>
          </div>
        )}

        {mode === 'api' && (
          <form onSubmit={submitApi} className="space-y-4">
            {embeddedSignupAvailable && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={signInWithFacebook}
                  disabled={busy}
                  className="w-full px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl"
                >
                  Continue with Facebook (recommended)
                </button>
                <p className="text-xs text-slate-400 text-center">or paste a token yourself</p>
              </div>
            )}
            <p className="text-sm text-slate-500">
              Provide your Meta Developer credentials to connect your WhatsApp Business Account without waiting for Meta’s app review.
            </p>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-700">Access Token (System User Token)</label>
              <input required type="password" value={token} onChange={(e) => setToken(e.target.value)} className={inputCls} placeholder="EAAG..." />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-700">Phone Number ID</label>
              <input required type="text" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} className={inputCls} placeholder="e.g. 1045..." />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-700">WhatsApp Business Account ID (Optional)</label>
              <input type="text" value={wabaId} onChange={(e) => setWabaId(e.target.value)} className={inputCls} placeholder="e.g. 109..." />
            </div>
            {apiError && <p className="text-sm text-red-600">{apiError}</p>}
            <div className="flex justify-end space-x-3 pt-2">
              <button type="button" onClick={onClose} className="px-5 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold rounded-xl flex items-center space-x-2">
                {busy && <RefreshCw className="w-4 h-4 animate-spin" />}
                <span>Secure Connect</span>
              </button>
            </div>
          </form>
        )}

        {mode === 'qr' && (
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="px-5 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
