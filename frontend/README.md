# ShroudLine Frontend

Next.js frontend for the ShroudLine encrypted prediction market on Solana
devnet. Predictions are encrypted in the browser with the Arcium client SDK
(x25519 + RescueCipher against the MXE cluster key) before they ever leave the
device.

## Pages

- `/` — all markets, open ones first (fixture, status, total staked, close time)
- `/market/[address]` — market detail:
  - **Open**: connect wallet, pick Home/Draw/Away, submit an encrypted
    prediction (fixed stake per market, set on-chain at market creation)
  - **Resolved**: shows the result; if the connected wallet has an unsettled
    prediction, a Settle button runs the MPC check and pays 2× stake on a
    correct pick
  - **Manual review**: knockout match that ended in a shootout — settlement
    paused pending manual review

## Run locally

```bash
npm install        # postinstall applies patches/ via patch-package
npm run dev        # or: npm run build && npm run start
```

## Configuration

Copy `.env.example` to `.env.local` if you need to override defaults:

- `NEXT_PUBLIC_RPC_URL` — devnet RPC. Defaults to the public
  `api.devnet.solana.com`; use a Helius/QuickNode devnet URL for reliability
  (`getProgramAccounts` is rate-limited on the public RPC).
- `NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET` — Arcium devnet cluster offset
  (default 456, matches `Arcium.toml`).

Program ID and IDL are baked in from `src/lib/idl/shroudline.json` (copy of
`../target/idl/shroudline.json`); re-copy after redeploying the program.

## Implementation notes

- `patches/@arcium-hq+client+0.11.1.patch` fixes an ESM interop bug in the SDK
  bundle (default-import of `@anchor-lang/core`, which has no default export in
  its ESM build). Without it, `next build` fails. Applied automatically by the
  `postinstall` script.
- `next.config.ts` aliases node `crypto` → `crypto-browserify` and stubs `fs`
  for the browser bundle; the SDK's comp-def offset hashing needs a working
  `createHash` in the browser (verified byte-identical to node output).
- Markets are listed via raw `getProgramAccounts` + per-account decode instead
  of `program.account.market.all()`: devnet still holds Market accounts from
  older program deploys with a different layout, and one undecodable account
  would otherwise break the whole list.
- Team names/kickoffs come from a hardcoded fixture table in
  `src/lib/fixtures.ts` (18179759 Mexico–Ecuador, 18179550 Belgium–Senegal);
  unknown fixture ids render as generic demo markets.

## Deploy (Vercel)

1. Push the repo to GitHub.
2. In Vercel: **Add New Project** → import the repo → set **Root Directory**
   to `frontend/` (framework auto-detects Next.js; `npm install` runs
   `postinstall`, so the SDK patch is applied on Vercel too).
3. Add env vars: `NEXT_PUBLIC_RPC_URL` (a dedicated devnet RPC key is strongly
   recommended — the key is public in the client bundle, so use a provider key
   with domain allowlisting) and optionally
   `NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET=456`.
4. Deploy. Everything is client-side (wallet, RPC reads, encryption), so no
   server config, API routes, or secrets are needed.
