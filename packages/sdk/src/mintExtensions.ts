// Which Token-2022 mints this protocol can actually hold.
//
// This MIRRORS programs/ssr_protocol/src/instructions/common.rs's
// `validate_asset_mint_extensions`. If the program's rules change, these must
// change with them -- the test suite pins them against each other by reading
// the Rust source, so they cannot drift silently.
//
// The rules judge what an extension is CONFIGURED to do, not merely that it is
// present. Judging by presence over-blocked badly: xStocks' 1,025 tokenised
// equities declare a TransferHook with NO hook program and a
// ConfidentialTransferMint that does not auto-approve accounts -- neither can
// affect a Reserve, yet every one of them was refused.
import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  getExtensionData,
  getExtensionTypes,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
  TOKEN_2022_PROGRAM_ID,
  type Mint,
} from "@solana/spl-token";
import { isToken2022 } from "./tokenPrograms";

/**
 * Issuers whose PermanentDelegate is accepted. Mirrors the program's
 * APPROVED_PERMANENT_DELEGATES.
 *
 * A permanent delegate can move tokens out of ANY account holding the mint,
 * a Reserve vault included. Unacceptable from an anonymous mint; unavoidable
 * for a regulated tokenised equity, whose issuer must be able to act on the
 * underlying. So it is allowed by ISSUER, not by extension.
 *
 * This is xStocks' delegate, the same key on all of their Solana mints
 * (verified on-chain 2026-09-23), so new listings are covered automatically.
 */
export const APPROVED_PERMANENT_DELEGATES: string[] = ["5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq"];

/** Extensions whose configuration decides the answer. Kept for the parity test. */
export const CONDITIONAL_MINT_EXTENSIONS: ExtensionType[] = [
  ExtensionType.TransferFeeConfig,
  ExtensionType.TransferHook,
  ExtensionType.PermanentDelegate,
  ExtensionType.ConfidentialTransferMint,
];

/** Extensions that are never acceptable, whatever they are set to. */
export const ALWAYS_REJECTED_MINT_EXTENSIONS: ExtensionType[] = [ExtensionType.NonTransferable];

export interface MintCompatibility {
  supported: boolean;
  /** The extensions that made this mint unsupported, empty when supported. */
  rejected: ExtensionType[];
  /** A sentence naming the problem, or null when supported. */
  reason: string | null;
  /**
   * Powers an approved issuer still holds over a SUPPORTED mint. Not a defect
   * -- a property of the asset, and the UI must disclose it.
   */
  issuerPowers?: string[];
}

export const SUPPORTED: MintCompatibility = { supported: true, rejected: [], reason: null };

/** `ConfidentialTransferMint` layout: authority (32) then auto_approve_new_accounts (1). */
function confidentialAutoApproves(mint: Mint): boolean {
  const data = getExtensionData(ExtensionType.ConfidentialTransferMint, mint.tlvData);
  // No data means we cannot prove it is safe, so treat it as auto-approving.
  return data === null || data.length < 33 ? true : data[32] !== 0;
}

/**
 * Decides compatibility from an unpacked mint, by configuration.
 *
 * Kept deliberately parallel to the program's match arms so the two can be
 * read side by side.
 */
export function assessMint(mint: Mint): MintCompatibility {
  const rejected: ExtensionType[] = [];
  const reasons: string[] = [];
  const issuerPowers: string[] = [];

  for (const ext of getExtensionTypes(mint.tlvData)) {
    switch (ext) {
      case ExtensionType.NonTransferable:
      case ExtensionType.NonTransferableAccount: {
        rejected.push(ExtensionType.NonTransferable);
        reasons.push("cannot be transferred, so a Reserve could never pay a redemption");
        break;
      }
      case ExtensionType.TransferHook: {
        // Harmless when no hook program is set: the mint transfers like any other.
        if (getTransferHook(mint)?.programId && !getTransferHook(mint)!.programId.equals(PublicKey.default)) {
          rejected.push(ext);
          reasons.push("runs a transfer hook, which can block or alter every transfer");
        }
        break;
      }
      case ExtensionType.TransferFeeConfig: {
        // A scheduled fee activates on its own epoch with nobody acting, so a
        // zero fee today is not enough.
        const fee = getTransferFeeConfig(mint);
        const older = fee?.olderTransferFee.transferFeeBasisPoints ?? 0;
        const newer = fee?.newerTransferFee.transferFeeBasisPoints ?? 0;
        if (older !== 0 || newer !== 0) {
          rejected.push(ext);
          reasons.push("charges a transfer fee, so the amount that arrives is not the amount sent");
        }
        break;
      }
      case ExtensionType.PermanentDelegate: {
        const delegate = getPermanentDelegate(mint)?.delegate;
        if (delegate && !delegate.equals(PublicKey.default)) {
          if (APPROVED_PERMANENT_DELEGATES.includes(delegate.toBase58())) {
            issuerPowers.push("the issuer can move this asset out of the Reserve (permanent delegate)");
          } else {
            rejected.push(ext);
            reasons.push("has a permanent delegate that is not an approved issuer, which could move the Reserve's holdings");
          }
        }
        break;
      }
      case ExtensionType.ConfidentialTransferMint: {
        // A holder must opt in per account and the protocol never does, so
        // this only matters when new accounts are auto-approved.
        if (confidentialAutoApproves(mint)) {
          rejected.push(ext);
          reasons.push("auto-approves confidential transfers, so balances need not be publicly readable");
        }
        break;
      }
      case ExtensionType.PausableConfig: {
        issuerPowers.push("the issuer can pause transfers");
        break;
      }
      default:
        break;
    }
  }

  if (rejected.length > 0) {
    const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
    return { supported: false, rejected, reason: `${list}, which SSR.fun cannot hold safely` };
  }
  return { supported: true, rejected: [], reason: null, issuerPowers: issuerPowers.length ? issuerPowers : undefined };
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
    return assessMint(unpackMint(mint, account as never, TOKEN_2022_PROGRAM_ID));
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
