'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/lib/store';
import { ArrowRight } from 'lucide-react';

export default function OnboardingNamePage() {
  const router = useRouter();
  const { businessName, setBusinessName, setStep } = useOnboardingStore();

  const handleNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return;
    setStep(2);
    void fetch('/api/org/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wizardStep: 'team-size', businessName }),
    });
    router.push('/onboarding/team-size');
  };

  return (
    <form onSubmit={handleNext} className="space-y-6 text-center">
      <div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          What is your business name?
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Your AI employees will introduce themselves on behalf of this brand.
        </p>
      </div>

      <div className="max-w-md mx-auto">
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="e.g., Acme Consulting, Apex Realty..."
          required
          autoFocus
          className="w-full px-5 py-4 text-lg border-2 border-cream-300 rounded-2xl focus:border-amber-500 focus:outline-none bg-cream-50 text-heading text-center font-medium placeholder:text-slate-400 transition-colors shadow-inner"
        />
      </div>

      <button
        type="submit"
        disabled={!businessName.trim()}
        className="w-full max-w-md mx-auto py-4 px-6 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg disabled:cursor-not-allowed"
      >
        <span>Continue</span>
        <ArrowRight className="w-5 h-5" />
      </button>
    </form>
  );
}
