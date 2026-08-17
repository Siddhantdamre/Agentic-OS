/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Required on Next 14 so apps/dashboard/instrumentation.ts runs boot-guards.
  experimental: {
    instrumentationHook: true,
    // Keep the document parsers OUT of the webpack bundle.
    //
    // unpdf embeds pdf.js, which relies on Node built-ins, worker resolution
    // and its own binary handling — none of which survive webpack cleanly.
    // mammoth is listed for the same reason: it happens to work bundled today,
    // but leans on the same stream/zip internals and should not be at risk.
    //
    // (The earlier "bad XRef entry" failures were pdf-parse@1.1.1 being unable
    // to read modern PDFs at all — not a bundling problem. Keeping these
    // external is correct hygiene regardless.)
    serverComponentsExternalPackages: ['unpdf', 'mammoth'],
  },
  // tsconfig paths point at shared-types/connectors TS sources that use ESM
  // `.js` specifiers. Webpack needs this alias or `next build` cannot resolve them.
  transpilePackages: ['@darex/shared-types', '@darex/connectors'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

module.exports = nextConfig;
