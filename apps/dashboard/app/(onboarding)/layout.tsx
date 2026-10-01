'use client';

import React, { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { GrowthTree } from '@/components/onboarding/GrowthTree';
import { useOnboardingStore } from '@/lib/store';

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const hydrateFromServer = useOnboardingStore((s) => s.hydrateFromServer);

  useEffect(() => {
    fetch('/api/org/onboarding')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || data.onboardingComplete) return;
        hydrateFromServer({
          businessName: data.businessName,
          teamSize: data.teamSize,
          businessType: data.businessType,
          selectedChannels: data.selectedChannels,
        });
      })
      .catch(() => undefined);
  }, [hydrateFromServer]);

  // Determine progress based on route
  let progress = 0.25;
  if (pathname?.includes('team-size')) progress = 0.5;
  if (pathname?.includes('business-type')) progress = 0.75;
  if (pathname?.includes('channels')) progress = 1.0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-b from-cream-50 via-cream-100 to-cream-200">
      {/* Brand Header */}
      <div className="mb-6 flex items-center space-x-2">
        <span className="text-2xl font-serif font-bold text-heading tracking-wide">
          DareX<span className="text-amber-600 font-sans text-sm ml-1 px-2 py-0.5 bg-amber-500/20 rounded-full">ai</span>
        </span>
      </div>

      {/* Centered Card */}
      <div className="w-full max-w-xl bg-white border border-cream-300 rounded-3xl p-8 shadow-xl relative overflow-hidden backdrop-blur-sm">
        {/* Growth Tree Illustration */}
        <div className="mb-6">
          <GrowthTree progress={progress} />
        </div>

        {/* Wizard Step Content */}
        <div>{children}</div>
      </div>
    </div>
  );
}
