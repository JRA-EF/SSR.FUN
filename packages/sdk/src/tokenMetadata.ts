// Metaplex Token Metadata for Reserve Tokens -- the client half of the
// program's `create_token_metadata` instruction (programs/ssr_protocol/
// src/instructions/create_token_metadata.rs). Every Reserve Token mint
// gets a Metaplex metadata account carrying the Reserve's name and symbol
// on-chain plus a `uri` to the standard-format record (api/<cluster>/
// token-metadata) that carries the description, picture and category, so
// wallets, explorers and DEXes display it like any established token.
//
// Field limits mirror Metaplex's own (name 32, symbol 10, uri 200 BYTES);
// the program re-checks them and fails with a named SsrError first.
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findMintAuthority, findReserveTokenMint } from "./pda";

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Alias used by the management-instruction callers. Same program. */
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = TOKEN_METADATA_PROGRAM_ID;

export const MAX_TOKEN_METADATA_NAME_LEN = 32;
export const MAX_TOKEN_METADATA_SYMBOL_LEN = 10;
export const MAX_TOKEN_METADATA_URI_LEN = 200;

/** `["metadata", program, mint]` under the Token Metadata program -- the account every wallet/DEX reads. */
export function findTokenMetadata(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], TOKEN_METADATA_PROGRAM_ID);
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncates `s` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (utf8ByteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/** The on-chain token name for a Reserve: its name, whitespace-collapsed, cut to Metaplex's 32-byte limit. */
export function fitTokenMetadataName(reserveName: string): string {
  return truncateToUtf8Bytes(reserveName.replace(/\s+/g, " ").trim(), MAX_TOKEN_METADATA_NAME_LEN).trim();
}

/** The on-chain token symbol for a Reserve: its ticker with internal whitespace removed, cut to Metaplex's 10-byte limit. */
export function fitTokenMetadataSymbol(ticker: string): string {
  return truncateToUtf8Bytes(ticker.replace(/\s+/g, ""), MAX_TOKEN_METADATA_SYMBOL_LEN);
}

export interface TokenMetadataFields {
  name: string;
  symbol: string;
  uri: string;
}

/** Throws a plain-language error for anything the program would reject. */
export function validateTokenMetadataFields(fields: TokenMetadataFields): void {
  const { name, symbol, uri } = fields;
  if (!name.trim()) throw new Error("The token name is empty.");
  if (utf8ByteLength(name) > MAX_TOKEN_METADATA_NAME_LEN) {
    throw new Error(`The token name is longer than ${MAX_TOKEN_METADATA_NAME_LEN} bytes -- shorten the Reserve name.`);
  }
  if (!symbol.trim()) throw new Error("The token symbol is empty.");
  if (utf8ByteLength(symbol) > MAX_TOKEN_METADATA_SYMBOL_LEN) {
    throw new Error(`The token symbol is longer than ${MAX_TOKEN_METADATA_SYMBOL_LEN} bytes -- shorten the ticker.`);
  }
  if (!/^https:\/\//i.test(uri)) throw new Error("The token metadata link must be a permanent HTTPS URL.");
  if (utf8ByteLength(uri) > MAX_TOKEN_METADATA_URI_LEN) {
    throw new Error(`The token metadata link is longer than ${MAX_TOKEN_METADATA_URI_LEN} bytes.`);
  }
}

export const CANONICAL_MAINNET_ORIGIN = "https://ssr.fun";

/**
 * The host a token-metadata URI should use. Mainnet Reserves' own metadata
 * URIs carry whichever app host was live at launch (several are the old,
 * now-gated domain), so anything written on-chain for wallets/DEXes to read
 * is pinned to the canonical public host instead; DevNet keeps the current
 * app origin (whatever test deployment is in use).
 */
export function tokenMetadataOriginFor(cluster: "devnet" | "mainnet", currentOrigin: string | null | undefined): string | undefined {
  if (cluster === "mainnet") return CANONICAL_MAINNET_ORIGIN;
  return currentOrigin || undefined;
}

/**
 * Derives the standard-format metadata URL from a Reserve's own on-chain
 * `metadata_uri` (`https://<host>/api/<cluster>/reserve-metadata?id=<id>`).
 * The token record is served by the sibling `token-metadata` endpoint from
 * the SAME stored payload (same id), so nothing is uploaded twice; `reserve`
 * lets that endpoint resolve the Reserve's CURRENT picture pointer (a
 * Manager can change the picture without republishing the payload).
 *
 * Returns null for any other shape (e.g. the original inline `data:` URIs of
 * the committed DevNet fixtures): there is no stored record to point at.
 */
export function tokenMetadataUriFromReserveMetadataUri(reserveMetadataUri: string, reserve: PublicKey | string, originOverride?: string): string | null {
  let u: URL;
  try {
    u = new URL(reserveMetadataUri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const m = u.pathname.match(/^\/api\/(devnet|mainnet)\/reserve-metadata$/);
  const id = u.searchParams.get("id");
  if (!m || !id || !/^[0-9a-f]{16}$/i.test(id)) return null;
  const reserveStr = typeof reserve === "string" ? reserve : reserve.toBase58();
  const origin = (originOverride ?? u.origin).replace(/[/]+$/, "");
  return `${origin}/api/${m[1]}/token-metadata?id=${id}&reserve=${reserveStr}`;
}

/**
 * Publishes Metaplex metadata for a Reserve Token mint. The program signs the
 * Metaplex CPI with the mint-authority PDA, so this is the ONLY way such a
 * mint can ever get metadata -- no off-chain tool can do it.
 *
 * Idempotent on-chain: a mint that already has a metadata account is left
 * untouched, so this doubles as the repair path for Reserves created before
 * the instruction existed.
 *
 * `uri` must be a permanent HTTPS metadata URL, and `name`/`symbol` are
 * capped on-chain at 32 and 10 bytes -- pass them through
 * `fitTokenMetadataName` / `fitTokenMetadataSymbol` first.
 */
export async function buildCreateTokenMetadataInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  payer: PublicKey,
  delegate: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): Promise<TransactionInstruction> {
  const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const [metadata] = findTokenMetadata(reserveTokenMint);
  return program.methods
    .createTokenMetadata(name, symbol, uri)
    .accounts({
      reserve,
      reserveTokenMint,
      mintAuthority,
      metadata,
      delegate,
      payer,
      metadataProgram: TOKEN_METADATA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .instruction();
}

/**
 * Field-validating wrapper over `buildCreateTokenMetadataInstruction`, kept
 * for the callers that pass a `TokenMetadataFields` record.
 *
 * IMPORTANT: despite the "set" in the name, the deployed program's
 * `create_token_metadata` only ever CREATES. A mint whose metadata account
 * already exists is left exactly as it is; this cannot rewrite a name, symbol
 * or uri that is already on-chain. The replacing variant
 * (`set_reserve_token_metadata`) was written but never deployed, so calling
 * it would fail against the live program.
 */
export async function buildSetReserveTokenMetadataInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  _reserveTokenMint: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  fields: TokenMetadataFields,
): Promise<TransactionInstruction> {
  validateTokenMetadataFields(fields);
  return buildCreateTokenMetadataInstruction(program, programId, reserve, signer, delegate, fields.name, fields.symbol, fields.uri);
}

export interface OnChainTokenMetadata {
  address: string;
  mint: string;
  updateAuthority: string;
  name: string;
  symbol: string;
  uri: string;
  isMutable: boolean;
}

/**
 * Decodes the head of a Metaplex `Metadata` account (key, update authority,
 * mint, DataV2 strings, creators, primary-sale flag, is_mutable). Strings
 * are Borsh-prefixed and null-padded to their max length by Metaplex, so the
 * padding is stripped. Everything after `is_mutable` is ignored.
 */
export function decodeTokenMetadataAccount(address: PublicKey, data: Buffer | Uint8Array): OnChainTokenMetadata {
  const d = Buffer.from(data);
  let o = 0;
  const key = d.readUInt8(o);
  o += 1;
  if (key !== 4) throw new Error(`Not a Metaplex Metadata account (key ${key}).`);
  const updateAuthority = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const mint = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const readString = (): string => {
    const len = d.readUInt32LE(o);
    o += 4;
    const s = d.subarray(o, o + len).toString("utf8");
    o += len;
    return s.replace(/\0+$/g, "");
  };
  const name = readString();
  const symbol = readString();
  const uri = readString();
  o += 2; // seller_fee_basis_points
  const hasCreators = d.readUInt8(o);
  o += 1;
  if (hasCreators === 1) {
    const n = d.readUInt32LE(o);
    o += 4 + n * (32 + 1 + 1);
  }
  o += 1; // primary_sale_happened
  const isMutable = d.readUInt8(o) === 1;
  return { address: address.toBase58(), mint, updateAuthority, name, symbol, uri, isMutable };
}

/** The mint's Metaplex metadata, or null when no metadata account exists yet. */
export async function fetchReserveTokenMetadata(connection: Connection, reserveTokenMint: PublicKey): Promise<OnChainTokenMetadata | null> {
  const [metadata] = findTokenMetadata(reserveTokenMint);
  const info = await connection.getAccountInfo(metadata, "confirmed");
  if (!info || info.data.length === 0) return null;
  return decodeTokenMetadataAccount(metadata, info.data);
}
