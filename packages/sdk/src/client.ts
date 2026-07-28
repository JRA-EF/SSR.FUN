// Thin typed client over the SSR Protocol program. Deliberately minimal for
// v1 -- enough to satisfy the mission's frontend-independence requirement
// (a holder can inspect a Reserve, calculate a mint/redemption, and build +
// send the transaction using only this SDK, no website/indexer required)
// without over-building ahead of real usage. Extend as Gate 10 frontend
// integration surfaces concrete needs.
//
// UNVERIFIED / UNCOMPILED NOTICE: written without a working Anchor/Solana
// toolchain -- see docs/protocol/DEVNET_RUNBOOK.md. `Program<anchor.Idl>` is
// used in place of the real generated IDL type
// (`target/types/ssr_protocol.ts`, produced by `anchor build`), which does
// not exist in this workspace yet.

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import {
  findDelegate,
  findMintAuthority,
  findProtocolConfig,
  findReserve,
  findReserveAsset,
  findReserveTokenMint,
  findReserveVault,
  findVaultAuthority,
} from "./pda";
import { AssetBalance, computeMintRequirements, computeRedemptionEntitlements } from "./calculations";

export interface ReserveAssetView {
  mint: PublicKey;
  vault: PublicKey;
  targetWeightBps: number;
  enabled: boolean;
  orderIndex: number;
  decimals: number;
}

export class SsrClient {
  constructor(
    public readonly program: Program<anchor.Idl>,
    public readonly connection: Connection = program.provider.connection,
  ) {}

  get programId(): PublicKey {
    return this.program.programId;
  }

  /** Derives every account address for a Reserve given only its `reserveId` -- no indexer or website needed. */
  deriveReserveAddresses(reserveId: bigint) {
    const [reserve] = findReserve(reserveId, this.programId);
    const [reserveTokenMint] = findReserveTokenMint(reserve, this.programId);
    const [mintAuthority] = findMintAuthority(reserve, this.programId);
    const [vaultAuthority] = findVaultAuthority(reserve, this.programId);
    return { reserve, reserveTokenMint, mintAuthority, vaultAuthority };
  }

  deriveReserveAssetAddresses(reserve: PublicKey, assetMint: PublicKey) {
    const [reserveAsset] = findReserveAsset(reserve, assetMint, this.programId);
    const [vault] = findReserveVault(reserve, assetMint, this.programId);
    return { reserveAsset, vault };
  }

  deriveDelegateAddress(reserve: PublicKey, wallet: PublicKey) {
    const [delegate] = findDelegate(reserve, wallet, this.programId);
    return delegate;
  }

  /** Fetches the full ordered Reserve Asset list for a Reserve directly from on-chain accounts. */
  async fetchReserveAssets(reserve: PublicKey, assetCount: number): Promise<ReserveAssetView[]> {
    // NOTE: without a generated IDL/account discriminator filter, this
    // fetches by deriving each `(reserve, mint)` PDA -- which requires
    // already knowing the mint list from elsewhere (e.g. Reserve metadata,
    // see docs/protocol/FRONTEND_INTEGRATION.md). A getProgramAccounts
    // memcmp-filtered scan (filtering on the `reserve` field's byte offset
    // within the `ReserveAsset` account layout) is the fully
    // indexer-independent alternative once the IDL/account layout is
    // generated -- left as a follow-up, not implemented blind here.
    void assetCount;
    throw new Error(
      "fetchReserveAssets: requires either a known asset-mint list or a memcmp getProgramAccounts scan against the generated IDL's ReserveAsset layout -- not implemented in this v1 skeleton, see the NOTE in this method.",
    );
  }

  async fetchReserveTokenSupply(reserveTokenMint: PublicKey): Promise<bigint> {
    const account = await getAccount(this.connection, reserveTokenMint as unknown as PublicKey);
    return account.amount as unknown as bigint;
  }

  async fetchVaultBalances(vaults: { mint: PublicKey; vault: PublicKey }[]): Promise<AssetBalance[]> {
    const balances: AssetBalance[] = [];
    for (const v of vaults) {
      const account = await getAccount(this.connection, v.vault);
      balances.push({ mint: v.mint.toBase58(), vaultBalance: account.amount as unknown as bigint });
    }
    return balances;
  }

  /** Convenience wrapper combining live state reads with the pure calculators in ./calculations.ts. */
  async planMint(reserveTokenMint: PublicKey, reserveTokensRequested: bigint, vaults: { mint: PublicKey; vault: PublicKey }[]) {
    const supply = await this.fetchReserveTokenSupply(reserveTokenMint);
    const balances = await this.fetchVaultBalances(vaults);
    return computeMintRequirements(reserveTokensRequested, supply, balances);
  }

  async planRedemption(
    reserveTokenMint: PublicKey,
    reserveTokensToRedeem: bigint,
    redemptionFeeBps: bigint,
    vaults: { mint: PublicKey; vault: PublicKey }[],
  ) {
    const supply = await this.fetchReserveTokenSupply(reserveTokenMint);
    const balances = await this.fetchVaultBalances(vaults);
    return computeRedemptionEntitlements(reserveTokensToRedeem, redemptionFeeBps, supply, balances);
  }

  static deriveProtocolConfig(programId: PublicKey) {
    return findProtocolConfig(programId)[0];
  }
}
