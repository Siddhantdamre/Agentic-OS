'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Loader2, Mail } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setSubmitted(true);
    setLoading(false);
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-emerald-50 text-center">Reset your password</h1>
      {submitted ? (
        <p className="text-sm text-emerald-200/80 text-center">
          If an account exists for that email, we sent a reset link.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <Mail className="w-4 h-4 text-emerald-500 absolute left-3.5 top-3.5" />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full pl-10 pr-4 py-2.5 bg-[#1C2825] border border-emerald-900/80 rounded-2xl text-xs text-emerald-100"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-[#F0C05A] text-[#121917] font-bold text-xs rounded-2xl disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Send reset link'}
          </button>
        </form>
      )}
      <p className="text-center text-xs text-emerald-400/70">
        <Link href="/login" className="text-[#F0C05A] font-bold">Back to sign in</Link>
      </p>
    </div>
  );
}
