// Anchor's own internal/framework error codes (as opposed to ssr_protocol's
// custom errors, which start at 6000 -- see errors.ts). Transcribed directly
// from anchor-lang-error 1.1.2's own source (the exact version this program
// is built against, confirmed via programs/ssr_protocol/Cargo.lock) so a
// raw error code in this range (100-5000) can be decoded with the same
// honesty as an ssr_protocol-specific one, instead of just being reported as
// "not a genuine ssr_protocol error" with no further detail. Added after a
// live DevNet collect_fees failure was reported as "Custom 2040" and traced
// to exactly ConstraintDuplicateMutableAccount below -- see
// docs/project/DECISION_LOG.md for the corrective entry.
export interface AnchorFrameworkError {
  code: number;
  name: string;
  msg: string;
}

/** Which named sub-range a framework error code falls in -- mirrors the doc comment on anchor-lang-error's own ErrorCode enum. */
export function anchorFrameworkErrorRange(code: number): string | null {
  if (code >= 100 && code < 1000) return "Anchor instruction-dispatch error";
  if (code >= 1000 && code < 1500) return "Anchor IDL-instruction error (deprecated subsystem)";
  if (code >= 1500 && code < 2000) return "Anchor event-CPI error";
  if (code >= 2000 && code < 2500) return "Anchor account-constraint error (#[account(...)] validation)";
  if (code >= 2500 && code < 3000) return "Anchor require!/require_*! macro violation";
  if (code >= 3000 && code < 4100) return "Anchor account-deserialization/ownership error";
  if (code >= 4100 && code < 5000) return "Anchor miscellaneous framework error";
  if (code === 5000) return "Anchor deprecated-API error";
  return null;
}

