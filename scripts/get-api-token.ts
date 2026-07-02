// Acquire a TxLINE X-Api-Token (World Cup free tier, devnet) and save it to .env.
//
// Flow (per TxLINE Quickstart + devnet IDL + OpenAPI docs.yaml):
//   1. POST /auth/guest/start                    -> guest JWT ({ token })
//   2. on-chain `subscribe(serviceLevelId=1, weeks=4)` on the txoracle program
//   3. sign the message `${txSig}::${jwt}` with the wallet (ed25519, base58 sig)
//   4. POST /api/token/activate (Bearer jwt) { txSig, walletSignature, leagues:[] }
//      -> plain-text API token
//   5. write TXLINE_API_TOKEN=<token> into .env
//
// Run (from project root, devnet RPC + wallet in env):
//   ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/get-api-token.ts

import * as anchor from "@anchor-lang/core";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import * as fs from "fs";

// ---- Devnet constants (from PROJECT_CONTEXT.md / official docs) ------------
const API_ORIGIN = "https://txline-dev.txodds.com";
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// subscribe: discriminator + args, from the devnet IDL
const SUBSCRIBE_DISC = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]);
const SERVICE_LEVEL_ID = 1; // World Cup free tier
const WEEKS = 4;
const LEAGUES: number[] = []; // standard matrix -> empty leagues

const ata = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), TXL_MINT.toBuffer()],
    ATA_PROGRAM,
  )[0];

function upsertEnv(key: string, value: string) {
  const path = ".env";
  let body = fs.existsSync(path) ? fs.readFileSync(path, "utf-8") : "";
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(body)) {
    body = body.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    body = body.replace(/\s*$/, "") + `\n${line}\n`;
  }
  fs.writeFileSync(path, body);
}

describe("TxLINE api-token acquisition (devnet free tier)", () => {
  it("subscribes on-chain and activates an X-Api-Token", async function () {
    this.timeout(100000000);

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const owner = (provider.wallet as anchor.Wallet).payer;
    const user = owner.publicKey;

    // 1) guest JWT
    const guestRes = await fetch(`${API_ORIGIN}/auth/guest/start`, {
      method: "POST",
    });
    if (!guestRes.ok)
      throw new Error(`guest/start ${guestRes.status}: ${await guestRes.text()}`);
    const jwt = ((await guestRes.json()) as { token: string }).token;
    console.log("guest JWT acquired (len", jwt.length, ")");

    // 2) on-chain subscribe (skip via SUBSCRIBE_TXSIG to reuse a prior subscribe)
    let txSig = process.env.SUBSCRIBE_TXSIG || "";
    if (!txSig) {
    const [pricingMatrix] = PublicKey.findProgramAddressSync(
      [Buffer.from("pricing_matrix")],
      TXORACLE,
    );
    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_treasury_v2")],
      TXORACLE,
    );
    const userTokenAccount = ata(user);
    const tokenTreasuryVault = ata(tokenTreasuryPda);

    const data = Buffer.concat([
      SUBSCRIBE_DISC,
      (() => {
        const b = Buffer.alloc(3);
        b.writeUInt16LE(SERVICE_LEVEL_ID, 0);
        b.writeUInt8(WEEKS, 2);
        return b;
      })(),
    ]);
    const keys = [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: pricingMatrix, isSigner: false, isWritable: false },
      { pubkey: TXL_MINT, isSigner: false, isWritable: false },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenTreasuryVault, isSigner: false, isWritable: true },
      { pubkey: tokenTreasuryPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    ];
    const ix = new TransactionInstruction({ programId: TXORACLE, keys, data });

    // subscribe requires user_token_account to already exist (no init_if_needed),
    // so create the user's Token-2022 TxL ATA first (idempotent, 0 balance — the
    // free tier requires no TxL payment). ATA-program CreateIdempotent = data [1].
    const createAtaIx = new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true }, // payer
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: false }, // ATA owner
        { pubkey: TXL_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });

    const tx = new Transaction().add(createAtaIx, ix);
    const bh = await provider.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = user;
    txSig = await provider.sendAndConfirm(tx, [owner], {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      blockhash: bh as any,
    });
    console.log("subscribe txSig:", txSig);
    } else {
      console.log("Reusing subscribe txSig from env:", txSig);
    }

    // 3) sign `${txSig}::${jwt}` (empty leagues)
    const message = `${txSig}:${LEAGUES.join(",")}:${jwt}`;
    const naclImpl: any = (nacl as any).sign ? nacl : (nacl as any).default;
    const sig = naclImpl.sign.detached(
      new TextEncoder().encode(message),
      owner.secretKey,
    );
    const walletSignature = Buffer.from(sig).toString("base64");

    // 4) activate -> plain-text token
    const actRes = await fetch(`${API_ORIGIN}/api/token/activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ txSig, walletSignature, leagues: LEAGUES }),
    });
    const actBody = (await actRes.text()).trim();
    if (!actRes.ok)
      throw new Error(`token/activate ${actRes.status}: ${actBody}`);
    // response is plain text; tolerate a JSON {token} shape too
    let apiToken = actBody;
    try {
      const j = JSON.parse(actBody);
      if (j && typeof j.token === "string") apiToken = j.token;
    } catch {
      /* plain text, keep as-is */
    }
    apiToken = apiToken.replace(/^"|"$/g, "");
    console.log("API token acquired:", apiToken.slice(0, 12) + "…");

    // 5) persist
    upsertEnv("TXLINE_API_TOKEN", apiToken);
    console.log("Saved TXLINE_API_TOKEN to .env");
  });
});
