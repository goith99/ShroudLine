use anchor_lang::prelude::*;
use arcium_anchor::comp_def_offset;

#[constant]
pub const SEED: &str = "arcium";

// ---- Arcium computation-definition offsets ----
pub const COMP_DEF_OFFSET_STORE_PREDICTION: u32 = comp_def_offset("store_prediction");
pub const COMP_DEF_OFFSET_CHECK_PREDICTION: u32 = comp_def_offset("check_prediction");

// ---- PDA seeds ----
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PREDICTION_SEED: &[u8] = b"prediction";

// Byte offset of `Prediction.ciphertext` within the account data, used when
// passing the stored `Enc<Mxe, u8>` back into the check_prediction circuit via
// ArgBuilder::account(). Layout: 8 (disc) + 32 (market) + 32 (user) + 8 (stake).
pub const PREDICTION_CIPHERTEXT_OFFSET: u32 = 8 + 32 + 32 + 8;

// Correct predictions are paid this multiple of their stake from the vault.
pub const PAYOUT_MULTIPLIER: u64 = 2;

// ---- Match outcomes (also the plaintext value a user encrypts as their prediction) ----
pub const OUTCOME_HOME_WIN: u8 = 0;
pub const OUTCOME_AWAY_WIN: u8 = 1;
pub const OUTCOME_DRAW: u8 = 2;
pub const OUTCOME_UNRESOLVED: u8 = 255;

// ---- TxODDS Txoracle program (devnet) — CPI target for trustless settlement ----
// Mainnet: 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA
pub const TXORACLE_PROGRAM_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// Anchor instruction discriminator for Txoracle's `validate_stat_v2`
// (= sha256("global:validate_stat_v2")[..8]). The N-stat V2 entrypoint; the
// single-/two-stat V1 `validate_stat` path has been retired.
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];

// ---- TxLINE score stat keys (base key + period offset) ----
// key = base (1/2 = home/away goals) + period offset. Period 0 (no offset) is the
// full-game total: it INCLUDES extra time but, by football convention, EXCLUDES
// penalty-shootout goals — so key1 == key2 exactly characterises "level after ET",
// i.e. the match went to a shootout.
pub const KEY_HOME_GOALS: u32 = 1;
pub const KEY_AWAY_GOALS: u32 = 2;
// Penalty-shootout (PE) goals live at the +6000 period offset. NOTE: the +6000
// slot is inferred from the feed's numbering (ET2=+5000, ETTotal=+7000 are
// confirmed) but is NOT yet empirically verified against a finished shootout
// fixture — no FPE fixture has been available. Confirm against a real FPE
// fixture before relying on shootout resolution in production.
pub const KEY_HOME_PE_GOALS: u32 = 6001;
pub const KEY_AWAY_PE_GOALS: u32 = 6002;
