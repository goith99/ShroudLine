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

// Exact byte length of a current-layout Market account: 8 (discriminator) +
// Market::INIT_SPACE (authority 32 + fixture_id 8 + stake_amount 8 +
// total_staked 8 + prediction_count 8 + resolved 1 + outcome 1 + is_knockout 1
// + bump 1 + vault_bump 1 = 69). Older deploys used different layouts (e.g. the
// pre-V2 layout carried an extra `needs_manual_review` byte), so a length that
// doesn't match this is a stale account we must ignore — the shared struct name
// means old accounts still share our discriminator and can otherwise decode.
const MARKET_ACCOUNT_LEN = 8 + 69;

/**
 * Fetch every current-layout Market account. Unlike
 * `program.account.market.all()`, this filters to the exact current account
 * size and decodes one at a time, skipping anything else — devnet still holds
 * stale Market accounts from earlier program deploys with a different layout,
 * and a single bad account must neither appear as a duplicate nor take down the
 * whole list.
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
      { dataSize: MARKET_ACCOUNT_LEN },
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

export type MarketStatus = "open" | "resolved";

/** On-chain status — drives what actions are possible. */
export function marketStatus(m: MarketAccount): MarketStatus {
  if (m.resolved) return "resolved";
  return "open";
}

export type DisplayStatus = "open" | "awaiting" | "settled";

/**
 * Status as shown to users. An unresolved market whose kickoff has passed
 * reads "Awaiting Result" — display only; the program still accepts
 * predictions until the market is resolved.
 *
 * Note: resolution now covers regulation, extra-time and penalty-shootout
 * outcomes (via `resolve_match_v2`), so there is no longer a "manual review"
 * state for knockout draws.
 */
export function displayStatus(m: MarketAccount): DisplayStatus {
  if (m.resolved) return "settled";
  const meta = fixtureMeta(m.fixtureId.toString());
  if (meta && Date.now() > Date.parse(meta.kickoffUtc)) return "awaiting";
  return "open";
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  open: "Open",
  awaiting: "Awaiting Result",
  settled: "Settled",
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

/**
 * Absolute kickoff time, always in UTC and explicitly labelled — e.g.
 * "Jul 14, 2026, 19:00 UTC". Distinct from `formatKickoff`, which renders in the
 * viewer's local timezone with no zone label; use this where an unambiguous,
 * zone-explicit timestamp is wanted (shown in addition to the short local one).
 */
export function formatKickoffUtc(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}
