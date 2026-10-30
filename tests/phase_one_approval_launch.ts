// One-approval launch (src/merge/lib/oneApprovalLaunch.ts): the funding swaps,
// create-and-register batches and the Reserve's lookup table are signed in ONE
// wallet prompt, instead of one prompt per step (~16 for a 10-asset launch).
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import {
  ALT_EXTEND_CHUNK,
  buildLaunchLookupTableTxs,
  compileLaunchTx,
  createLaunchBatchSigner,
  fitsOneTransaction,
  type PrebuiltLaunchTx,
} from "../src/merge/lib/oneApprovalLaunch";

const owner = Keypair.generate().publicKey;
const BH1 = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";
const BH2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function dummyTx(bh = BH1): VersionedTransaction {
  return compileLaunchTx(owner, bh, [SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 })], 1000);
}
function prebuilt(kind: PrebuiltLaunchTx["kind"]): PrebuiltLaunchTx {
  const ix = SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  return { kind, tx: compileLaunchTx(owner, BH1, [ix], 1000), lastValidBlockHeight: 100, rebuild: (bh) => compileLaunchTx(owner, bh, [ix], 1000) };
}
function fakeWallet() {
  const calls: number[] = [];
  return {
    calls,
    wallet: {
      publicKey: owner,
      connected: true,
      signTransaction: async (t: VersionedTransaction) => t,
      signAllTransactions: async (ts: VersionedTransaction[]) => {
        calls.push(ts.length);
        return ts;
      },
    } as any,
  };
}

describe("one-approval launch: the batch signer", () => {
  it("signs the first swaps AND every pre-built launch transaction in ONE prompt", async () => {
    const { wallet, calls } = fakeWallet();
    const pre = [prebuilt("alt-create"), prebuilt("alt-extend"), prebuilt("create-and-register"), prebuilt("create-and-register")];
    const signer = createLaunchBatchSigner(wallet, pre);
    const swaps = await signer.sign([dummyTx(), dummyTx(), dummyTx()]);
    expect(swaps).to.have.length(3);
    expect(calls, "one prompt carrying 3 swaps + 4 launch txs").to.deep.equal([7]);
    const extras = await signer.signedPrebuilt();
    expect(extras).to.have.length(4);
    expect(calls, "the pre-built txs are not signed a second time").to.deep.equal([7]);
    expect(signer.prompts).to.equal(1);
  });

  it("a retry of legs that did not land is one more prompt with only those swaps", async () => {
    const { wallet, calls } = fakeWallet();
    const signer = createLaunchBatchSigner(wallet, [prebuilt("create-and-register")]);
    await signer.sign([dummyTx(), dummyTx()]);
    await signer.sign([dummyTx()]);
    expect(calls).to.deep.equal([3, 1]);
    expect(signer.prompts).to.equal(2);
  });

  it("a launch with no swaps (USDC-only, or every asset already held) still signs its launch txs in one prompt", async () => {
    const { wallet, calls } = fakeWallet();
    const signer = createLaunchBatchSigner(wallet, [prebuilt("alt-create"), prebuilt("create-and-register")]);
    const extras = await signer.signedPrebuilt();
    expect(extras).to.have.length(2);
    expect(calls).to.deep.equal([2]);
  });

  it("stamps a FRESH blockhash on the pre-built txs at the moment of the prompt (quoting 10 legs takes ~30 s)", async () => {
    const { wallet } = fakeWallet();
    const pre = [prebuilt("create-and-register")];
    const connection = { getLatestBlockhash: async () => ({ blockhash: BH2, lastValidBlockHeight: 999 }) } as any;
    const signer = createLaunchBatchSigner(wallet, pre, connection);
    await signer.sign([dummyTx()]);
    expect(pre[0].tx.message.recentBlockhash).to.equal(BH2);
    expect(pre[0].lastValidBlockHeight).to.equal(999);
  });
});

describe("one-approval launch: the Reserve's lookup table", () => {
  const addresses = Array.from({ length: 47 }, () => Keypair.generate().publicKey);
  const built = buildLaunchLookupTableTxs({ owner, recentSlot: 123456, blockhash: BH1, lastValidBlockHeight: 10, microLamports: 1000, lookupAddresses: addresses });

  it("carries the first chunk inside the create transaction, then one extend per further chunk", () => {
    expect(built.txs[0].kind).to.equal("alt-create");
    expect(built.txs.slice(1).every((t) => t.kind === "alt-extend")).to.equal(true);
    expect(built.txs).to.have.length(Math.ceil(addresses.length / ALT_EXTEND_CHUNK));
  });

  it("every table transaction fits Solana's 1232-byte limit", () => {
    for (const t of built.txs) expect(fitsOneTransaction(t.tx), t.kind).to.equal(true);
  });

  it("the table address is fixed by (owner, slot), so all of it can be signed before anything lands", () => {
    const again = buildLaunchLookupTableTxs({ owner, recentSlot: 123456, blockhash: BH2, lastValidBlockHeight: 10, microLamports: 1000, lookupAddresses: addresses });
    expect(again.table.equals(built.table)).to.equal(true);
    expect(built.table).to.be.instanceOf(PublicKey);
  });
});

describe("one-approval launch: wiring", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("the Mainnet Launch page asks for it", () => {
    expect(read("src/merge/pages/CreateDTR.tsx")).to.match(/oneApproval: IS_MAINNET/);
  });
  it("nothing is created before every asset is verified funded", () => {
    const src = read("src/merge/lib/createReserveClient.ts");
    const fin = src.slice(src.indexOf("async function finishOneApprovalLaunch"));
    expect(fin.indexOf("canEnterSeeding(fundingStates)")).to.be.greaterThan(-1);
    expect(fin.indexOf("assertSeedAmountsMeetMinimum")).to.be.lessThan(fin.indexOf('onProgress("create-and-register")'));
    expect(fin.indexOf("canEnterSeeding(fundingStates)")).to.be.lessThan(fin.indexOf('onProgress("create-and-register")'));
  });
  it("the funding swaps go through the batch signer, never one prompt per swap, when it is set", () => {
    const src = read("src/merge/lib/createReserveClient.ts");
    expect(src).to.match(/if \(opts\.batchSigner\) \{[\s\S]*?pendingSwaps\.push/);
    expect(src).to.match(/runBatchedFundingSwaps\(connection, wallet, owner, pendingSwaps, opts\.batchSigner/);
  });
});
