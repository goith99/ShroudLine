# Pre-Submission Checklist

Hard blockers to clear **before** deploying the final devnet program for the demo
video / hackathon submission. These are not optional cleanup.

## 🚫 BLOCKER: strip the `test-resolve` bypass before the final deploy

`resolve_match_test` is a feature-gated instruction that resolves a market by
fiat, bypassing the Txoracle `validate_stat` CPI entirely. It exists **only** so
the encrypted submit → settle payout flow can be tested without a real oracle
proof (we have no subscribe token on devnet yet). If it ships in the submitted
build, the "trustless oracle settlement" differentiator is a lie — anyone can
resolve any market they own to any outcome.

Because `arcium build` has no `--features` passthrough, `test-resolve` currently
lives in `programs/shroudline/Cargo.toml` under
`default = ["test-resolve"]`. Before the final deploy you MUST remove it.

- [ ] Remove `test-resolve` from `default` in
      `programs/shroudline/Cargo.toml` (set `default = []`), **or**
      build with `--no-default-features`.
- [ ] Rebuild (`arcium build`) and redeploy the devnet program.
- [ ] **Verify `resolve_match_test` does NOT appear in the deployed program's IDL**
      before recording the demo:

      ```bash
      # deployed on-chain IDL (must NOT list resolve_match_test)
      anchor idl fetch 6pL5a3nAUGa8Gfnkz1K936quUJs59aXe8Ybekk7aWD5a | \
        grep -c resolve_match_test    # expect: 0

      # local build artifact sanity check too
      grep -c resolve_match_test target/idl/shroudline.json  # expect: 0
      ```

- [ ] Record the demo video only against this cleaned deployment, and prove
      settlement through the real `resolve_match` (Txoracle CPI) path — not the
      bypass.
