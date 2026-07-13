import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import WalletProviders from "@/components/WalletProviders";
import Header from "@/components/Header";
import "./globals.css";

// Body copy — neutral, highly legible, gets out of the way.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Data face — stakes, pool totals, tx signatures, ciphertext glyphs.
// Tabular figures by default, so numbers don't jitter as they update.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

// Display face — team names, page headings, the wordmark. Geometric
// character with a bit of edge; deliberately not another rounded
// system-font clone.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ShroudLine — Encrypted Match Predictions",
  description:
    "Predict World Cup matches with fully encrypted picks, settled trustlessly on Solana devnet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable}`}
    >
      <body>
        <WalletProviders>
          <Header />
          <main className="container">{children}</main>
          <div className="powered-by">
            <a
              href="https://txodds.net"
              target="_blank"
              rel="noopener noreferrer"
            >
              Powered by TxLINE
            </a>
            <a
              href="https://www.arcium.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Confidential compute by Arcium
            </a>
          </div>
          <footer className="site-footer">
            Picks are encrypted in your browser and stay veiled until
            settlement — nobody can see what you predicted.
          </footer>
        </WalletProviders>
      </body>
    </html>
  );
}
