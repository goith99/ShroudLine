import type { NextConfig } from "next";

// @arcium-hq/client imports node "crypto" (createHash for comp-def offsets)
// and "fs" (only for its file-based module loader, never hit in the browser).
// Alias them so the client bundle resolves: crypto gets a real polyfill,
// fs gets an empty stub.
const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
    resolveAlias: {
      crypto: { browser: "crypto-browserify" },
      stream: { browser: "stream-browserify" },
      fs: { browser: "./src/lib/node-stubs.ts" },
    },
  },
};

export default nextConfig;
