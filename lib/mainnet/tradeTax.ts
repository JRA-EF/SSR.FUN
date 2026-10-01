// Manager Buy/Sell tax, charged on trades made THROUGH SSR.fun's own Buy and
// Sell (DEC-0198, 2026-09-10). The Reserve Token is a plain SPL token with no
// transfer fee, so this is enforced only where SSR.fun builds the
// transactions: lib/mainnet/buildBuy.ts adds the tax transfers to the mint
// transaction, lib/mainnet/buildSell.ts to the sale (single mode) or as a
// final "tax" transaction after every swap lands (batch mode). Trades on any
// other venue and plain wallet transfers are NOT taxed -- accepted for now
// ("that alternative is OK for the moment") over a Token-2022 transfer-fee
// mint, which would only ever cover Reserves created after a program upgrade.
//
// Rule (JRA, 2026-09-10): "Buy/sell tax on secondary markets = 50%, no
// minimum" -- the manager sets the rate (0-2%, Reserve metadata buyTaxPct /
// sellTaxPct, the same sliders that existed before), the tax is paid in USDC
// by the trader on top of a Buy / out of the proceeds of a Sell, and it is
// split 50/50 between the protocol Treasury and the Reserve's fee
// destination. A 0% rate charges nothing (no floor). Rounding: the tax is
// floor(base x bps / 10_000); the protocol takes floor(tax / 2) and the
// manager the remainder, so the two always sum to the tax exactly.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Protocol share of every trade tax, in bps of the tax (50%). */
export const TRADE_TAX_PROTOCOL_SHARE_BPS = 5_000;
/** Hard cap on a manager-configured Buy/Sell tax (2%), matching the Create Reserve slider's maximum. */
export const MAX_TRADE_TAX_BPS = 200;

export interface TradeTaxSplit {
  taxBps: number;
  baseUsdcRaw: bigint;
  taxUsdcRaw: bigint;
  protocolUsdcRaw: bigint;
  managerUsdcRaw: bigint;
}

/** Pure: a manager's percent rate (e.g. 0.75) -> bps, clamped to [0, MAX_TRADE_TAX_BPS]; anything non-finite is 0. */
export function tradeTaxBps(taxPct: number | null | undefined): number {
  if (typeof taxPct !== "number" || !Number.isFinite(taxPct) || taxPct <= 0) return 0;
  return Math.min(MAX_TRADE_TAX_BPS, Math.round(taxPct * 100));
}

/** Pure: the tax on `baseUsdcRaw` at `taxBps`, split 50/50 (protocol floor, manager remainder). */
export function computeTradeTax(baseUsdcRaw: bigint, taxBps: number): TradeTaxSplit {
  const bps = Math.max(0, Math.min(MAX_TRADE_TAX_BPS, Math.floor(taxBps)));
  if (bps === 0 || baseUsdcRaw <= 0n) return { taxBps: bps, baseUsdcRaw, taxUsdcRaw: 0n, protocolUsdcRaw: 0n, managerUsdcRaw: 0n };
  const taxUsdcRaw = (baseUsdcRaw * BigInt(bps)) / 10_000n;
  const protocolUsdcRaw = (taxUsdcRaw * BigInt(TRADE_TAX_PROTOCOL_SHARE_BPS)) / 10_000n;
  return { taxBps: bps, baseUsdcRaw, taxUsdcRaw, protocolUsdcRaw, managerUsdcRaw: taxUsdcRaw - protocolUsdcRaw };
}

export interface TradeTaxInstructionParams {
  /** The trader: owner of the source USDC ATA and payer of any recipient ATA rent. */
  trader: PublicKey;
  usdcMint: PublicKey;
  /** Protocol Treasury wallet (a Squads vault PDA -- off-curve, hence allowOwnerOffCurve below). */
  protocolDestination: PublicKey;
  /** The Reserve's fee destination (FeeConfig.fee_destination). */
  managerDestination: PublicKey;
  split: TradeTaxSplit;
}

/**
 * The instructions that pay a computed tax: idempotent ATA creates for each
 * recipient (rent paid by the trader; a no-op when the ATA exists) followed
 * by one SPL transfer per non-zero share. Empty when the tax is 0. When both
 * destinations are the same wallet the two shares are merged into one transfer.
 */
