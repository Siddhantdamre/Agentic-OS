/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image build sets SKIP_NEXT_CHECKS=1. `next build` otherwise re-runs ESLint and a full
  // type-check, which CI (`tsc --noEmit` and `pnpm lint` on every push) and the pre-push hook already
  // do; on the shared 2 vCPU production VM that step alone took over 5 minutes.
  typescript: { ignoreBuildErrors: process.env.SKIP_NEXT_CHECKS === '1' },
  eslint: { ignoreDuringBuilds: process.env.SKIP_NEXT_CHECKS === '1' },
  // Required on Next 14 so apps/dashboard/instrumentation.ts runs boot-guards.
  experimental: {
    instrumentationHook: true,
  },
  // tsconfig paths point at shared-types/connectors TS sources that use ESM
  // `.js` specifiers. Webpack needs this alias or `next build` cannot resolve them.
  transpilePackages: ['@darex/shared-types', '@darex/connectors', '@darex/whatsapp-gateway'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

module.exports = nextConfig;
