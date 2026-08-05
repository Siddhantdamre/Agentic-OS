'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock, Mail, ArrowRight, UserCheck } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok || data.status !== 'OK') {
        throw new Error(data.message || 'Registration failed.');
      }

      // Redirect to onboarding step 1
      router.push('/onboarding/name');
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Brand Header */}
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-amber-500 flex items-center justify-center mx-auto shadow-md">
          <UserCheck className="w-6 h-6 text-heading" />
        </div>
        <h1 className="text-2xl font-serif font-bold text-heading">
          Create Organization Account
        </h1>
        <p className="text-xs text-slate-500">
          Join DareX ai to deploy autonomous AI employees in minutes.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-xl text-xs font-medium text-center">
          {error}
        </div>
      )}

      <form onSubmit={handleRegister} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-heading mb-1">Work Email</label>
          <div className="relative">
            <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@yourcompany.com"
              required
              className="w-full pl-10 pr-4 py-3 bg-cream-50 border border-cream-300 rounded-2xl text-sm text-heading focus:border-amber-500 focus:outline-none transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-heading mb-1">Password</label>
          <div className="relative">
            <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              minLength={8}
              required
              className="w-full pl-10 pr-4 py-3 bg-cream-50 border border-cream-300 rounded-2xl text-sm text-heading focus:border-amber-500 focus:outline-none transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-heading mb-1">Confirm Password</label>
          <div className="relative">
            <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              required
              className="w-full pl-10 pr-4 py-3 bg-cream-50 border border-cream-300 rounded-2xl text-sm text-heading focus:border-amber-500 focus:outline-none transition-colors"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3.5 px-6 bg-amber-500 hover:bg-amber-600 text-heading font-semibold rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-md hover:shadow-lg disabled:opacity-50"
        >
          {loading ? (
            <span>Creating account...</span>
          ) : (
            <>
              <span>Continue to Onboarding</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <div className="text-center pt-2 border-t border-cream-200 text-xs text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="text-amber-700 font-bold hover:underline">
          Sign in
        </Link>
      </div>
    </div>
  );
}
