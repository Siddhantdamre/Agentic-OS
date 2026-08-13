'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/lib/store';
import { ArrowLeft, ArrowRight, Briefcase } from 'lucide-react';
import { StatusBadge } from '@/components/a11y';
import { recommendPacksForBusinessType } from '@/app/(onboarding)/pack-recommendations';

const BUSINESS_TYPES = [
  'E-Commerce & Retail',
  'Real Estate & Property',
  'Professional Services / Consulting',
  'Healthcare & Wellness',
  'Software / SaaS',
  'Marketing & Creative Agency',
  'Financial & Insurance Services',
  'Hospitality & Travel',
  'Education & Training',
  'Other / Custom',
];

export default function OnboardingBusinessTypePage() {
  const router = useRouter();
  const { businessType, setBusinessType, setStep } = useOnboardingStore();
  const recommendation = businessType ? recommendPacksForBusinessType(businessType) : null;

  const handleNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessType) return;
    setStep(4);
    void fetch('/api/org/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wizardStep: 'channels', businessType }),
    });
    router.push('/onboarding/channels');
  };

  return (
    <form onSubmit={handleNext} className="space-y-6 text-center">
      <div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          What type of business do you run?
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          We recommend a pack and connectors. Nothing is marked connected until you finish OAuth.
        </p>
      </div>

      <div className="max-w-md mx-auto grid grid-cols-2 gap-3 text-left">
        {BUSINESS_TYPES.map((type) => {
          const isSelected = businessType === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setBusinessType(type)}
              aria-pressed={isSelected}
              className={`p-4 rounded-2xl border text-sm font-medium transition-all flex items-start space-x-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                isSelected
                  ? 'border-amber-500 bg-amber-500/10 text-heading font-semibold shadow-sm'
                  : 'border-cream-300 bg-cream-50 hover:bg-cream-100 text-slate-700'
              }`}
            >
              <Briefcase className={`w-4 h-4 mt-0.5 shrink-0 ${isSelected ? 'text-amber-600' : 'text-slate-400'}`} />
              <span>{type}</span>
            </button>
          );
        })}
      </div>

      {recommendation ? (
        <div className="max-w-md mx-auto text-left bg-cream-50 border border-cream-300 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Recommended pack</p>
            <StatusBadge label="Not installed yet" tone="pending" />
          </div>
          <p className="text-sm font-semibold text-heading">{recommendation.label}</p>
          <p className="text-xs text-slate-500">{recommendation.copy}</p>
          <ul className="space-y-1.5">
            {recommendation.connectors.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-700">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-slate-400"> — {c.reason}</span>
                </span>
                <StatusBadge label="Recommended" tone="neutral" icon="plug" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center space-x-3 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => router.push('/onboarding/team-size')}
          className="py-4 px-5 bg-cream-200 hover:bg-cream-300 text-heading font-semibold rounded-2xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <button
          type="submit"
          disabled={!businessType}
          className="flex-1 py-4 px-6 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        >
          <span>Continue</span>
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </form>
  );
}
