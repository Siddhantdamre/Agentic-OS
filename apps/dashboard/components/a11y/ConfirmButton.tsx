'use client';

import React from 'react';

interface ConfirmButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

/**
 * Keyboard-reachable confirm control. Always a real button with a visible
 * focus ring so approve/deny is usable without a pointer.
 */
export function ConfirmButton({
  children,
  className = '',
  type = 'button',
  ...rest
}: ConfirmButtonProps) {
  return (
    <button
      type={type}
      className={`focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
