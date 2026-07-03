"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

// The wallet button renders differently before/after the wallet adapter
// hydrates, so keep it client-only to avoid a hydration mismatch.
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

export default function Header() {
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <span className="brand-mark">◍</span> ShroudLine
        <span className="brand-tag">encrypted match predictions · devnet</span>
      </Link>
      <WalletMultiButton />
    </header>
  );
}
