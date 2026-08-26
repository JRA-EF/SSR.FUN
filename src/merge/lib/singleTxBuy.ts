// ONE-TRANSACTION Mainnet buy composition (DEC-0156): every Jupiter swap a
// purchase needs, any recovered-SOL re-wrap, the ATA creations, and the
// final mint_reserve_tokens_in_kind deposit+mint -- compiled into a SINGLE
// v0 transaction the buyer's wallet approves ONCE. The UX the Creator
// specified: X USDC out -> Y Reserve Tokens in, one Phantom approval.
//
// Why this matters beyond UX: the transaction is ATOMIC. Either the whole
// purchase lands (USDC swapped, assets deposited, Reserve Tokens minted)
// or NOTHING moves except the network fee -- no partially-funded states,
// no window for one leg's cleanup to destroy another leg's funding (the
// live 2026-08-26 failure: a USDC->SSR swap transaction's Jupiter cleanup
// closed the buyer's wSOL ATA between the wSOL swap and the mint, sweeping
// the just-acquired wrapped SOL into native SOL and failing the mint with
// SPL Token InsufficientFunds).
//
// Composition can exceed Solana's hard 1232-byte transaction limit for
// Reserves with many swap legs -- composeSingleBuyTransaction throws
// SingleTxTooLargeError in that case and multiAssetBuyClient.ts falls back
// to the sequential per-transaction flow (which remains fully guarded by
// the persistent purchase state machine).
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WRAPPED_SOL_MINT } from "@ssr/sdk";

export const SOLANA_MAX_TX_BYTES = 1232;
/** Whole-purchase compute ceiling: worst case is several routed swaps (~200-400k CU each) plus the in-kind mint (~85k CU observed live). */
export const SINGLE_TX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Priority fee per CU -- ~0.00014 SOL at the full CU limit, in line with what Jupiter's own dynamic builds have been paying on this app's live swaps. */
export const SINGLE_TX_MICRO_LAMPORTS_PER_CU = 100_000;

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Jupiter /swap-instructions wire shape for one instruction. */
export interface JupiterInstructionJson {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

/** Pure: one Jupiter wire instruction -> a web3.js TransactionInstruction. */
export function deserializeJupiterInstruction(ix: JupiterInstructionJson): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** Pure: true for a compute-budget instruction -- each swap's own budget instructions are dropped so the composed transaction carries exactly ONE limit + ONE price (duplicated compute-budget instructions fail the whole transaction). */
export function isComputeBudgetInstruction(ix: Pick<TransactionInstruction, "programId">): boolean {
  return ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM_ID;
}

/**
 * Pure: the re-wrap of recovered SOL (multiAssetBuyPlan.ts's
 * wrap-recovered-sol action) -- moves exactly `lamports` of the owner's
 * native SOL into their wSOL ATA and syncs it so the balance is spendable
 * as SPL wrapped SOL. The ATA itself is created idempotently by the mint
 * prelude's own instruction for the wrapped-SOL leg.
 */
export function buildWrapRecoveredSolInstructions(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const wsolAta = getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, owner);
  return [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports }),
    createSyncNativeInstruction(wsolAta),
  ];
}

/** One swap leg's instruction material, as returned by /api/mainnet/jupiter-swap in mode "instructions". */
export interface SwapInstructionSet {
  setupInstructions: JupiterInstructionJson[];
  swapInstruction: JupiterInstructionJson;
  addressLookupTableAddresses: string[];
}

export class SingleTxTooLargeError extends Error {
  /** Serialized size in bytes when it could be measured; null when serialization itself overran web3.js's packet-size buffer (even further over the limit). */
  readonly bytes: number | null;
  constructor(bytes: number | null) {
    super(
      `The combined single-transaction purchase is ${bytes === null ? "larger than the serialization buffer" : `${bytes} bytes`}, over Solana's ${SOLANA_MAX_TX_BYTES}-byte limit -- falling back to the step-by-step flow.`,
    );
    this.name = "SingleTxTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * Pure given its inputs: assembles the full ordered instruction list for
 * the one-transaction buy. Order: one compute budget (limit+price) -> ATA
 * creations (the mint prelude's own idempotent creates, which cover every
 * leg ATA including wSOL and the Reserve Token ATAs) -> each swap's setup
 * + swap instruction (its own compute-budget instructions dropped, its
 * cleanup NEVER included -- cleanup is the wSOL-closing unwrap) -> any
 * recovered-SOL re-wrap -> the mint itself, last.
 */
export function assembleSingleBuyInstructions(params: {
  ataCreateInstructions: TransactionInstruction[];
  swapSets: SwapInstructionSet[];
  wrapInstructions: TransactionInstruction[];
  mintInstruction: TransactionInstruction;
}): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: SINGLE_TX_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
    ...params.ataCreateInstructions,
  ];
  for (const set of params.swapSets) {
    for (const setup of set.setupInstructions) {
      const ix = deserializeJupiterInstruction(setup);
      if (!isComputeBudgetInstruction(ix)) ixs.push(ix);
    }
    const swapIx = deserializeJupiterInstruction(set.swapInstruction);
    if (!isComputeBudgetInstruction(swapIx)) ixs.push(swapIx);
  }
  ixs.push(...params.wrapInstructions);
  ixs.push(params.mintInstruction);
  return ixs;
}

/** Fetches and deduplicates the address lookup tables the swap routes compress their account lists with -- required to compile the v0 message. A listed table that can't be found on-chain is a hard error (compiling without it would silently produce a bigger, possibly invalid message). */
export async function fetchLookupTables(connection: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const unique = [...new Set(addresses)];
  const tables: AddressLookupTableAccount[] = [];
  for (const address of unique) {
    const res = await connection.getAddressLookupTable(new PublicKey(address));
    if (!res.value) throw new Error(`Address lookup table ${address} for a swap route could not be loaded -- try again.`);
    tables.push(res.value);
  }
  return tables;
}

/** Compiles the assembled instructions into ONE v0 transaction (unsigned), enforcing Solana's wire-size limit -- throws SingleTxTooLargeError when the purchase genuinely cannot fit in one transaction. */
export function compileSingleBuyTransaction(params: {
  payer: PublicKey;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
}): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: params.recentBlockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const tx = new VersionedTransaction(message);
  let bytes: number;
  try {
    bytes = tx.serialize().length;
  } catch {
    // web3.js serializes into a packet-sized buffer -- overrunning it
    // (RangeError) means the message is even further over the wire limit
    // than a measurable overage. Same verdict, typed for the fallback.
    throw new SingleTxTooLargeError(null);
  }
  if (bytes > SOLANA_MAX_TX_BYTES) throw new SingleTxTooLargeError(bytes);
  return tx;
}
