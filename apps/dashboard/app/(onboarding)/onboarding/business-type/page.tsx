'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/lib/store';
import { ArrowLeft, ArrowRight, Briefcase } from 'lucide-react';

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

  const handleNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessType) return;
    setStep(4);
    router.push('/onboarding/channels');
  };

  return (
    <form onSubmit={handleNext} className="space-y-6 text-center">
      <div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          What type of business do you run?
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Each AI employee is pre-configured with industry-specific workflows.
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
              className={`p-4 rounded-2xl border text-sm font-medium transition-all flex items-start space-x-2 ${
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

      <div className="flex items-center space-x-3 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => router.push('/onboarding/team-size')}
          className="py-4 px-5 bg-cream-200 hover:bg-cream-300 text-heading font-semibold rounded-2xl transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <button
          type="submit"
          disabled={!businessType}
          className="flex-1 py-4 px-6 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg disabled:cursor-not-allowed"
        >
          <span>Continue</span>
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </form>
  );
}
