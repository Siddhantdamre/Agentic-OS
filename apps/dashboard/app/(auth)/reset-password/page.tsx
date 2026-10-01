'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Lock } from 'lucide-react';

function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || 'Could not reset password');
      setLoading(false);
      return;
    }
    router.push('/login');
  };

  if (!token) {
    return (
      <p className="text-sm text-red-300 text-center">
        Missing reset token. Request a new link from{' '}
        <Link href="/forgot-password" className="text-[#F0C05A]">forgot password</Link>.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <p className="text-xs text-red-300 text-center">{error}</p>}
      <div className="relative">
        <Lock className="w-4 h-4 text-emerald-500 absolute left-3.5 top-3.5" />
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          className="w-full pl-10 pr-4 py-2.5 bg-[#1C2825] border border-emerald-900/80 rounded-2xl text-xs text-emerald-100"
        />
      </div>
      <input
        type="password"
        required
        minLength={8}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Confirm password"
        className="w-full px-4 py-2.5 bg-[#1C2825] border border-emerald-900/80 rounded-2xl text-xs text-emerald-100"
      />
      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-[#F0C05A] text-[#121917] font-bold text-xs rounded-2xl disabled:opacity-50"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Update password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-emerald-50 text-center">Choose a new password</h1>
      <Suspense fallback={<Loader2 className="w-6 h-6 animate-spin mx-auto text-[#F0C05A]" />}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
