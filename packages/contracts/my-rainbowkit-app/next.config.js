/** @type {import('next').NextConfig} */
const fs = require('fs');
const path = require('path');

const appModules = path.join(__dirname, 'node_modules');
// Real path of the linked @escrowx/sdk package (webpack resolves the symlink to this location).
const sdkDir = fs.realpathSync(path.join(appModules, '@escrowx/sdk'));

// Static site: no server, so any free static host works (GitHub Pages, Netlify, Cloudflare Pages, Vercel).
// NEXT_PUBLIC_BASE_PATH is set when served from a sub-path, e.g. /crypto-escrow-p2p on GitHub Pages.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  // Say where this app's root is instead of letting Next guess from the nearest lockfile: a stray
  // package-lock.json anywhere above the repo made it infer someone's home directory and warn on every boot.
  outputFileTracingRoot: __dirname,
  // A production build and a running dev server share .next and overwrite each other's chunks, which is how a
  // page that worked a minute ago starts serving a 500 for a chunk that no longer exists. The demo
  // environment builds into its own directory so the two can never collide.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  images: { unoptimized: true },
  basePath,
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
