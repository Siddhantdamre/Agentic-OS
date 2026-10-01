'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/lib/store';
import { ArrowLeft, ArrowRight, Users } from 'lucide-react';

export default function OnboardingTeamSizePage() {
  const router = useRouter();
  const { teamSize, setTeamSize, setStep } = useOnboardingStore();

  const handleNext = (e: React.FormEvent) => {
    e.preventDefault();
    setStep(3);
    void fetch('/api/org/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wizardStep: 'business-type', teamSize }),
    });
    router.push('/onboarding/business-type');
  };

  return (
    <form onSubmit={handleNext} className="space-y-6 text-center">
      <div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          How large is your team?
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          This helps calibrate the initial workload for your AI employee roster.
        </p>
      </div>

      <div className="max-w-md mx-auto bg-cream-100 p-6 rounded-2xl border border-cream-300 space-y-4">
        <div className="flex items-center justify-center space-x-2 text-3xl font-bold text-heading">
          <Users className="w-8 h-8 text-amber-600" />
          <span>{teamSize} {teamSize === 1 ? 'person' : 'people'}</span>
        </div>

        <input
          type="range"
          min="1"
          max="100"
          value={teamSize}
          onChange={(e) => setTeamSize(parseInt(e.target.value))}
          className="w-full h-3 bg-cream-300 rounded-lg appearance-none cursor-pointer accent-amber-500"
        />

        <div className="flex justify-between text-xs text-slate-400 px-1 font-medium">
          <span>Solo (1)</span>
          <span>Small (5-15)</span>
          <span>Growing (20+)</span>
          <span>Enterprise (100+)</span>
        </div>
      </div>

      <div className="flex items-center space-x-3 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => router.push('/onboarding/name')}
          className="py-4 px-5 bg-cream-200 hover:bg-cream-300 text-heading font-semibold rounded-2xl transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <button
          type="submit"
          className="flex-1 py-4 px-6 bg-amber-500 hover:bg-amber-600 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg"
        >
          <span>Continue</span>
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </form>
  );
}
