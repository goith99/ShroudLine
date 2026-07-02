use arcis::*;

/// Arcis circuits for private prediction settlement.
///
/// A user's prediction (0 = home win, 1 = away win, 2 = draw) is submitted
/// encrypted under the caller's shared key, then re-encrypted to MXE-owned
/// state so nobody — not even the submitter — can read it back off-chain.
/// At settlement, the encrypted prediction is compared against the plaintext
/// oracle-verified outcome and only the resulting correct/incorrect bit is
/// revealed. The prediction value itself is never exposed.
#[encrypted]
mod circuits {
    use arcis::*;

    /// Re-encrypt a user's `Enc<Shared, u8>` prediction into persistent
    /// `Enc<Mxe, u8>` state stored on the Prediction account.
    ///
    /// `Enc<Mxe, T>` cannot be conjured from client-side bytes — only a
    /// dedicated circuit like this can mint valid MXE-encrypted state
    /// (the NullRef `init_commission` pattern, repurposed here).
    #[instruction]
    pub fn store_prediction(pred_ctxt: Enc<Shared, u8>) -> Enc<Mxe, u8> {
        let prediction = pred_ctxt.to_arcis();
        Mxe::get().from_arcis(prediction)
    }

    /// Compare the stored encrypted prediction against the revealed match
    /// outcome and reveal only whether it was correct.
    #[instruction]
    pub fn check_prediction(pred_ctxt: Enc<Mxe, u8>, outcome: u8) -> bool {
        let prediction = pred_ctxt.to_arcis();
        (prediction == outcome).reveal()
    }
}
