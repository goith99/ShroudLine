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
      <div className="header-actions">
        <a
          href="https://github.com/goith99/ShroudLine"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="View source on GitHub"
          title="View source on GitHub"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.57.1.78-.25.78-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.74.4-1.26.72-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.77.11 3.06.74.8 1.19 1.83 1.19 3.09 0 4.43-2.7 5.41-5.27 5.69.41.36.78 1.07.78 2.16 0 1.56-.01 2.82-.02 3.21 0 .3.2.66.79.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
          </svg>
          <span className="github-link-text">Source</span>
        </a>
        <WalletMultiButton />
      </div>
    </header>
  );
}
