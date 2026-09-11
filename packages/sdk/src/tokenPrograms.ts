// Per-asset token program resolution (DEC-0201).
//
// The protocol has been Token-2022-capable since the beginning: every asset
// leg on-chain is an `InterfaceAccount`, each ReserveAsset stores its own
// `token_program: TokenProgramKind`, and the CPI uses whichever program the
// caller passes in the leg's 5th remaining account. The CLIENT never used any
// of that -- every instruction builder hardcoded the classic SPL Token
// program, and every associated-token address was derived against it. So a
// Token-2022 asset built a transaction with the wrong program account and
// would have failed on-chain, which is why they were excluded from the asset
// picker entirely.
//
// The cost of that exclusion was not "PUMP is missing": measured 2026-09-11,
// 1,587 of 3,224 Jupiter-verified mints are Token-2022 -- 49% of the tradable
// universe, including most of the pump.fun-era tokens.
//
// This module is the one place that answers "which token program owns this
// mint", so no call site has to guess again.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/** How a ReserveAsset's `token_program` field decodes through Anchor. */
export type TokenProgramKindDecoded = { splToken?: unknown; token2022?: unknown } | null | undefined;

/** The wire name each kind maps to, for logs and payloads. */
export type TokenProgramName = "spl-token" | "token-2022";

export function isToken2022(programId: PublicKey | string | null | undefined): boolean {
  if (!programId) return false;
  const s = typeof programId === "string" ? programId : programId.toBase58();
  return s === TOKEN_2022_PROGRAM_ID.toBase58();
}

/**
 * The token program a ReserveAsset account names. Defaults to classic SPL
 * Token when the field is missing or unrecognised -- every Reserve created
 * before Token-2022 assets were selectable holds classic mints, so that is the
 * correct, safe reading rather than a guess.
 */
export function tokenProgramFromKind(kind: TokenProgramKindDecoded): PublicKey {
  if (kind && typeof kind === "object" && "token2022" in kind && kind.token2022 !== undefined) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/** The `TokenProgramKind` enum value Anchor expects as an instruction argument. */
export function tokenProgramKindArg(programId: PublicKey | string): { splToken: Record<string, never> } | { token2022: Record<string, never> } {
  return isToken2022(programId) ? { token2022: {} } : { splToken: {} };
}

/** The owning program of a mint, from the account's own owner field. Authoritative for a mint we have not registered yet. */
export function tokenProgramFromMintOwner(owner: PublicKey | string | null | undefined): PublicKey {
  return isToken2022(owner) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export function tokenProgramName(programId: PublicKey | string): TokenProgramName {
  return isToken2022(programId) ? "token-2022" : "spl-token";
}

/**
 * The associated token address for a mint under ITS OWN program.
 *
 * This is the half that silently breaks: an ATA derived against the classic
 * program for a Token-2022 mint is a completely different address that will
 * never hold the asset. Every asset-side ATA derivation in this SDK and app
 * must go through here rather than calling getAssociatedTokenAddressSync
 * directly, so the program is never assumed.
 */
export function assetAta(
  mint: PublicKey | string,
  owner: PublicKey | string,
  tokenProgram: PublicKey | string,
  allowOwnerOffCurve = false,
): PublicKey {
  const mintPk = typeof mint === "string" ? new PublicKey(mint) : mint;
  const ownerPk = typeof owner === "string" ? new PublicKey(owner) : owner;
  const programPk = typeof tokenProgram === "string" ? new PublicKey(tokenProgram) : tokenProgram;
  return getAssociatedTokenAddressSync(mintPk, ownerPk, allowOwnerOffCurve, programPk);
}

/** A leg's token program, accepting either an explicit program or a decoded kind, defaulting to classic. */
export function resolveLegTokenProgram(leg: { tokenProgram?: PublicKey | string | null }): PublicKey {
  if (!leg.tokenProgram) return TOKEN_PROGRAM_ID;
  return typeof leg.tokenProgram === "string" ? new PublicKey(leg.tokenProgram) : leg.tokenProgram;
}
