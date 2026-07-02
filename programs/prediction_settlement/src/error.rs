use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid computation")]
    InvalidComputation,
    #[msg("Invalid callback")]
    InvalidCallback,
    #[msg("Custom error message")]
    CustomError,
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Only the market authority may perform this action")]
    Unauthorized,
    #[msg("Market has already been resolved")]
    AlreadyResolved,
    #[msg("Market has not been resolved yet")]
    NotResolved,
    #[msg("Claimed outcome is not a valid outcome value")]
    InvalidOutcome,
    #[msg("CPI target is not the expected Txoracle program")]
    InvalidOracleProgram,
    #[msg("Txoracle returned no data from validate_stat")]
    OracleNoReturnData,
    #[msg("Oracle rejected the claimed outcome (validate_stat returned false)")]
    OracleRejected,
    #[msg("Prediction has already been settled")]
    AlreadySettled,
    #[msg("Encrypted prediction state has not been stored yet")]
    PredictionNotStored,
    #[msg("Vault has insufficient funds for payout")]
    InsufficientVault,
}
