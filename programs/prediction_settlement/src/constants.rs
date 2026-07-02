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

// Anchor instruction discriminator for Txoracle's `validate_stat` (= sha256("global:validate_stat")[..8]).
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];
