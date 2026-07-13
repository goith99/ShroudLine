"use client";

import { useState } from "react";

/**
 * Shown right after a submit/settle transaction confirms. Gives the user
 * (and anyone judging the demo) proof the action actually happened on-chain,
 * with a one-click link to inspect it on Solana Explorer.
 */
export default function TransactionReceipt({
  signature,
  label,
}: {
  signature: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = `${signature.slice(0, 4)}…${signature.slice(-4)}`;
  const explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(signature);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied or unavailable — silently ignore,
      // the explorer link still works as a fallback.
    }
  };

  return (
    <div className="tx-receipt">
      <div className="tx-receipt-sig">
        <span className="tx-receipt-label">{label}</span>
        <span className="tx-receipt-code" title={signature}>
          {short}
        </span>
      </div>
      <div className="tx-receipt-actions">
        <button className="tx-receipt-btn" onClick={copy} type="button">
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          className="tx-receipt-link"
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Explorer ↗
        </a>
      </div>
    </div>
  );
}
