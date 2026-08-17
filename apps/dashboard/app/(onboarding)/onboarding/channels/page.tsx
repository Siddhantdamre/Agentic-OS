'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/lib/store';
import { ArrowLeft, Check, MessageSquare, Mail, Calendar, Database, CreditCard, Sparkles, Megaphone } from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { recommendPacksForBusinessType } from '@/app/(onboarding)/pack-recommendations';

const CHANNELS = [
  { id: 'whatsapp', name: 'WhatsApp Business', icon: MessageSquare, desc: 'Meta Cloud API' },
  { id: 'email', name: 'Gmail / Email', icon: Mail, desc: 'Inbound & Outbound' },
  { id: 'google_calendar', name: 'Google Calendar', icon: Calendar, desc: 'Slot Booking' },
  { id: 'hubspot', name: 'HubSpot CRM', icon: Database, desc: 'Lead Sync' },
  { id: 'razorpay', name: 'Razorpay / Payments', icon: CreditCard, desc: 'Invoices & Refunds' },
  { id: 'meta_ads', name: 'Meta Ads', icon: Megaphone, desc: 'Campaign Monitoring' },
];

const CHANNEL_TO_CONNECTOR: Record<string, string> = {
  whatsapp: 'whatsapp',
  email: 'gmail',
  google_calendar: 'google-calendar',
  hubspot: 'hubspot',
  razorpay: 'razorpay',
  meta_ads: 'meta-ads',
};

export default function OnboardingChannelsPage() {
  const router = useRouter();
  const { businessName, teamSize, businessType, selectedChannels, toggleChannel } = useOnboardingStore();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [liveMessage, setLiveMessage] = useState('');
  const recommendation = recommendPacksForBusinessType(businessType);
  const recommendedIds = new Set(recommendation.connectors.map((c) => c.id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedChannels.length === 0) return;

    setSubmitting(true);
    setError('');
    setLiveMessage('Saving organization and requesting pack install');

    try {
      const res = await fetch('/api/org/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          teamSize,
          businessType,
          channels: selectedChannels,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to create organization');
      }

      const payload = await res.json();
      if (payload.connectorsMarkedConnected) {
        throw new Error('Onboarding must not mark connectors connected');
      }

      router.push('/?warmup=true');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred during onboarding';
      setError(message);
      setLiveMessage(message);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 text-center">
      <LiveRegion message={liveMessage} politeness="assertive" />
      <div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          Select channels & integrations used
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Selecting a channel seeds a pending row. It does not mark the connector connected.
        </p>
      </div>

      {recommendation.connectors.length > 0 ? (
        <div className="max-w-md mx-auto text-left bg-cream-50 border border-cream-300 rounded-2xl p-3 space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            {recommendation.label}
          </p>
          <p className="text-xs text-slate-500">{recommendation.copy}</p>
        </div>
      ) : null}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      <div className="max-w-md mx-auto grid grid-cols-2 gap-3 text-left">
        {CHANNELS.map((ch) => {
          const isSelected = selectedChannels.includes(ch.id);
          const connectorId = CHANNEL_TO_CONNECTOR[ch.id] || ch.id;
          const isRecommended = recommendedIds.has(connectorId);
          const Icon = ch.icon;
          return (
            <button
              key={ch.id}
              type="button"
              onClick={() => toggleChannel(ch.id)}
              aria-pressed={isSelected}
              className={`p-4 rounded-2xl border text-sm transition-all flex flex-col space-y-1 relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                isSelected
                  ? 'border-amber-500 bg-amber-500/10 text-heading font-semibold shadow-sm'
                  : 'border-cream-300 bg-cream-50 hover:bg-cream-100 text-slate-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-5 h-5 ${isSelected ? 'text-amber-600' : 'text-slate-400'}`} />
                {isSelected && (
                  <span className="w-5 h-5 rounded-full bg-amber-500 text-heading flex items-center justify-center">
                    <Check className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
              <span className="font-medium text-heading pt-1">{ch.name}</span>
              <span className="text-xs text-slate-400">{ch.desc}</span>
              {isRecommended ? (
                <StatusBadge label="Recommended · not connected" tone="neutral" icon="plug" className="mt-1" />
              ) : (
                <StatusBadge label="Not connected" tone="pending" icon="plug" className="mt-1" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center space-x-3 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => router.push('/onboarding/business-type')}
          disabled={submitting}
          className="py-4 px-5 bg-cream-200 hover:bg-cream-300 text-heading font-semibold rounded-2xl transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <button
          type="submit"
          disabled={selectedChannels.length === 0 || submitting}
          className="flex-1 py-4 px-6 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        >
          {submitting ? (
            <span>Provisioning…</span>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              <span>Complete Setup & Bring Online</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
