'use client';

import React from 'react';
import { AutonomySettings } from '@/components/settings/AutonomySettings';

export default function AutonomySettingsPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">Autonomy</h1>
        <p className="text-slate-500 text-sm mt-1">
          Change autonomy tiers here, approve or reject pending actions, and dismiss suppressions.
        </p>
      </div>
      <AutonomySettings />
    </div>
  );
}
