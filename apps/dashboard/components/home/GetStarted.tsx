'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';

const HIDDEN_KEY = 'darex.getstarted.hidden';

type Step = { id: string; title: string; why: string; href: string; done: boolean };

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** What a brand-new workspace should do first. Shows nothing for a working account, or when it cannot tell. */
export function GetStarted({ channelCount }: { channelCount: number | null }) {
  const [hidden, setHidden] = useState(true); // hidden until the browser says otherwise, so it never flashes
  const [facts, setFacts] = useState<{ taught: boolean; asked: boolean } | null>(null);

  useEffect(() => {
    setHidden(readHidden());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [brainRes, chatRes] = await Promise.all([fetch('/api/brain'), fetch('/api/ask-ai/conversations')]);
        if (!brainRes.ok || !chatRes.ok) return;
        const brain = await brainRes.json();
        const chats = await chatRes.json();
        const list: Array<{ message_count?: number }> = Array.isArray(chats?.conversations) ? chats.conversations : [];
        if (alive) {
          setFacts({
            taught: brain?.empty === false,
            asked: list.some((c) => Number(c?.message_count || 0) >= 2),
          });
        }
      } catch {
        // Unknown is not "not done": show nothing instead of a wrong tick.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (hidden || facts === null || channelCount === null) return null;

  const steps: Step[] = [
    { id: 'connect', title: 'Connect your first app', why: 'So your team can read and reply to real messages.', href: '/connectors', done: channelCount > 0 },
    { id: 'teach', title: 'Teach it your business', why: 'Add your prices, hours and policies so answers sound like you.', href: '/brain', done: facts.taught },
    { id: 'ask', title: 'Ask your first question', why: 'Try “What needs me today?”. Anything risky waits for your OK.', href: '/ask-ai', done: facts.asked },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  return (
    <section aria-labelledby="get-started-title" className="rounded-3xl border border-amber-300 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="get-started-title" className="text-lg font-serif font-bold text-heading">Get started</h2>
          <p className="text-xs text-slate-500">{done} of {steps.length} done</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setHidden(true);
            try {
              window.localStorage.setItem(HIDDEN_KEY, '1');
            } catch {
              /* a browser that will not store anything shows it again next time */
            }
          }}
          className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Hide
        </button>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        {steps.map((s) => (
          <li key={s.id}>
            <Link
              href={s.href}
              className={`flex h-full items-start gap-3 rounded-2xl border p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                s.done ? 'border-emerald-200 bg-emerald-50/60' : 'border-cream-300 bg-cream-50 hover:border-amber-400'
              }`}
            >
              {s.done ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-heading">
                  {s.title}
                  <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                </span>
                <span className="mt-0.5 block text-xs text-slate-600">{s.why}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
