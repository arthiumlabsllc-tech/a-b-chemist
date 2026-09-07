/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pinned, not inferred. This repository sits inside another repository that
  // has its own lockfile, and Next's inference picked that one — a different
  // project with different hoisted node_modules. Tracing root decides which
  // server-side files ship, so guessing it against the wrong monorepo is not a
  // warning worth tolerating. Ours is the workspace root one level up, where
  // this project's lockfile and hoisted node_modules live.
  outputFileTracingRoot: path.join(__dirname, '..'),
  // No PWA plugin. `public/sw.js` is hand-written because the till's caching
  // rules are the product: which requests may be served stale, which must never
  // be cached, and what happens to a navigation that came back redirected. A
  // generated service worker makes those decisions by default and gets at least
  // one of them wrong — the previous build cached a non-ok navigation response
  // and served the failure back offline.
};

module.exports = nextConfig;
