'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sparkles, MessageSquare, Clock, AlertTriangle, CheckCircle2, ArrowUpRight, Send, RefreshCw } from 'lucide-react';

export default function HomePage() {
  const searchParams = useSearchParams();
  const [isWarmup, setIsWarmup] = useState(searchParams?.get('warmup') === 'true');
  const [provisionProgress, setProvisionProgress] = useState(35);
  const [askQuery, setAskQuery] = useState('');

  // Simulate warm-up state progress polling
  useEffect(() => {
    if (isWarmup) {
      const timer = setInterval(() => {
        setProvisionProgress((prev) => {
          if (prev >= 100) {
            clearInterval(timer);
            setIsWarmup(false);
            return 100;
          }
          return prev + 25;
        });
      }, 2500);
      return () => clearInterval(timer);
    }
  }, [isWarmup]);

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Top Welcome Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">
            Good Morning, Owner
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Here is your daily snapshot across your AI employees and connected channels.
          </p>
        </div>

        {/* State Toggle for demo / testing */}
        <button
          onClick={() => {
            setIsWarmup(!isWarmup);
            setProvisionProgress(35);
          }}
          className="px-4 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 rounded-xl text-xs font-semibold text-slate-700 flex items-center space-x-2 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Toggle View: {isWarmup ? 'Warm-up State' : 'Steady State'}</span>
        </button>
      </div>

      {/* Warm-Up State Card (when onboarding just submitted) */}
      {isWarmup ? (
        <div className="bg-white border-2 border-amber-500/30 rounded-3xl p-8 shadow-lg relative overflow-hidden">
          <div className="flex items-start space-x-5">
            <div className="p-4 bg-amber-500/20 rounded-2xl shrink-0">
              <Sparkles className="w-8 h-8 text-amber-600 animate-spin" />
            </div>
            <div className="space-y-3 flex-1">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-serif font-bold text-heading">
                  Your business is coming online...
                </h2>
                <span className="text-sm font-bold text-amber-600 bg-amber-500/10 px-3 py-1 rounded-full">
                  {provisionProgress}% Complete
                </span>
              </div>
              <p className="text-slate-600 text-sm">
                Provisioning AI employee roster (Sarah, Emma, Marcus), establishing Nango OAuth connectors, and setting up Chatwoot channel webhooks.
              </p>

              {/* Progress bar */}
              <div className="w-full bg-cream-200 h-3 rounded-full overflow-hidden">
                <div
                  className="bg-amber-500 h-full transition-all duration-700 ease-out"
                  style={{ width: `${provisionProgress}%` }}
                />
              </div>

              {/* Live steps checklist */}
              <div className="grid grid-cols-3 gap-4 pt-2 text-xs font-medium text-slate-600">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span>AI Employees Created</span>
                </div>
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className={`w-4 h-4 ${provisionProgress >= 50 ? 'text-emerald-500' : 'text-slate-300'}`} />
                  <span>Nango Credentials Isolated</span>
                </div>
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className={`w-4 h-4 ${provisionProgress >= 100 ? 'text-emerald-500' : 'text-slate-300'}`} />
                  <span>Channels Connected</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Grid Layout */}
      <div className="grid grid-cols-12 gap-8">
        {/* Left 8 Cols — Snapshot & Cards */}
        <div className="col-span-8 space-y-8">
          {/* Today's Snapshot 4-Stat Grid */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Conversations</span>
              <div className="text-3xl font-bold text-heading">142</div>
              <span className="text-xs text-emerald-600 font-medium">↑ +18% from yesterday</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Response</span>
              <div className="text-3xl font-bold text-heading">1.4s</div>
              <span className="text-xs text-emerald-600 font-medium">99.8% AI automated</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Needs Attention</span>
              <div className="text-3xl font-bold text-amber-600">3</div>
              <span className="text-xs text-amber-600 font-medium">Human review queued</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">CSAT Score</span>
              <div className="text-3xl font-bold text-heading">4.9/5</div>
              <span className="text-xs text-emerald-600 font-medium">Based on 89 reviews</span>
            </div>
          </div>

          {/* AI Employees Roster Preview */}
          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-serif font-bold text-heading">Active AI Employee Roster</h2>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-2xl bg-cream-100 border border-cream-300 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-heading">Sarah</span>
                  <span className="text-xs font-semibold px-2.5 py-0.5 bg-amber-500/20 text-amber-700 rounded-full">Sales</span>
                </div>
                <p className="text-xs text-slate-500">Lead qualification & demo booking</p>
                <div className="text-xs font-semibold text-slate-700 pt-1">48 active chats today</div>
              </div>

              <div className="p-4 rounded-2xl bg-cream-100 border border-cream-300 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-heading">Emma</span>
                  <span className="text-xs font-semibold px-2.5 py-0.5 bg-emerald-500/20 text-emerald-700 rounded-full">Support</span>
                </div>
                <p className="text-xs text-slate-500">Customer resolution & FAQs</p>
                <div className="text-xs font-semibold text-slate-700 pt-1">74 active chats today</div>
              </div>

              <div className="p-4 rounded-2xl bg-cream-100 border border-cream-300 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-heading">Marcus</span>
                  <span className="text-xs font-semibold px-2.5 py-0.5 bg-blue-500/20 text-blue-700 rounded-full">Marketing</span>
                </div>
                <p className="text-xs text-slate-500">Campaign analytics & ad monitoring</p>
                <div className="text-xs font-semibold text-slate-700 pt-1">20 active chats today</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right 4 Cols — Needs Attention Queue & Activity Feed */}
        <div className="col-span-4 space-y-8">
          {/* Needs Your Attention Stack */}
          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-serif font-bold text-heading">Needs Attention</h2>
              <span className="w-6 h-6 rounded-full bg-amber-500 text-heading text-xs font-bold flex items-center justify-center">3</span>
            </div>

            <div className="space-y-3">
              <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-1">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-700">
                  <span className="flex items-center space-x-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Discount Request ($150)</span>
                  </span>
                  <span>WhatsApp</span>
                </div>
                <p className="text-xs text-slate-700">Customer requested custom pricing above Sarah's auto-approval limit.</p>
              </div>

              <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-1">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-700">
                  <span className="flex items-center space-x-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Refund Escalate</span>
                  </span>
                  <span>Email</span>
                </div>
                <p className="text-xs text-slate-700">Order #4092 missing package — Emma paused workflow for human sign-off.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom "Ask Anything" Chat Bar */}
      <div className="bg-white border border-cream-300 rounded-3xl p-4 shadow-lg flex items-center space-x-4">
        <Sparkles className="w-6 h-6 text-amber-600 shrink-0 ml-2" />
        <input
          type="text"
          value={askQuery}
          onChange={(e) => setAskQuery(e.target.value)}
          placeholder="Ask your business anything (e.g., 'Which channels brought in the most leads this week?')"
          className="flex-1 bg-transparent border-none focus:outline-none text-heading font-medium placeholder:text-slate-400"
        />
        <button
          onClick={() => {
            if (askQuery.trim()) {
              alert(`Querying org business intelligence: "${askQuery}"`);
              setAskQuery('');
            }
          }}
          className="p-3 bg-amber-500 hover:bg-amber-600 text-heading rounded-2xl transition-colors shadow-sm"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
