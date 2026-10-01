'use client';

import React from 'react';

interface GrowthTreeProps {
  progress: number; // 0.25 | 0.5 | 0.75 | 1.0
}

export const GrowthTree: React.FC<GrowthTreeProps> = ({ progress }) => {
  const level = Math.min(Math.max(Math.ceil(progress * 4), 1), 4);

  return (
    <div className="relative w-48 h-48 mx-auto flex items-center justify-center">
      <svg
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-md transition-all duration-700 ease-out"
      >
        {/* Pot / Base */}
        <path
          d="M70 165L75 185H125L130 165H70Z"
          fill="#D9A53D"
          className="transition-colors duration-500"
        />
        <path
          d="M65 158H135V165H65V158Z"
          fill="#F0C05A"
        />

        {/* Main Trunk - Stage 1+ */}
        <path
          d="M97 158V110C97 100 103 100 103 110V158H97Z"
          fill="#475569"
          className="transition-all duration-500"
        />

        {/* Branches & Leaves Stage 1 (Sprout) */}
        {level >= 1 && (
          <g className="animate-fade-in">
            <circle cx="100" cy="100" r="14" fill="#F5F2D8" stroke="#D9A53D" strokeWidth="2" />
            <circle cx="95" cy="98" r="8" fill="#84CC16" opacity="0.8" />
            <circle cx="105" cy="98" r="8" fill="#65A30D" opacity="0.8" />
          </g>
        )}

        {/* Branches & Leaves Stage 2 */}
        {level >= 2 && (
          <g className="animate-fade-in">
            {/* Left Branch */}
            <path d="M98 120C85 110 75 105 70 100" stroke="#475569" strokeWidth="4" strokeLinecap="round" />
            <circle cx="68" cy="95" r="12" fill="#84CC16" />
            <circle cx="62" cy="100" r="10" fill="#65A30D" />
            
            {/* Right Branch */}
            <path d="M102 120C115 110 125 105 130 100" stroke="#475569" strokeWidth="4" strokeLinecap="round" />
            <circle cx="132" cy="95" r="12" fill="#84CC16" />
            <circle cx="138" cy="100" r="10" fill="#65A30D" />
          </g>
        )}

        {/* Foliage Stage 3 */}
        {level >= 3 && (
          <g className="animate-fade-in">
            {/* Top Canopy Expansion */}
            <path d="M100 110V75" stroke="#475569" strokeWidth="4" strokeLinecap="round" />
            <circle cx="100" cy="65" r="22" fill="#65A30D" />
            <circle cx="85" cy="72" r="18" fill="#84CC16" />
            <circle cx="115" cy="72" r="18" fill="#4D7C0F" />
          </g>
        )}

        {/* Citrus Fruits Stage 4 (Full Blossom) */}
        {level >= 4 && (
          <g className="animate-bounce-short">
            {/* Golden Citrus Fruits */}
            <circle cx="70" cy="92" r="7" fill="#F0C05A" stroke="#B45309" strokeWidth="1" />
            <circle cx="132" cy="92" r="7" fill="#F0C05A" stroke="#B45309" strokeWidth="1" />
            <circle cx="98" cy="58" r="8" fill="#F0C05A" stroke="#B45309" strokeWidth="1" />
            <circle cx="114" cy="75" r="6.5" fill="#F0C05A" stroke="#B45309" strokeWidth="1" />
            
            {/* Sparkles */}
            <polygon points="100,40 102,44 106,46 102,48 100,52 98,48 94,46 98,44" fill="#F0C05A" />
            <polygon points="145,80 146,82 149,83 146,84 145,86 144,84 141,83 144,82" fill="#F0C05A" />
          </g>
        )}
      </svg>

      {/* Progress pill indicator */}
      <div className="absolute -bottom-2 bg-cream-200 border border-amber-500/30 text-heading text-xs font-semibold px-3 py-1 rounded-full shadow-sm">
        Step {level} of 4 — {Math.round(progress * 100)}%
      </div>
    </div>
  );
};
