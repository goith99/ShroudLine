import type { Metadata } from "next";
import { Geist, Geist_Mono, Oswald } from "next/font/google";
import WalletProviders from "@/components/WalletProviders";
import Header from "@/components/Header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Scoreboard display face — team names, results, and big numbers only.
const oswald = Oswald({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
      className={`${geistSans.variable} ${geistMono.variable} ${oswald.variable}`}
    >
      <body>
        <WalletProviders>
          <Header />
          <main className="container">{children}</main>
          <footer className="site-footer">
            Picks are encrypted in your browser and stay veiled until
            settlement — nobody can see what you predicted.
          </footer>
        </WalletProviders>
      </body>
    </html>
  );
}
