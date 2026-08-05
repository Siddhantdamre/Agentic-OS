/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@darex/shared-types"],
};

module.exports = nextConfig;
