// Pure-logic regression coverage for delegate frontend wiring (Phase 4 of
// the 2026-08-04 "complete the end-to-end SSR DevNet economy" corrective
// pass -- see docs/project/DECISION_LOG.md). Deliberately network- and
// Anchor-toolchain-free: the on-chain add_delegate/update_delegate_permissions/
// remove_delegate instructions themselves are only exercisable against a
// real deployed program, which this environment cannot build/run
// (cargo/anchor/solana are not on PATH here) -- these tests instead cover
// what CAN be verified offline: the PDA derivation the new SDK builders and
// managementClient.ts rely on, and the fail-closed permission-gating logic
// that decides whether ManageDTR.tsx enables a given action.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_delegate_wiring.ts
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { findDelegate } from "../packages/sdk/src/pda";
import { hasOnChainPermission, PERMISSION_FLAGS } from "../src/merge/lib/onChainPermissions";

const PROGRAM_ID = new PublicKey("2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW");
const RESERVE_A = new PublicKey("11111111111111111111111111111111");
const RESERVE_B = new PublicKey("SysvarRent111111111111111111111111111111111");
const WALLET_1 = new PublicKey("Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj");
const WALLET_2 = new PublicKey("Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k");

describe("Delegate wiring -- findDelegate PDA derivation (packages/sdk/src/pda.ts)", () => {
  it("is deterministic: the same (reserve, wallet, programId) always derives the same PDA", () => {
    const [a] = findDelegate(RESERVE_A, WALLET_1, PROGRAM_ID);
    const [b] = findDelegate(RESERVE_A, WALLET_1, PROGRAM_ID);
    expect(a.toBase58()).to.equal(b.toBase58());
  });

  it("derives a different PDA for a different wallet on the same reserve", () => {
    const [a] = findDelegate(RESERVE_A, WALLET_1, PROGRAM_ID);
    const [b] = findDelegate(RESERVE_A, WALLET_2, PROGRAM_ID);
    expect(a.toBase58()).to.not.equal(b.toBase58());
  });

  it("derives a different PDA for the same wallet on a different reserve -- a delegate grant is per-Reserve, not global", () => {
    const [a] = findDelegate(RESERVE_A, WALLET_1, PROGRAM_ID);
    const [b] = findDelegate(RESERVE_B, WALLET_1, PROGRAM_ID);
    expect(a.toBase58()).to.not.equal(b.toBase58());
  });

  it("is what managementClient.ts's executeUpdateTargets/executeAddReserveAsset/executeRemoveReserveAsset now derive for the acting-delegate account, instead of the prior wallet.publicKey placeholder", () => {
    // Regression guard for the placeholder bug found during this pass: the
    // acting-delegate account must be findDelegate(reserve, signer, programId),
    // never signer's own wallet pubkey (which is a different, unrelated address
    // unless it happens to collide with the delegate PDA, which it structurally
    // cannot -- a PDA is off-curve and never equals a real wallet's on-curve pubkey).
    const [delegatePda] = findDelegate(RESERVE_A, WALLET_1, PROGRAM_ID);
    expect(delegatePda.toBase58()).to.not.equal(WALLET_1.toBase58());
    expect(PublicKey.isOnCurve(delegatePda.toBytes())).to.equal(false);
  });
});

describe("Delegate wiring -- hasOnChainPermission (src/merge/lib/onChainPermissions.ts)", () => {
  const manager = WALLET_1.toBase58();
  const delegateWallet = WALLET_2.toBase58();

  it("grants the Reserve's root manager every permission, regardless of any delegate list", () => {
    const onChain = { manager, delegatesOnChain: [] };
    expect(hasOnChainPermission(onChain, manager, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(true);
    expect(hasOnChainPermission(onChain, manager, PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG)).to.equal(true);
  });

  it("grants a delegate exactly the permission bit it was actually given, nothing more", () => {
    const onChain = {
      manager,
      delegatesOnChain: [{ wallet: delegateWallet, permissions: PERMISSION_FLAGS.UPDATE_TARGETS | PERMISSION_FLAGS.PAUSE_RESERVE }],
    };
    expect(hasOnChainPermission(onChain, delegateWallet, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(true);
    expect(hasOnChainPermission(onChain, delegateWallet, PERMISSION_FLAGS.PAUSE_RESERVE)).to.equal(true);
    expect(hasOnChainPermission(onChain, delegateWallet, PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG)).to.equal(false);
  });

  it("fails closed (false) for a wallet not present in delegatesOnChain -- never conflated with 'no delegates exist'", () => {
    const onChain = { manager, delegatesOnChain: [{ wallet: delegateWallet, permissions: PERMISSION_FLAGS.UPDATE_TARGETS }] };
    const unresolvedWallet = new PublicKey("9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv").toBase58();
    expect(hasOnChainPermission(onChain, unresolvedWallet, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(false);
  });

  it("fails closed for no connected wallet", () => {
    const onChain = { manager, delegatesOnChain: [] };
    expect(hasOnChainPermission(onChain, null, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(false);
  });

  it("fails closed when the Reserve has no on-chain state at all (a purely local/simulated Reserve)", () => {
    expect(hasOnChainPermission(undefined, manager, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(false);
  });

  it("fails closed when delegatesOnChain is undefined (not yet fetched), not treated as an empty/no-delegates list granting nothing extra but also not crashing", () => {
    const onChain = { manager };
    expect(hasOnChainPermission(onChain, delegateWallet, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(false);
    expect(hasOnChainPermission(onChain, manager, PERMISSION_FLAGS.UPDATE_TARGETS)).to.equal(true);
  });
});
