/**
 * Collapsible differentiator strip for the homepage. Answers "what makes
 * ShroudLine different" with claims that map directly to what's actually
 * verifiable in the program and on the market detail page (Arcium encryption,
 * TxLINE oracle CPI, N-dimensional stat validation for AET/shootouts) rather
 * than generic marketing language.
 */
export default function WhyShroudLine() {
  return (
    <details className="why-strip">
      <summary>
        Why ShroudLine <span className="chev">›</span>
      </summary>
      <div className="why-grid">
        <div className="why-item">
          <span className="why-item-title">Picks are actually private</span>
          <span className="why-item-body">
            Encrypted client-side with Arcium MPC before anything leaves your
            browser. The program itself can&apos;t read a pick — most
            &quot;private&quot; prediction markets just hide picks off-chain
            in a database.
          </span>
        </div>
        <div className="why-item">
          <span className="why-item-title">Results aren&apos;t self-reported</span>
          <span className="why-item-body">
            Every settlement is checked on-chain against TxLINE&apos;s oracle
            via a <code>Txoracle::validate_stat_v2</code> CPI. The program
            only pays out if the oracle agrees — nobody can just declare a
            winner.
          </span>
        </div>
        <div className="why-item">
          <span className="why-item-title">Handles real match outcomes</span>
          <span className="why-item-body">
            N-dimensional stat validation covers extra time and penalty
            shootouts, not just 90-minute results — knockout rounds settle
            correctly.
          </span>
        </div>
        <div className="why-item">
          <span className="why-item-title">Nothing to trust, everything to verify</span>
          <span className="why-item-body">
            Program, circuits, and settlement logic are open source. Every
            pick and every settlement is a real devnet transaction you can
            inspect yourself.
          </span>
        </div>
      </div>
    </details>
  );
}
