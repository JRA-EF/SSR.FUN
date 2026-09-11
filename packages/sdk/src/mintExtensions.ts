// Which Token-2022 mints this protocol can actually hold (DEC-0205).
//
// Opening the asset picker to Token-2022 (DEC-0201) was half a fix. The
// program accepts Token-2022, but NOT every Token-2022 mint: five extensions
// are rejected on registration because each one breaks an assumption the
// protocol relies on. Without a matching client-side filter the picker offers
// mints that cannot possibly be registered, and the user finds out only after
// paying for a Reserve-creation transaction that fails on instruction 2.
// That is exactly what happened live on 2026-09-11 with PUMP, which carries a
// TransferHook (signature k4LFCn13SJoMuj2r13toJ7JeAk81FLXXkm8K7qzHbzdEC3qSCxbTZP6oB4gDLHqZYR29EZWx7cfJ3gtdpUsvKLr,
// SsrError::UnsupportedMintExtension 6007).
//
// The list below MIRRORS programs/ssr_protocol/src/instructions/common.rs's
// `validate_asset_mint_extensions` REJECTED array exactly. If the program's
// list ever changes, this one has to change with it -- the test suite pins
// them against each other by reading the Rust source, so they cannot drift
// silently.
import { PublicKey } from "@solana/web3.js";
import { ExtensionType, getExtensionTypes, unpackMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { isToken2022 } from "./tokenPrograms";

/**
 * Extensions the on-chain program refuses at `initialize_reserve_asset`.
 *
 * Why each one, in the protocol's own terms:
 *  - TransferFee / TransferHook: the amount that arrives is not the amount
 *    sent, or arbitrary code runs on every transfer. Either breaks the
 *    balance-delta accounting every deposit, redemption and rebalance uses.
 *  - PermanentDelegate: a third party could move the Reserve's assets out of
 *    its vault at will.
 *  - NonTransferable: the vault could never pay a redemption.
 *  - ConfidentialTransferMint: balances are not publicly readable, so NAV
 *    cannot be computed honestly.
 */
export const REJECTED_MINT_EXTENSIONS: ExtensionType[] = [
  ExtensionType.TransferFeeConfig,
  ExtensionType.TransferHook,
  ExtensionType.PermanentDelegate,
  ExtensionType.NonTransferable,
  ExtensionType.ConfidentialTransferMint,
];

/** Human-readable names, for an error a user can act on. */
const EXTENSION_LABELS: Record<number, string> = {
  [ExtensionType.TransferFeeConfig]: "a transfer fee",
  [ExtensionType.TransferHook]: "a transfer hook",
  [ExtensionType.PermanentDelegate]: "a permanent delegate",
  [ExtensionType.NonTransferable]: "a non-transferable flag",
  [ExtensionType.ConfidentialTransferMint]: "confidential transfers",
};

export function describeExtension(ext: ExtensionType): string {
  return EXTENSION_LABELS[ext] ?? `extension ${ExtensionType[ext] ?? ext}`;
}

export interface MintCompatibility {
  supported: boolean;
  /** The rejected extensions this mint carries, empty when supported. */
  rejected: ExtensionType[];
  /** A sentence naming the problem, or null when supported. */
  reason: string | null;
}

export const SUPPORTED: MintCompatibility = { supported: true, rejected: [], reason: null };

/** Pure: decides compatibility from a mint's extension list. */
export function assessExtensions(extensions: ExtensionType[]): MintCompatibility {
  const rejected = extensions.filter((e) => REJECTED_MINT_EXTENSIONS.includes(e));
  if (rejected.length === 0) return SUPPORTED;
  const names = rejected.map(describeExtension);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    supported: false,
    rejected,
    reason: `carries ${list}, which SSR.fun cannot hold safely`,
  };
}

/**
 * Compatibility of a mint from its raw account. Classic SPL Token mints carry
 * no extension data at all and are always supported, matching the program's
 * own early return.
 */
export function assessMintAccount(
  mint: PublicKey,
  account: { data: Buffer; owner: PublicKey } | null | undefined,
): MintCompatibility {
  if (!account) return SUPPORTED;
  if (!isToken2022(account.owner)) return SUPPORTED;
  try {
    const unpacked = unpackMint(mint, account as never, TOKEN_2022_PROGRAM_ID);
    return assessExtensions(getExtensionTypes(unpacked.tlvData));
  } catch {
    // A mint we cannot decode is one we cannot vouch for. The program would
    // reject it with UnsupportedTokenProgram, so refuse it here rather than
    // letting a user pay to discover that.
    return { supported: false, rejected: [], reason: "could not be decoded as a Token-2022 mint" };
  }
}

/** The user-facing sentence for a blocked asset. */
export function describeIncompatibleAsset(symbol: string, compat: MintCompatibility): string {
  return `${symbol} ${compat.reason ?? "is not supported"}. Remove it from the basket to continue.`;
}
