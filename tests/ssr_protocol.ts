// Anchor integration test suite for the SSR Protocol program.
//
// UNVERIFIED / UNCOMPILED NOTICE: written without a working Anchor/Solana
// toolchain in this environment (see docs/protocol/DEVNET_RUNBOOK.md). The
// IDL-typed `Program<SsrProtocol>` type from `anchor build`'s generated
// `target/types/ssr_protocol.ts` does not exist yet -- this file types the
// program as `Program<anchor.Idl>` so it is at least self-consistent without
// that generated artifact; swap in the real generated type once `anchor
// build` has run. Run via `anchor test` (or `npm run test:program` against
// an already-running local validator) once the toolchain gap is closed.
//
// Covers Gate 4 (core accounting) and Gate 5 (management layer) happy paths
// plus a representative slice of the adversarial scenarios required by the
// mission's Test Plan section -- see docs/protocol/TEST_PLAN.md for the full
// planned matrix (this file does not yet cover all of it).

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  findProtocolConfig,
  findReserve,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  findReserveTokenMint,
  findMintAuthority,
  findDelegate,
} from "./util/pda";

describe("ssr_protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SsrProtocol as Program<anchor.Idl>;
  const programId = program.programId;
  const connection = provider.connection;

  const protocolAuthority = provider.wallet as anchor.Wallet;
  let secondProtocolAdmin: Keypair;
  let reserveManager: Keypair;
  let secondHolder: Keypair;
  let assetMintA: PublicKey; // e.g. "USDC"-like, 6 decimals
  let assetMintB: PublicKey; // e.g. "SOL"-like, 9 decimals

  const [protocolConfig] = findProtocolConfig(programId);

  // The public DevNet airdrop faucet is rate-limited/exhausted for this
  // environment (confirmed: 429 "reached your airdrop limit today" from
  // both the CLI and web3.js). Fund fresh test keypairs by direct transfer
  // from the already-funded ANCHOR_WALLET instead of requestAirdrop.
  async function fundWallet(pubkey: PublicKey, lamports: number): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: protocolAuthority.publicKey,
        toPubkey: pubkey,
        lamports,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [protocolAuthority.payer]);
  }

  before(async () => {
    secondProtocolAdmin = Keypair.generate();
    reserveManager = Keypair.generate();
    secondHolder = Keypair.generate();
    for (const kp of [secondProtocolAdmin, reserveManager, secondHolder]) {
      await fundWallet(kp.publicKey, 0.3 * LAMPORTS_PER_SOL);
    }

    assetMintA = await createMint(connection, reserveManager, reserveManager.publicKey, null, 6);
    assetMintB = await createMint(connection, reserveManager, reserveManager.publicKey, null, 9);
  });

  it("initializes the protocol singleton", async () => {
    // protocolConfig is a true global singleton PDA (one per deployed program),
    // so against a persistent network like DevNet it can only ever be
    // initialized once for the program's lifetime -- unlike a local validator,
    // which resets state on every run. If a prior run already initialized it,
    // treat that as the expected steady state and just verify its contents.
    const existing = await (program.account as any).protocolConfig.fetchNullable(protocolConfig);
    if (existing === null) {
      await program.methods
        .initializeProtocol(secondProtocolAdmin.publicKey, 12, 0, protocolAuthority.publicKey)
        .accounts({
          protocolConfig,
          authority: protocolAuthority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const config = await (program.account as any).protocolConfig.fetch(protocolConfig);
    expect(config.maxReserveAssets).to.equal(12);
    expect(config.paused).to.equal(false);
    expect(config.authority.toBase58()).to.equal(protocolAuthority.publicKey.toBase58());
    expect(config.admin2.toBase58()).to.equal(secondProtocolAdmin.publicKey.toBase58());
  });

  it("rejects re-initializing the protocol singleton", async () => {
    // The protocolConfig PDA already exists from the previous test -- Anchor's
    // `init` constraint must fail with an account-already-in-use error rather
    // than silently overwriting the existing config.
    let threw = false;
    try {
      await program.methods
        .initializeProtocol(secondProtocolAdmin.publicKey, 12, 0, protocolAuthority.publicKey)
        .accounts({
          protocolConfig,
          authority: protocolAuthority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      threw = true; // expected: Anchor's init constraint rejects an already-initialized account
    }
    expect(threw).to.equal(true);
  });

  describe("Protocol Admin authority model (two independent admins)", () => {
    it("allows the primary admin (authority) to update the protocol config", async () => {
      const before = await (program.account as any).protocolConfig.fetch(protocolConfig);
      const newDestination = Keypair.generate().publicKey;
      await program.methods
        .updateProtocolConfig(newDestination, before.defaultProtocolFeeBps)
        .accounts({ protocolConfig, authority: protocolAuthority.publicKey })
        .rpc();
      const after = await (program.account as any).protocolConfig.fetch(protocolConfig);
      expect(after.defaultProtocolFeeDestination.toBase58()).to.equal(newDestination.toBase58());
    });

    it("allows the second admin (admin_2) to update the protocol config independently", async () => {
      const before = await (program.account as any).protocolConfig.fetch(protocolConfig);
      const newDestination = Keypair.generate().publicKey;
      await program.methods
        .updateProtocolConfig(newDestination, before.defaultProtocolFeeBps)
        .accounts({ protocolConfig, authority: secondProtocolAdmin.publicKey })
        .signers([secondProtocolAdmin])
        .rpc();
      const after = await (program.account as any).protocolConfig.fetch(protocolConfig);
      expect(after.defaultProtocolFeeDestination.toBase58()).to.equal(newDestination.toBase58());
    });

    it("rejects update_protocol_config from a wallet that is neither admin", async () => {
      const stranger = Keypair.generate();
      await fundWallet(stranger.publicKey, 0.05 * LAMPORTS_PER_SOL);
      const before = await (program.account as any).protocolConfig.fetch(protocolConfig);
      let threw = false;
      try {
        await program.methods
          .updateProtocolConfig(Keypair.generate().publicKey, before.defaultProtocolFeeBps)
          .accounts({ protocolConfig, authority: stranger.publicKey })
          .signers([stranger])
          .rpc();
      } catch (e) {
        threw = true; // expected: NotProtocolAuthority
      }
      expect(threw).to.equal(true);
    });

    it("allows either admin to independently toggle the global pause, and blocks a non-admin", async () => {
      const stranger = Keypair.generate();
      await fundWallet(stranger.publicKey, 0.05 * LAMPORTS_PER_SOL);

      let threw = false;
      try {
        await program.methods
          .setProtocolPaused(true)
          .accounts({ protocolConfig, authority: stranger.publicKey })
          .signers([stranger])
          .rpc();
      } catch (e) {
        threw = true; // expected: NotProtocolAuthority
      }
      expect(threw).to.equal(true);

      await program.methods
        .setProtocolPaused(true)
        .accounts({ protocolConfig, authority: secondProtocolAdmin.publicKey })
        .signers([secondProtocolAdmin])
        .rpc();
      let config = await (program.account as any).protocolConfig.fetch(protocolConfig);
      expect(config.paused).to.equal(true);

      await program.methods
        .setProtocolPaused(false)
        .accounts({ protocolConfig, authority: protocolAuthority.publicKey })
        .rpc();
      config = await (program.account as any).protocolConfig.fetch(protocolConfig);
      expect(config.paused).to.equal(false);
    });
  });

  describe("a two-asset Reserve: create -> init assets -> seed -> mint -> redeem", () => {
    let reserve: PublicKey;
    let reserveId: bigint;
    let reserveTokenMint: PublicKey;
    let mintAuthority: PublicKey;
    let vaultAuthority: PublicKey;
    let reserveAssetA: PublicKey;
    let reserveAssetB: PublicKey;
    let vaultA: PublicKey;
    let vaultB: PublicKey;

    it("creates a Reserve", async () => {
      const configBefore = await (program.account as any).protocolConfig.fetch(protocolConfig);
      reserveId = BigInt(configBefore.reserveCount.toString());
      [reserve] = findReserve(reserveId, programId);
      [reserveTokenMint] = findReserveTokenMint(reserve, programId);
      [mintAuthority] = findMintAuthority(reserve, programId);
      [vaultAuthority] = findVaultAuthority(reserve, programId);

      await program.methods
        .createReserve(
          "https://example.invalid/ssr/metadata/placeholder.json",
          50, // mint_fee_bps, matches DEC-0013 provisional default
          0, // redemption_fee_bps
          100, // annual_tvl_fee_bps
          // DEC-0094: manager_fee_share_bps/protocol_fee_share_bps removed --
          // the Protocol/Manager split is now always derived on-chain from
          // mint_fee_bps/annual_tvl_fee_bps alone.
          reserveManager.publicKey, // fee_destination
        )
        .accounts({
          protocolConfig,
          reserve,
          mintAuthority,
          reserveTokenMint,
          manager: reserveManager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([reserveManager])
        .rpc();

      const reserveAccount = await (program.account as any).reserve.fetch(reserve);
      expect(reserveAccount.manager.toBase58()).to.equal(reserveManager.publicKey.toBase58());
      expect(reserveAccount.assetCount).to.equal(0);
    });

    it("registers two Reserve Assets", async () => {
      [reserveAssetA] = findReserveAsset(reserve, assetMintA, programId);
      [vaultA] = findReserveVault(reserve, assetMintA, programId);
      [reserveAssetB] = findReserveAsset(reserve, assetMintB, programId);
      [vaultB] = findReserveVault(reserve, assetMintB, programId);

      await program.methods
        .initializeReserveAsset(6000) // 60%
        .accounts({
          protocolConfig,
          reserve,
          reserveAsset: reserveAssetA,
          assetMint: assetMintA,
          vault: vaultA,
          vaultAuthority,
          manager: reserveManager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([reserveManager])
        .rpc();

      await program.methods
        .initializeReserveAsset(4000) // 40% -- totals exactly 10000 bps
        .accounts({
          protocolConfig,
          reserve,
          reserveAsset: reserveAssetB,
          assetMint: assetMintB,
          vault: vaultB,
          vaultAuthority,
          manager: reserveManager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([reserveManager])
        .rpc();

      const reserveAccount = await (program.account as any).reserve.fetch(reserve);
      expect(reserveAccount.assetCount).to.equal(2);
      expect(reserveAccount.totalTargetWeightBps).to.equal(10000);
    });

    it("rejects registering a duplicate asset mint", async () => {
      const [dupReserveAsset] = findReserveAsset(reserve, assetMintA, programId);
      const [dupVault] = findReserveVault(reserve, assetMintA, programId);
      let threw = false;
      try {
        await program.methods
          .initializeReserveAsset(100)
          .accounts({
            protocolConfig,
            reserve,
            reserveAsset: dupReserveAsset,
            assetMint: assetMintA,
            vault: dupVault,
            vaultAuthority,
            manager: reserveManager.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([reserveManager])
          .rpc();
      } catch (e) {
        threw = true; // expected: account already in use (init on an existing PDA)
      }
      expect(threw).to.equal(true);
    });

    it("seeds the Reserve with an initial in-kind deposit", async () => {
      const managerAtaA = await getOrCreateAssociatedTokenAccount(connection, reserveManager, assetMintA, reserveManager.publicKey);
      const managerAtaB = await getOrCreateAssociatedTokenAccount(connection, reserveManager, assetMintB, reserveManager.publicKey);
      await mintTo(connection, reserveManager, assetMintA, managerAtaA.address, reserveManager, 1_000_000_000);
      await mintTo(connection, reserveManager, assetMintB, managerAtaB.address, reserveManager, 1_000_000_000);

      const managerReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        reserveManager,
        reserveTokenMint,
        reserveManager.publicKey,
      );

      await program.methods
        .seedReserve([new BN(600_000), new BN(400_000)], new BN(1_000_000))
        .accounts({
          protocolConfig,
          reserve,
          reserveTokenMint,
          mintAuthority,
          managerReserveTokenAccount: managerReserveTokenAccount.address,
          manager: reserveManager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: reserveAssetA, isWritable: false, isSigner: false },
          { pubkey: vaultA, isWritable: true, isSigner: false },
          { pubkey: managerAtaA.address, isWritable: true, isSigner: false },
          { pubkey: assetMintA, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: reserveAssetB, isWritable: false, isSigner: false },
          { pubkey: vaultB, isWritable: true, isSigner: false },
          { pubkey: managerAtaB.address, isWritable: true, isSigner: false },
          { pubkey: assetMintB, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ])
        .signers([reserveManager])
        .rpc();

      const reserveAccount = await (program.account as any).reserve.fetch(reserve);
      expect(reserveAccount.status).to.have.property("active");

      const vaultAAccount = await getAccount(connection, vaultA);
      const vaultBAccount = await getAccount(connection, vaultB);
      expect(vaultAAccount.amount.toString()).to.equal("600000");
      expect(vaultBAccount.amount.toString()).to.equal("400000");
      const managerReserveTokenAccountAfter = await getAccount(connection, managerReserveTokenAccount.address);
      expect(managerReserveTokenAccountAfter.amount.toString()).to.not.equal("0");
    });

    it("rejects seeding a Reserve that's already Active", async () => {
      const managerAtaA = await getOrCreateAssociatedTokenAccount(connection, reserveManager, assetMintA, reserveManager.publicKey);
      const managerAtaB = await getOrCreateAssociatedTokenAccount(connection, reserveManager, assetMintB, reserveManager.publicKey);
      const managerReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        reserveManager,
        reserveTokenMint,
        reserveManager.publicKey,
      );
      let threw = false;
      try {
        await program.methods
          .seedReserve([new BN(1), new BN(1)], new BN(1))
          .accounts({
            protocolConfig,
            reserve,
            reserveTokenMint,
            mintAuthority,
            managerReserveTokenAccount: managerReserveTokenAccount.address,
            manager: reserveManager.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: reserveAssetA, isWritable: false, isSigner: false },
            { pubkey: vaultA, isWritable: true, isSigner: false },
            { pubkey: managerAtaA.address, isWritable: true, isSigner: false },
            { pubkey: assetMintA, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
            { pubkey: reserveAssetB, isWritable: false, isSigner: false },
            { pubkey: vaultB, isWritable: true, isSigner: false },
            { pubkey: managerAtaB.address, isWritable: true, isSigner: false },
            { pubkey: assetMintB, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ])
          .signers([reserveManager])
          .rpc();
      } catch (e) {
        threw = true; // expected: UnexpectedReserveStatus
      }
      expect(threw).to.equal(true);
    });

    it("lets a second holder mint proportionally", async () => {
      const holderAtaA = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintA, secondHolder.publicKey);
      const holderAtaB = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintB, secondHolder.publicKey);
      await mintTo(connection, reserveManager, assetMintA, holderAtaA.address, reserveManager, 1_000_000_000);
      await mintTo(connection, reserveManager, assetMintB, holderAtaB.address, reserveManager, 1_000_000_000);

      const holderReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        secondHolder,
        reserveTokenMint,
        secondHolder.publicKey,
      );

      const requested = new BN(100_000);
      // Generous max-input bounds for this test -- a real client computes
      // these from live vault/supply state via the SDK (Gate 6).
      const maxAssetAmounts = [new BN(1_000_000), new BN(1_000_000)];

      await program.methods
        .mintReserveTokensInKind(requested, new BN(1), maxAssetAmounts)
        .accounts({
          protocolConfig,
          reserve,
          reserveTokenMint,
          mintAuthority,
          depositorReserveTokenAccount: holderReserveTokenAccount.address,
          depositor: secondHolder.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: reserveAssetA, isWritable: false, isSigner: false },
          { pubkey: vaultA, isWritable: true, isSigner: false },
          { pubkey: holderAtaA.address, isWritable: true, isSigner: false },
          { pubkey: assetMintA, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: reserveAssetB, isWritable: false, isSigner: false },
          { pubkey: vaultB, isWritable: true, isSigner: false },
          { pubkey: holderAtaB.address, isWritable: true, isSigner: false },
          { pubkey: assetMintB, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ])
        .signers([secondHolder])
        .rpc();

      const holderAccount = await getAccount(connection, holderReserveTokenAccount.address);
      expect(Number(holderAccount.amount)).to.be.greaterThan(0);
    });

    it("lets the second holder redeem proportionally", async () => {
      const holderAtaA = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintA, secondHolder.publicKey);
      const holderAtaB = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintB, secondHolder.publicKey);
      const holderReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        secondHolder,
        reserveTokenMint,
        secondHolder.publicKey,
      );

      const balanceBefore = (await getAccount(connection, holderReserveTokenAccount.address)).amount;
      const redeemAmount = new BN(balanceBefore.toString()).div(new BN(2));

      await program.methods
        .redeemReserveTokensInKind(redeemAmount, [new BN(0), new BN(0)])
        .accounts({
          reserve,
          reserveTokenMint,
          vaultAuthority,
          redeemerReserveTokenAccount: holderReserveTokenAccount.address,
          redeemer: secondHolder.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: reserveAssetA, isWritable: false, isSigner: false },
          { pubkey: vaultA, isWritable: true, isSigner: false },
          { pubkey: holderAtaA.address, isWritable: true, isSigner: false },
          { pubkey: assetMintA, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: reserveAssetB, isWritable: false, isSigner: false },
          { pubkey: vaultB, isWritable: true, isSigner: false },
          { pubkey: holderAtaB.address, isWritable: true, isSigner: false },
          { pubkey: assetMintB, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ])
        .signers([secondHolder])
        .rpc();

      const balanceAfter = (await getAccount(connection, holderReserveTokenAccount.address)).amount;
      expect(Number(balanceAfter)).to.be.lessThan(Number(balanceBefore));
    });

    it("rejects redeeming more Reserve Tokens than the caller's balance", async () => {
      const holderAtaA = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintA, secondHolder.publicKey);
      const holderAtaB = await getOrCreateAssociatedTokenAccount(connection, secondHolder, assetMintB, secondHolder.publicKey);
      const holderReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        secondHolder,
        reserveTokenMint,
        secondHolder.publicKey,
      );
      const balance = (await getAccount(connection, holderReserveTokenAccount.address)).amount;
      const excessAmount = new BN(balance.toString()).add(new BN(1_000_000));

      let threw = false;
      try {
        await program.methods
          .redeemReserveTokensInKind(excessAmount, [new BN(0), new BN(0)])
          .accounts({
            reserve,
            reserveTokenMint,
            vaultAuthority,
            redeemerReserveTokenAccount: holderReserveTokenAccount.address,
            redeemer: secondHolder.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts([
            { pubkey: reserveAssetA, isWritable: false, isSigner: false },
            { pubkey: vaultA, isWritable: true, isSigner: false },
            { pubkey: holderAtaA.address, isWritable: true, isSigner: false },
            { pubkey: assetMintA, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
            { pubkey: reserveAssetB, isWritable: false, isSigner: false },
            { pubkey: vaultB, isWritable: true, isSigner: false },
            { pubkey: holderAtaB.address, isWritable: true, isSigner: false },
            { pubkey: assetMintB, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ])
          .signers([secondHolder])
          .rpc();
      } catch (e) {
        threw = true; // expected: RedemptionExceedsEntitlement (or the SPL Token program's own insufficient-balance error on burn)
      }
      expect(threw).to.equal(true);
    });

    it("rejects an unauthorized pause attempt (random wallet, not manager or delegate)", async () => {
      const stranger = Keypair.generate();
      await fundWallet(stranger.publicKey, 0.05 * LAMPORTS_PER_SOL);
      const [strangerDelegate] = findDelegate(reserve, stranger.publicKey, programId);

      let threw = false;
      try {
        await program.methods
          .pauseReserve()
          .accounts({ reserve, delegate: strangerDelegate, signer: stranger.publicKey })
          .signers([stranger])
          .rpc();
      } catch (e) {
        threw = true; // expected: DelegateNotFound / permission denied
      }
      expect(threw).to.equal(true);
    });

    it("lets the manager pause and unpause the Reserve", async () => {
      const [managerDelegate] = findDelegate(reserve, reserveManager.publicKey, programId);

      await program.methods
        .pauseReserve()
        .accounts({ reserve, delegate: managerDelegate, signer: reserveManager.publicKey })
        .signers([reserveManager])
        .rpc();
      let reserveAccount = await (program.account as any).reserve.fetch(reserve);
      expect(reserveAccount.status).to.have.property("paused");

      await program.methods
        .unpauseReserve()
        .accounts({ reserve, delegate: managerDelegate, signer: reserveManager.publicKey })
        .signers([reserveManager])
        .rpc();
      reserveAccount = await (program.account as any).reserve.fetch(reserve);
      expect(reserveAccount.status).to.have.property("active");
    });

    it("adds a restricted delegate with only UPDATE_TARGETS and confirms scope", async () => {
      const delegateWallet = Keypair.generate();
      await fundWallet(delegateWallet.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [delegateAccount] = findDelegate(reserve, delegateWallet.publicKey, programId);
      const UPDATE_TARGETS_FLAG = 1 << 1;

      await program.methods
        .addDelegate(delegateWallet.publicKey, UPDATE_TARGETS_FLAG, true)
        .accounts({
          reserve,
          delegateAccount,
          actingDelegate: programId, // manager path: not deserialized
          signer: reserveManager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([reserveManager])
        .rpc();

      // Delegate CAN update targets.
      await program.methods
        .updateTargets([6000, 4000])
        .accounts({ reserve, delegate: delegateAccount, signer: delegateWallet.publicKey })
        .remainingAccounts([
          { pubkey: reserveAssetA, isWritable: true, isSigner: false },
          { pubkey: reserveAssetB, isWritable: true, isSigner: false },
        ])
        .signers([delegateWallet])
        .rpc();

      // Delegate CANNOT pause (no PAUSE_RESERVE flag) -- privilege boundary check.
      let threw = false;
      try {
        await program.methods
          .pauseReserve()
          .accounts({ reserve, delegate: delegateAccount, signer: delegateWallet.publicKey })
          .signers([delegateWallet])
          .rpc();
      } catch (e) {
        threw = true; // expected: DelegatePermissionDenied
      }
      expect(threw).to.equal(true);
    });
  });

  describe("cross-Reserve isolation", () => {
    // The single most important test in this suite (see docs/protocol/TEST_PLAN.md):
    // proves a vault from a DIFFERENT Reserve cannot be substituted into an
    // instruction operating on this Reserve, because instructions/common.rs's
    // load_asset_legs re-derives the expected vault PDA from THIS Reserve's own
    // key, not just from the asset mint -- Reserve B's vault for asset mint X
    // was created under a completely different PDA than Reserve A expects for
    // the same mint X, so the seeds constraint fails before any transfer runs.
    it("rejects an instruction that supplies a vault belonging to a different Reserve", async () => {
      async function createMinimalSeededReserve() {
        const configBefore = await (program.account as any).protocolConfig.fetch(protocolConfig);
        const reserveId = BigInt(configBefore.reserveCount.toString());
        const [reserve] = findReserve(reserveId, programId);
        const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
        const [mintAuthority] = findMintAuthority(reserve, programId);
        const [reserveAsset] = findReserveAsset(reserve, assetMintA, programId);
        const [vault] = findReserveVault(reserve, assetMintA, programId);
        const [vaultAuthority] = findVaultAuthority(reserve, programId);

        await program.methods
          .createReserve("https://example.invalid/ssr/x.json", 0, 0, 0, 5000, 5000, reserveManager.publicKey)
          .accounts({
            protocolConfig,
            reserve,
            mintAuthority,
            reserveTokenMint,
            manager: reserveManager.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([reserveManager])
          .rpc();

        await program.methods
          .initializeReserveAsset(10000)
          .accounts({
            protocolConfig,
            reserve,
            reserveAsset,
            assetMint: assetMintA,
            vault,
            vaultAuthority,
            manager: reserveManager.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([reserveManager])
          .rpc();

        const managerAta = await getOrCreateAssociatedTokenAccount(connection, reserveManager, assetMintA, reserveManager.publicKey);
        await mintTo(connection, reserveManager, assetMintA, managerAta.address, reserveManager, 1_000_000);
        const managerReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
          connection,
          reserveManager,
          reserveTokenMint,
          reserveManager.publicKey,
        );

        await program.methods
          .seedReserve([new BN(10_000)], new BN(10_000))
          .accounts({
            protocolConfig,
            reserve,
            reserveTokenMint,
            mintAuthority,
            managerReserveTokenAccount: managerReserveTokenAccount.address,
            manager: reserveManager.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: reserveAsset, isWritable: false, isSigner: false },
            { pubkey: vault, isWritable: true, isSigner: false },
            { pubkey: managerAta.address, isWritable: true, isSigner: false },
            { pubkey: assetMintA, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ])
          .signers([reserveManager])
          .rpc();

        return { reserve, reserveTokenMint, mintAuthority, reserveAsset, vault };
      }

      const reserveOne = await createMinimalSeededReserve();
      const reserveTwo = await createMinimalSeededReserve();
      expect(reserveOne.reserve.toBase58()).to.not.equal(reserveTwo.reserve.toBase58());
      expect(reserveOne.vault.toBase58()).to.not.equal(reserveTwo.vault.toBase58());

      // Attempt: mint against reserveOne, but substitute reserveTwo's
      // reserve_asset/vault (for the SAME underlying asset mint) as the
      // remaining accounts. Must fail -- reserveTwo's vault was created under
      // seeds = [RESERVE_VAULT_SEED, reserveTwo.key(), assetMintA], not
      // reserveOne.key(), so the PDA re-derivation inside load_asset_legs
      // (keyed on reserveOne) can never match it.
      const holder = Keypair.generate();
      await fundWallet(holder.publicKey, 0.05 * LAMPORTS_PER_SOL);
      const holderAta = await getOrCreateAssociatedTokenAccount(connection, holder, assetMintA, holder.publicKey);
      await mintTo(connection, reserveManager, assetMintA, holderAta.address, reserveManager, 1_000_000);
      const holderReserveTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        holder,
        reserveOne.reserveTokenMint,
        holder.publicKey,
      );

      let threw = false;
      try {
        await program.methods
          .mintReserveTokensInKind(new BN(100), new BN(1), [new BN(1_000_000)])
          .accounts({
            protocolConfig,
            reserve: reserveOne.reserve, // operating on Reserve ONE
            reserveTokenMint: reserveOne.reserveTokenMint,
            mintAuthority: reserveOne.mintAuthority,
            depositorReserveTokenAccount: holderReserveTokenAccount.address,
            depositor: holder.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            // Substituted: Reserve TWO's asset/vault, not Reserve ONE's.
            { pubkey: reserveTwo.reserveAsset, isWritable: false, isSigner: false },
            { pubkey: reserveTwo.vault, isWritable: true, isSigner: false },
            { pubkey: holderAta.address, isWritable: true, isSigner: false },
            { pubkey: assetMintA, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ])
          .signers([holder])
          .rpc();
      } catch (e) {
        threw = true; // expected: ReserveAssetMismatch / InvalidReserveVault
      }
      expect(threw).to.equal(true, "cross-Reserve vault substitution must be rejected, not silently accepted");
    });
  });
});
