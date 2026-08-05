import React from 'react';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-b from-cream-50 via-cream-100 to-cream-200">
      <div className="w-full max-w-md bg-white border border-cream-300 rounded-3xl p-8 shadow-xl relative overflow-hidden backdrop-blur-sm">
        {children}
      </div>
    </div>
  );
}