export function buildTradeTaxInstructions(p: TradeTaxInstructionParams): TransactionInstruction[] {
  const { split } = p;
  if (split.taxUsdcRaw <= 0n) return [];
  const source = getAssociatedTokenAddressSync(p.usdcMint, p.trader);
  const shares: { wallet: PublicKey; amount: bigint }[] = [];
  if (p.protocolDestination.equals(p.managerDestination)) {
    shares.push({ wallet: p.protocolDestination, amount: split.taxUsdcRaw });
  } else {
    shares.push({ wallet: p.protocolDestination, amount: split.protocolUsdcRaw });
    shares.push({ wallet: p.managerDestination, amount: split.managerUsdcRaw });
  }
  const out: TransactionInstruction[] = [];
  for (const s of shares) {
    if (s.amount <= 0n) continue;
    const ata = getAssociatedTokenAddressSync(p.usdcMint, s.wallet, true);
    out.push(createAssociatedTokenAccountIdempotentInstruction(p.trader, ata, s.wallet, p.usdcMint));
    out.push(createTransferInstruction(source, ata, p.trader, s.amount));
  }
  return out;
}

/** The manager's configured rates for one Reserve, as percents (0 when unset). */
export interface ReserveTradeTaxRates {
  buyTaxPct: number;
  sellTaxPct: number;
}
export const ZERO_TRADE_TAX: ReserveTradeTaxRates = { buyTaxPct: 0, sellTaxPct: 0 };

/** Pure: pulls the rates out of a Reserve metadata JSON payload (the same fields packages/sdk/src/discovery.ts parses); anything malformed is 0. */
export function tradeTaxRatesFromMetadata(json: unknown): ReserveTradeTaxRates {
  if (!json || typeof json !== "object") return ZERO_TRADE_TAX;
  const j = json as Record<string, unknown>;
  const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TRADE_TAX_BPS / 100) : 0);
  return { buyTaxPct: pct(j.buyTaxPct), sellTaxPct: pct(j.sellTaxPct) };
}

/** Pure: the `id` of an SSR.fun-hosted metadata URL (`.../api/{mainnet,devnet}/reserve-metadata?id=<16 hex>`), or null for any other URI. */
export function appMetadataIdFromUri(metadataUri: string): string | null {
  try {
    const u = new URL(metadataUri);
    if (!/\/api\/(mainnet|devnet)\/reserve-metadata$/.test(u.pathname)) return null;
    const id = u.searchParams.get("id") ?? "";
    return /^[0-9a-f]{16}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Pure: an inline `data:application/json,...` metadata URI's payload, or null. */
export function inlineMetadataJson(metadataUri: string): unknown {
  const m = /^data:application\/json(?:;charset=[^,]+)?,(.*)$/i.exec(metadataUri);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}

/**
 * Resolves a Reserve's tax rates from its on-chain metadata_uri: inline JSON,
 * then this app's own metadata store by id (`lookupStoredMetadata`), then a
 * plain HTTPS fetch. Any failure yields 0/0 -- a metadata hiccup must never
 * block a trade, it only forgoes the tax for that build (logged by the caller).
 */
export async function resolveReserveTradeTax(
  metadataUri: string,
  deps: { lookupStoredMetadata(id: string): Promise<unknown>; fetchJson?(url: string): Promise<unknown> },
): Promise<ReserveTradeTaxRates> {
  if (!metadataUri) return ZERO_TRADE_TAX;
  const inline = inlineMetadataJson(metadataUri);
  if (inline) return tradeTaxRatesFromMetadata(inline);
  const id = appMetadataIdFromUri(metadataUri);
  if (id) {
    try {
      return tradeTaxRatesFromMetadata(await deps.lookupStoredMetadata(id));
    } catch {
      return ZERO_TRADE_TAX;
    }
  }
  if (/^https:\/\//i.test(metadataUri) && deps.fetchJson) {
    try {
      return tradeTaxRatesFromMetadata(await deps.fetchJson(metadataUri));
    } catch {
      return ZERO_TRADE_TAX;
    }
  }
  return ZERO_TRADE_TAX;
}

/** JSON-safe view of a split for the build result's plan (bigint -> string). */
export interface TradeTaxPlan {
  taxPct: number;
  taxBps: number;
  baseUsdcRaw: string;
  taxUsdcRaw: string;
  protocolUsdcRaw: string;
  managerUsdcRaw: string;
  protocolDestination: string;
  managerDestination: string;
}
export function tradeTaxPlan(split: TradeTaxSplit, protocolDestination: PublicKey, managerDestination: PublicKey): TradeTaxPlan {
  return {
    taxPct: split.taxBps / 100,
    taxBps: split.taxBps,
    baseUsdcRaw: split.baseUsdcRaw.toString(),
    taxUsdcRaw: split.taxUsdcRaw.toString(),
    protocolUsdcRaw: split.protocolUsdcRaw.toString(),
    managerUsdcRaw: split.managerUsdcRaw.toString(),
    protocolDestination: protocolDestination.toBase58(),
    managerDestination: managerDestination.toBase58(),
  };
}
