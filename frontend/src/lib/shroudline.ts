import { AnchorProvider, IdlAccounts, Program, Provider } from "@anchor-lang/core";
import type { Wallet } from "@anchor-lang/core";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import {
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
} from "@arcium-hq/client";
import idl from "./idl/shroudline.json";
import type { Shroudline } from "./idl/shroudline-types";
import { fixtureMeta, fixtureTitle } from "./fixtures";

export const PROGRAM_ID = new PublicKey(idl.address);
export const CLUSTER_OFFSET = Number(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET ?? "456",
);
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl("devnet");

export type MarketAccount = IdlAccounts<Shroudline>["market"];
export type PredictionAccount = IdlAccounts<Shroudline>["prediction"];

export const OUTCOME_HOME = 0;
export const OUTCOME_AWAY = 1;
export const OUTCOME_DRAW = 2;

/** Read-only program handle for fetching accounts (no wallet needed). */
export function getReadonlyProgram(connection: Connection): Program<Shroudline> {
  return new Program(idl as Shroudline, { connection } as Provider);
}

export interface MarketEntry {
  publicKey: PublicKey;
  account: MarketAccount;
}

/**
 * Fetch every Market account. Unlike `program.account.market.all()`, this
 * decodes accounts one at a time and skips any that fail — devnet still holds
 * stale Market accounts from earlier program deploys with a different layout,
 * and a single bad account must not take down the whole list.
 */
export async function fetchAllMarkets(
  connection: Connection,
): Promise<MarketEntry[]> {
  const program = getReadonlyProgram(connection);
  const discriminator = (
    idl.accounts as { name: string; discriminator: number[] }[]
  ).find((a) => a.name === "Market")!.discriminator;
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(discriminator) } },
    ],
  });
  const markets: MarketEntry[] = [];
  for (const { pubkey, account } of raw) {
    try {
      markets.push({
        publicKey: pubkey,
        account: program.coder.accounts.decode("market", account.data),
      });
    } catch {
      // legacy-layout account from an old deploy — ignore
    }
  }
  return markets;
}

/** Full program handle able to send transactions via the connected wallet. */
export function getProgram(
  connection: Connection,
  wallet: Wallet,
): { program: Program<Shroudline>; provider: AnchorProvider } {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return { program: new Program(idl as Shroudline, provider), provider };
}

export function vaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function predictionPda(market: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("prediction"), market.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** The standard set of Arcium accounts every queued computation needs. */
export function arciumAccounts(computationOffset: BN, circuitName: string) {
  return {
    computationAccount: getComputationAccAddress(
      CLUSTER_OFFSET,
      computationOffset,
    ),
    clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(PROGRAM_ID),
    mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
    compDefAccount: getCompDefAccAddress(
      PROGRAM_ID,
      Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE(),
    ),
  };
}

/** MXE x25519 public key; retries because it can briefly be unavailable. */
export async function fetchMxePublicKey(
  provider: AnchorProvider,
): Promise<Uint8Array> {
  for (let i = 0; i < 12; i++) {
    try {
      const key = await getMXEPublicKey(provider, PROGRAM_ID);
      if (key) return key;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Could not reach the encryption service. Please try again.");
}

// ---- presentation helpers --------------------------------------------------

export type MarketStatus = "open" | "resolved" | "review";

/** On-chain status — drives what actions are possible. */
export function marketStatus(m: MarketAccount): MarketStatus {
  if (m.resolved) return "resolved";
  if (m.needsManualReview) return "review";
  return "open";
}

export type DisplayStatus = "open" | "awaiting" | "settled" | "review";

/**
 * Status as shown to users. An unresolved market whose kickoff has passed
 * reads "Awaiting Result" — display only; the program still accepts
 * predictions until the market is resolved.
 */
export function displayStatus(m: MarketAccount): DisplayStatus {
  if (m.resolved) return "settled";
  if (m.needsManualReview) return "review";
  const meta = fixtureMeta(m.fixtureId.toString());
  if (meta && Date.now() > Date.parse(meta.kickoffUtc)) return "awaiting";
  return "open";
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  open: "Open",
  awaiting: "Awaiting Result",
  settled: "Settled",
  review: "Under Review",
};

export function outcomeLabel(m: MarketAccount): string {
  const meta = fixtureMeta(m.fixtureId.toString());
  switch (m.outcome) {
    case OUTCOME_HOME:
      return meta ? `${meta.home} won` : "Home win";
    case OUTCOME_AWAY:
      return meta ? `${meta.away} won` : "Away win";
    case OUTCOME_DRAW:
      return "Draw";
    default:
      return "Not decided yet";
  }
}

export function marketTitle(m: MarketAccount): string {
  return fixtureTitle(m.fixtureId.toString());
}

export function formatSol(lamports: BN | number | bigint): string {
  const n = Number(lamports.toString()) / 1e9;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

export function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
