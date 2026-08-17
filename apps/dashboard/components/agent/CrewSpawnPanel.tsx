'use client';

import React, { useState } from 'react';
import { Users, Play, AlertCircle, CheckCircle2, Bot } from 'lucide-react';

interface SpawnedSpecialist {
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  task: string;
  replyMessage: string;
  usedTools: string[];
  success: boolean;
}

interface CrewResponse {
  success: boolean;
  mode: 'solo' | 'crew';
  reason?: string;
  replyMessage: string;
  spawned: SpawnedSpecialist[];
  usedTools: string[];
  usedTemporal?: boolean;
  error?: string;
}

export const CrewSpawnPanel: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CrewResponse | null>(null);

  const handleSpawn = async () => {
    const userMessage = prompt.trim();
    if (!userMessage || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/crew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage }),
      });
      const data = (await res.json()) as CrewResponse;
      if (!res.ok) {
        setError(data.error || 'Crew spawn failed');
        return;
      }
      setResult(data);
      setPrompt('');
    } catch (err: any) {
      setError(err?.message || 'Crew spawn failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between border-b border-cream-200 pb-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
            <Users className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h2 className="text-lg font-serif font-bold text-heading">Spawn crew</h2>
            <p className="text-xs text-slate-500">
              Routes across Sarah / Emma / Marcus. Cap 3. Greetings stay solo — inbound WhatsApp is never auto-crewed.
            </p>
          </div>
        </div>
        <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1 bg-amber-500/10 text-amber-800 rounded-full border border-amber-500/20">
          Max 3
        </span>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Draft a HubSpot follow-up and pull this week's Meta ads ROAS"
        rows={3}
        className="w-full px-4 py-3 bg-cream-100 border border-cream-300 rounded-2xl text-sm font-medium focus:outline-none focus:border-amber-500"
      />

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">
          Each specialist keeps their own tool allowlist. Missing OAuth still returns notConnected.
        </p>
        <button
          type="button"
          onClick={handleSpawn}
          disabled={running || !prompt.trim()}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading font-semibold text-xs rounded-xl inline-flex items-center space-x-2 disabled:opacity-50"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{running ? 'Spawning…' : 'Spawn crew'}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center space-x-2 text-xs">
            {result.success ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
            )}
            <span className="font-bold uppercase tracking-wider text-slate-500">
              {result.mode}
            </span>
            {result.reason && <span className="text-slate-500">— {result.reason}</span>}
            {result.usedTemporal && (
              <span className="text-[10px] font-bold text-emerald-700">Temporal</span>
            )}
          </div>

          {result.spawned.map((spawn) => (
            <div key={`${spawn.employeeName}-${spawn.task}`} className="p-3.5 bg-cream-100/70 border border-cream-300 rounded-2xl space-y-1.5">
              <div className="flex items-center space-x-2">
                <Bot className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-bold text-heading">{spawn.employeeName}</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-700">
                  {spawn.employeeRole}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">{spawn.task}</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{spawn.replyMessage}</p>
            </div>
          ))}

          {result.mode === 'crew' && result.replyMessage && (
            <div className="p-3.5 bg-white border border-amber-500/30 rounded-2xl space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Manager synthesis</span>
              <p className="text-sm text-heading whitespace-pre-wrap">{result.replyMessage}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
