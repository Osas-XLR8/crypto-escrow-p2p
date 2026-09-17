/** @type {import('next').NextConfig} */
const fs = require('fs');
const path = require('path');

const appModules = path.join(__dirname, 'node_modules');
// Real path of the linked @escrowx/sdk package (webpack resolves the symlink to this location).
const sdkDir = fs.realpathSync(path.join(appModules, '@escrowx/sdk'));

const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // For files inside the linked SDK only: resolve bare imports (viem, nostr-tools) from this app's
    // node_modules first, so the bundle holds one copy of each and wagmi's clients are compatible.
    // Scoped to the SDK so other packages keep their own nested dependencies.
    config.module.rules.push({
      include: [sdkDir],
      resolve: { modules: [appModules, 'node_modules'] },
    });
    return config;
  },
};

module.exports = nextConfig;
