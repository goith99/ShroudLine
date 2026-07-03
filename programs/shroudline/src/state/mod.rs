use anchor_lang::prelude::*;

/// One prediction market, tied to a single TxODDS fixture (match).
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Creator/admin — the only key allowed to resolve the match.
    pub authority: Pubkey,
    /// TxODDS fixture id this market settles against.
    pub fixture_id: i64,
    /// Fixed stake (lamports) every prediction must post.
    pub stake_amount: u64,
    /// Total lamports posted across all predictions (held in the vault PDA).
    pub total_staked: u64,
    /// Number of predictions submitted.
    pub prediction_count: u64,
    /// Whether the match has been resolved via the Txoracle CPI.
    pub resolved: bool,
    /// Resolved outcome: 0 home / 1 away / 2 draw, 255 while unresolved.
    pub outcome: u8,
    /// True if this fixture is a knockout-stage match (can go to extra time /
    /// penalties). Set at init by the (off-chain) creator from the competition
    /// round; group-stage matches set this false. A knockout can be resolved
    /// across regulation, extra-time and penalty-shootout outcomes via the
    /// `validate_stat_v2` path; a group match additionally allows a DRAW.
    pub is_knockout: bool,
    /// Bump for the Market PDA.
    pub bump: u8,
    /// Bump for the associated Vault PDA.
    pub vault_bump: u8,
}

/// Program-owned lamport vault for a market. Holds no data beyond its bump so
/// that payouts are a direct lamport transfer (no `invoke_signed` needed).
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub market: Pubkey,
    pub bump: u8,
}

/// A single user's encrypted prediction for a market.
///
/// The prediction itself is stored encrypted under the MXE (`Enc<Mxe, u8>`) —
/// `ciphertext` + `nonce` are populated by the `store_prediction` circuit
/// callback in Phase 2. Until then they stay zeroed.
#[account]
#[derive(InitSpace)]
pub struct Prediction {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Lamports this user staked (equals the market's stake_amount).
    pub stake: u64,
    /// Encrypted prediction ciphertext (Enc<Mxe, u8>), written by the store callback.
    pub ciphertext: [u8; 32],
    /// Nonce for the encrypted prediction.
    pub nonce: u128,
    /// True once the encrypted prediction state has been written.
    pub encrypted: bool,
    /// True once settle_prediction has run for this prediction.
    pub settled: bool,
    /// Result of settlement (only meaningful when `settled`).
    pub correct: bool,
    pub bump: u8,
}