const ANCHOR_FRAMEWORK_ERRORS: AnchorFrameworkError[] = [
  { code: 100, name: "InstructionMissing", msg: "Instruction discriminator not provided" },
  { code: 101, name: "InstructionFallbackNotFound", msg: "Fallback functions are not supported" },
  { code: 102, name: "InstructionDidNotDeserialize", msg: "The program could not deserialize the given instruction" },
  { code: 103, name: "InstructionDidNotSerialize", msg: "The program could not serialize the given instruction" },
  { code: 1000, name: "IdlInstructionStub", msg: "The program was compiled without idl instructions" },
  { code: 1001, name: "IdlInstructionInvalidProgram", msg: "Invalid program given to the IDL instruction" },
  { code: 1002, name: "IdlAccountNotEmpty", msg: "IDL account must be empty in order to resize, try closing first" },
  { code: 1500, name: "EventInstructionStub", msg: "The program was compiled without `event-cpi` feature" },
  { code: 2000, name: "ConstraintMut", msg: "A mut constraint was violated" },
  { code: 2001, name: "ConstraintHasOne", msg: "A has one constraint was violated" },
  { code: 2002, name: "ConstraintSigner", msg: "A signer constraint was violated" },
  { code: 2003, name: "ConstraintRaw", msg: "A raw constraint was violated" },
  { code: 2004, name: "ConstraintOwner", msg: "An owner constraint was violated" },
  { code: 2005, name: "ConstraintRentExempt", msg: "A rent exemption constraint was violated" },
  { code: 2006, name: "ConstraintSeeds", msg: "A seeds constraint was violated" },
  { code: 2007, name: "ConstraintExecutable", msg: "An executable constraint was violated" },
  { code: 2008, name: "ConstraintState", msg: "Deprecated Error, feel free to replace with something else" },
  { code: 2009, name: "ConstraintAssociated", msg: "An associated constraint was violated" },
  { code: 2010, name: "ConstraintAssociatedInit", msg: "An associated init constraint was violated" },
  { code: 2011, name: "ConstraintClose", msg: "A close constraint was violated" },
  { code: 2012, name: "ConstraintAddress", msg: "An address constraint was violated" },
  { code: 2013, name: "ConstraintZero", msg: "Expected zero account discriminant" },
  { code: 2014, name: "ConstraintTokenMint", msg: "A token mint constraint was violated" },
  { code: 2015, name: "ConstraintTokenOwner", msg: "A token owner constraint was violated" },
  { code: 2016, name: "ConstraintMintMintAuthority", msg: "A mint mint authority constraint was violated" },
  { code: 2017, name: "ConstraintMintFreezeAuthority", msg: "A mint freeze authority constraint was violated" },
  { code: 2018, name: "ConstraintMintDecimals", msg: "A mint decimals constraint was violated" },
  { code: 2019, name: "ConstraintSpace", msg: "A space constraint was violated" },
  { code: 2020, name: "ConstraintAccountIsNone", msg: "A required account for the constraint is None" },
  { code: 2021, name: "ConstraintTokenTokenProgram", msg: "A token account token program constraint was violated" },
  { code: 2022, name: "ConstraintMintTokenProgram", msg: "A mint token program constraint was violated" },
  { code: 2023, name: "ConstraintAssociatedTokenTokenProgram", msg: "An associated token account token program constraint was violated" },
  { code: 2024, name: "ConstraintMintGroupPointerExtension", msg: "A group pointer extension constraint was violated" },
  { code: 2025, name: "ConstraintMintGroupPointerExtensionAuthority", msg: "A group pointer extension authority constraint was violated" },
  { code: 2026, name: "ConstraintMintGroupPointerExtensionGroupAddress", msg: "A group pointer extension group address constraint was violated" },
  { code: 2027, name: "ConstraintMintGroupMemberPointerExtension", msg: "A group member pointer extension constraint was violated" },
  { code: 2028, name: "ConstraintMintGroupMemberPointerExtensionAuthority", msg: "A group member pointer extension authority constraint was violated" },
  { code: 2029, name: "ConstraintMintGroupMemberPointerExtensionMemberAddress", msg: "A group member pointer extension group address constraint was violated" },
  { code: 2030, name: "ConstraintMintMetadataPointerExtension", msg: "A metadata pointer extension constraint was violated" },
  { code: 2031, name: "ConstraintMintMetadataPointerExtensionAuthority", msg: "A metadata pointer extension authority constraint was violated" },
  { code: 2032, name: "ConstraintMintMetadataPointerExtensionMetadataAddress", msg: "A metadata pointer extension metadata address constraint was violated" },
  { code: 2033, name: "ConstraintMintCloseAuthorityExtension", msg: "A close authority constraint was violated" },
  { code: 2034, name: "ConstraintMintCloseAuthorityExtensionAuthority", msg: "A close authority extension authority constraint was violated" },
  { code: 2035, name: "ConstraintMintPermanentDelegateExtension", msg: "A permanent delegate extension constraint was violated" },
  { code: 2036, name: "ConstraintMintPermanentDelegateExtensionDelegate", msg: "A permanent delegate extension delegate constraint was violated" },
  { code: 2037, name: "ConstraintMintTransferHookExtension", msg: "A transfer hook extension constraint was violated" },
  { code: 2038, name: "ConstraintMintTransferHookExtensionAuthority", msg: "A transfer hook extension authority constraint was violated" },
  { code: 2039, name: "ConstraintMintTransferHookExtensionProgramId", msg: "A transfer hook extension transfer hook program id constraint was violated" },
  {
    code: 2040,
    name: "ConstraintDuplicateMutableAccount",
    msg: "A duplicate mutable account constraint was violated -- two different mutable accounts in the same instruction resolved to the same on-chain address (e.g. the manager and protocol fee-destination wallets are the same account). This is Anchor's own framework-level safety check, not an ssr_protocol-specific error.",
  },
  { code: 2041, name: "AccountAlreadyMigrated", msg: "Account is already migrated" },
  { code: 2042, name: "AccountNotMigrated", msg: "Account must be migrated before exiting" },
  { code: 2500, name: "RequireViolated", msg: "A require expression was violated" },
  { code: 2501, name: "RequireEqViolated", msg: "A require_eq expression was violated" },
  { code: 2502, name: "RequireKeysEqViolated", msg: "A require_keys_eq expression was violated" },
  { code: 2503, name: "RequireNeqViolated", msg: "A require_neq expression was violated" },
  { code: 2504, name: "RequireKeysNeqViolated", msg: "A require_keys_neq expression was violated" },
  { code: 2505, name: "RequireGtViolated", msg: "A require_gt expression was violated" },
  { code: 2506, name: "RequireGteViolated", msg: "A require_gte expression was violated" },
  { code: 3000, name: "AccountDiscriminatorAlreadySet", msg: "The account discriminator was already set on this account" },
  { code: 3001, name: "AccountDiscriminatorNotFound", msg: "No discriminator was found on the account" },
  { code: 3002, name: "AccountDiscriminatorMismatch", msg: "Account discriminator did not match what was expected" },
  { code: 3003, name: "AccountDidNotDeserialize", msg: "Failed to deserialize the account" },
  { code: 3004, name: "AccountDidNotSerialize", msg: "Failed to serialize the account" },
  { code: 3005, name: "AccountNotEnoughKeys", msg: "Not enough account keys given to the instruction" },
  { code: 3006, name: "AccountNotMutable", msg: "The given account is not mutable" },
  { code: 3007, name: "AccountOwnedByWrongProgram", msg: "The given account is owned by a different program than expected" },
  { code: 3008, name: "InvalidProgramId", msg: "Program ID was not as expected" },
  { code: 3009, name: "InvalidProgramExecutable", msg: "Program account is not executable" },
  { code: 3010, name: "AccountNotSigner", msg: "The given account did not sign" },
  { code: 3011, name: "AccountNotSystemOwned", msg: "The given account is not owned by the system program" },
  { code: 3012, name: "AccountNotInitialized", msg: "The program expected this account to be already initialized" },
  { code: 3013, name: "AccountNotProgramData", msg: "The given account is not a program data account" },
  { code: 3014, name: "AccountNotAssociatedTokenAccount", msg: "The given account is not the associated token account" },
  { code: 3015, name: "AccountSysvarMismatch", msg: "The given public key does not match the required sysvar" },
  { code: 3016, name: "AccountReallocExceedsLimit", msg: "The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit" },
  { code: 3017, name: "AccountDuplicateReallocs", msg: "The account was duplicated for more than one reallocation" },
  { code: 4100, name: "DeclaredProgramIdMismatch", msg: "The declared program id does not match the actual program id" },
  { code: 4101, name: "TryingToInitPayerAsProgramAccount", msg: "You cannot/should not initialize the payer account as a program account" },
  { code: 4102, name: "InvalidNumericConversion", msg: "Error during numeric conversion" },
  { code: 5000, name: "Deprecated", msg: "The API being used is deprecated and should no longer be used" },
];

/** Looks up a raw error code against Anchor's own framework error table (not ssr_protocol's custom errors -- see decodeSsrProtocolError in errors.ts for those). Returns null if the code isn't a recognized Anchor framework code either. */
export function decodeAnchorFrameworkError(code: number): AnchorFrameworkError | null {
  return ANCHOR_FRAMEWORK_ERRORS.find((e) => e.code === code) ?? null;
}
