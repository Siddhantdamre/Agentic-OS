/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
