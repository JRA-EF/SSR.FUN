// DEC-0294: many-asset mints no longer let signed swap legs go stale.
// Beta report 2026-11-17, Reserve #26 (10 assets): a wallet that signs one
// transaction at a time took 1-2 minutes to approve every leg before anything
// was sent, the later legs' blockhash expired and nothing minted; small legs
// also failed Jupiter 6001 at a fixed 2% slippage.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { isBlockhashStale, partitionByFreshness, signAndSendLegs, LEG_SEND_MARGIN_BLOCKS, LEG_SIGN_MARGIN_BLOCKS, type SequencedLeg } from "../src/merge/lib/mintLegSequencer";
import { legSlippageBps, SMALL_LEG_SLIPPAGE_TIERS } from "../lib/mainnet/buildBuy";
import { MAX_SLIPPAGE_BPS } from "../lib/mainnet/jupiter";
import { describeBatchBuyWalletPrompt } from "../src/merge/lib/walletPromptCopy";
import { partitionSwapOutcomes, JupiterSwapNotLandedError } from "../src/merge/lib/jupiterSwapClient";

type Leg = SequencedLeg<string> & { gen: number };

/** A fake chain + wallet: every signature advances the block height by `blocksPerApproval`; every send is recorded with the height it was sent at. */
function harness(opts: { signAllAtOnce: boolean; blocksPerApproval: number; startHeight: number; rebuildLvbh?: () => number; sendFails?: (leg: Leg) => Error | null; maxRebuilds?: number }) {
  let height = opts.startHeight;
  const events: string[] = [];
  const sentAt: { mint: string; gen: number; height: number; lvbh: number }[] = [];
  const settled: string[] = [];
  let rebuildGen = 0;
  const run = (legs: Leg[]) =>
    signAndSendLegs<Leg, string>(legs, {
      signAllAtOnce: opts.signAllAtOnce,
      blockHeight: async () => height,
      sign: async (ls) => {
        height += opts.blocksPerApproval;
        events.push(`sign:${ls.map((l) => l.mint).join(",")}`);
        return ls.map((l) => `sig-${l.mint}-${l.gen}`);
      },
      send: async (leg, signed) => {
        expect(signed).to.equal(`sig-${leg.mint}-${leg.gen}`);
        events.push(`send:${leg.mint}`);
        sentAt.push({ mint: leg.mint, gen: leg.gen, height, lvbh: leg.lastValidBlockHeight });
        await new Promise((r) => setTimeout(r, 1));
        settled.push(leg.mint);
        const err = opts.sendFails?.(leg);
        if (err) throw err;
      },
      rebuild: async (mints) => {
        rebuildGen++;
        events.push(`rebuild:${mints.join(",")}`);
        const lvbh = opts.rebuildLvbh ? opts.rebuildLvbh() : height + 150;
        return mints.map((mint) => ({ mint, gen: rebuildGen, lastValidBlockHeight: lvbh }));
      },
      maxRebuilds: opts.maxRebuilds,
    });
  return { run, events, sentAt, settled, height: () => height };
}

const legs = (n: number, lvbh: number, presigned = false): Leg[] =>
  Array.from({ length: n }, (_, i) => ({ mint: `m${i}`, gen: 0, lastValidBlockHeight: lvbh, ...(presigned ? { presigned: `sig-m${i}-0` } : {}) }));

describe("many-asset mint: blockhash freshness (DEC-0294)", () => {
  it("isBlockhashStale uses the margin and never calls an unknown height stale", () => {
    expect(isBlockhashStale(1000, 900, 75)).to.equal(false);
    expect(isBlockhashStale(1000, 926, 75)).to.equal(true);
    expect(isBlockhashStale(1000, 925, 75)).to.equal(false);
    expect(isBlockhashStale(1000, 1001, 0)).to.equal(true);
    expect(isBlockhashStale(1000, 0, 75)).to.equal(false);
    expect(isBlockhashStale(0, 5000, 75)).to.equal(false);
  });

  it("partitionByFreshness keeps order", () => {
    const { fresh, stale } = partitionByFreshness(
      [
        { id: "a", lastValidBlockHeight: 100 },
        { id: "b", lastValidBlockHeight: 300 },
        { id: "c", lastValidBlockHeight: 90 },
      ],
      85,
      LEG_SEND_MARGIN_BLOCKS,
    );
    expect(fresh.map((l) => l.id)).to.deep.equal(["b"]);
    expect(stale.map((l) => l.id)).to.deep.equal(["a", "c"]);
  });

  it("margins: a sign margin covers a slow approval, the send margin leaves time to land", () => {
    expect(LEG_SIGN_MARGIN_BLOCKS).to.be.greaterThan(LEG_SEND_MARGIN_BLOCKS);
    expect(LEG_SIGN_MARGIN_BLOCKS).to.be.lessThan(150); // a fresh blockhash (~150 blocks) is always signable
  });
});

describe("many-asset mint: one-at-a-time wallets (DEC-0294)", () => {
  it("sends each leg right after it is signed, not after all are signed", async () => {
    const h = harness({ signAllAtOnce: false, blocksPerApproval: 5, startHeight: 1000 });
    const res = await h.run(legs(3, 1150));
    expect(h.events).to.deep.equal(["sign:m0", "send:m0", "sign:m1", "send:m1", "sign:m2", "send:m2"]);
    expect(res.legs.map((l) => l.mint)).to.deep.equal(["m0", "m1", "m2"]);
    expect(res.outcomes.every((o) => o.status === "fulfilled")).to.equal(true);
    expect(res.rebuilds).to.equal(0);
  });

  it("Reserve #26 shape: 10 legs at ~25 blocks (10 s) per approval -- no leg is ever sent close to expiry; unsent legs are rebuilt", async () => {
    const h = harness({ signAllAtOnce: false, blocksPerApproval: 25, startHeight: 1000 });
    const res = await h.run(legs(10, 1150));
    expect(res.legs.map((l) => l.mint)).to.deep.equal(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
    for (const s of h.sentAt) expect(s.lvbh - s.height, `leg ${s.mint} sent ${s.lvbh - s.height} blocks before expiry`).to.be.at.least(LEG_SEND_MARGIN_BLOCKS);
    expect(res.rebuilds).to.be.greaterThan(0);
    // A rebuild only ever covers legs that were not sent yet.
    const rebuilds = h.events.filter((e) => e.startsWith("rebuild:"));
    for (const r of rebuilds) {
      const at = h.events.indexOf(r);
      const sentBefore = h.events.slice(0, at).filter((e) => e.startsWith("send:")).map((e) => e.slice(5));
      for (const m of r.slice(8).split(",")) expect(sentBefore).to.not.include(m);
    }
  });

  it("waits for legs already in flight to settle before rebuilding (their output is recorded first)", async () => {
    const order: string[] = [];
    // Leg "a" is fresh, leg "b" is already too old to sign at height 1000.
    const tight = await signAndSendLegs<Leg, string>([{ mint: "a", gen: 0, lastValidBlockHeight: 1100 }, { mint: "b", gen: 0, lastValidBlockHeight: 1030 }], {
      signAllAtOnce: false,
      blockHeight: async () => 1000,
      sign: async (ls) => ls.map((l) => `s-${l.mint}`),
      send: async (leg) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`settled2:${leg.mint}`);
      },
      rebuild: async (mints) => {
        order.push(`rebuild2:${mints.join(",")}`);
        return mints.map((mint) => ({ mint, gen: 1, lastValidBlockHeight: 99_999 }));
      },
    });
    expect(order.indexOf("settled2:a")).to.be.lessThan(order.indexOf("rebuild2:b"));
    expect(tight.legs.map((l) => `${l.mint}${l.gen}`)).to.deep.equal(["a0", "b1"]);
  });

  it("a leg the server no longer returns on rebuild is simply not sent", async () => {
    const res = await signAndSendLegs<Leg, string>([{ mint: "a", gen: 0, lastValidBlockHeight: 1010 }, { mint: "b", gen: 0, lastValidBlockHeight: 1010 }], {
      signAllAtOnce: false,
      blockHeight: async () => 1000,
      sign: async (ls) => ls.map((l) => `s-${l.mint}`),
      send: async () => {},
      rebuild: async (mints) => mints.filter((m) => m === "b").map((mint) => ({ mint, gen: 1, lastValidBlockHeight: 5000 })),
    });
    expect(res.legs.map((l) => l.mint)).to.deep.equal(["b"]);
  });

  it("after the rebuild budget is spent, legs are sent as they are (the retry path handles an expiry)", async () => {
    const h = harness({ signAllAtOnce: false, blocksPerApproval: 0, startHeight: 1000, rebuildLvbh: () => 1010, maxRebuilds: 2 });
    const res = await h.run(legs(2, 1010));
    expect(res.rebuilds).to.equal(2);
    expect(res.legs.map((l) => l.mint)).to.deep.equal(["m0", "m1"]);
  });

  it("a leg's own failure is reported in outcomes, partitioned as retryable like before", async () => {
    const h = harness({
      signAllAtOnce: false,
      blocksPerApproval: 1,
      startHeight: 1000,
      sendFails: (l) => (l.mint === "m1" ? new JupiterSwapNotLandedError("failed", "sig", "slippage") : null),
    });
    const res = await h.run(legs(3, 1150));
    const { retryable, fatal } = partitionSwapOutcomes(res.legs, res.outcomes);
    expect(fatal).to.equal(null);
    expect(retryable.map((l) => l.mint)).to.deep.equal(["m1"]);
  });

  it("a signing refusal stops the round (rejects), after the legs already sent were dispatched", async () => {
    let n = 0;
    const sent: string[] = [];
    let err: unknown = null;
    await signAndSendLegs<Leg, string>(legs(3, 5000), {
      signAllAtOnce: false,
      blockHeight: async () => 1000,
      sign: async (ls) => {
        if (n++ === 1) throw new Error("User rejected the request.");
        return ls.map((l) => `s-${l.mint}`);
      },
      send: async (leg) => {
        sent.push(leg.mint);
      },
      rebuild: async () => [],
    }).catch((e) => (err = e));
    expect(String(err)).to.contain("User rejected");
    expect(sent).to.deep.equal(["m0"]);
  });
});

describe("many-asset mint: sign-all wallets (DEC-0294)", () => {
  it("presigned legs that are still fresh are sent without another prompt", async () => {
    const h = harness({ signAllAtOnce: true, blocksPerApproval: 5, startHeight: 1000 });
    const res = await h.run(legs(4, 1150, true));
    expect(h.events.filter((e) => e.startsWith("sign:"))).to.deep.equal([]);
    expect(res.legs.length).to.equal(4);
  });

  it("a user who left the one prompt open too long: no dead leg is sent; the unsent legs are rebuilt and signed again in ONE prompt", async () => {
    // The batch was signed, but by now only 10 blocks remain.
    const h = harness({ signAllAtOnce: true, blocksPerApproval: 5, startHeight: 1140 });
    const res = await h.run(legs(4, 1150, true));
    expect(h.events).to.deep.equal(["rebuild:m0,m1,m2,m3", "sign:m0,m1,m2,m3", "send:m0", "send:m1", "send:m2", "send:m3"]);
    expect(res.legs.every((l) => l.gen === 1)).to.equal(true);
    for (const s of h.sentAt) expect(s.lvbh - s.height).to.be.at.least(LEG_SEND_MARGIN_BLOCKS);
  });

  it("legs signed together but slow to approve on a rebuild are checked again after signing", async () => {
    let first = true;
    const h = harness({ signAllAtOnce: true, blocksPerApproval: 140, startHeight: 1000, rebuildLvbh: () => (first ? ((first = false), 1150) : 99_999) });
    const res = await h.run(legs(2, 1150));
    // First prompt took 140 blocks -> too old to send -> rebuilt -> second prompt -> also too old (lvbh 1150 again) -> rebuilt -> fresh.
    expect(res.rebuilds).to.equal(2);
    for (const s of h.sentAt) expect(s.lvbh - s.height).to.be.at.least(LEG_SEND_MARGIN_BLOCKS);
  });
});

describe("many-asset mint: small-leg slippage (DEC-0294)", () => {
  it("tiers: <= $1 at 5%, <= $5 at 3%, larger legs keep the caller's value", () => {
    expect(legSlippageBps(300_000n, 200)).to.equal(500);
    expect(legSlippageBps(1_000_000n, 200)).to.equal(500);
    expect(legSlippageBps(1_000_001n, 200)).to.equal(300);
    expect(legSlippageBps(5_000_000n, 200)).to.equal(300);
    expect(legSlippageBps(5_000_001n, 200)).to.equal(200);
    expect(legSlippageBps(250_000_000n, 150)).to.equal(150);
  });

  it("never lowers the caller's slippage and never exceeds the hard ceiling", () => {
    expect(legSlippageBps(2_000_000n, 400)).to.equal(400);
    expect(legSlippageBps(500_000n, 450)).to.equal(500);
    for (const t of SMALL_LEG_SLIPPAGE_TIERS) expect(t.slippageBps).to.be.at.most(MAX_SLIPPAGE_BPS);
  });

  it("the extra exposure over a 2% baseline stays around 5 cents per leg at each tier edge", () => {
    for (const t of SMALL_LEG_SLIPPAGE_TIERS) {
      const extraUsd = (Number(t.maxUsdcRaw) / 1e6) * ((t.slippageBps - 200) / 10_000);
      expect(extraUsd).to.be.at.most(0.05 + 1e-9);
    }
  });

  it("the mint's own deposit caps still use the caller's slippage, only the Jupiter quotes use the tiers", () => {
    const src = readFileSync(join(__dirname, "../lib/mainnet/buildBuy.ts"), "utf8");
    expect(src).to.contain("slippageBps: input.slippageBps / 10_000");
    expect(src).to.contain("slippageBps: legSlippageBps(action.usdcBudgetRaw, input.slippageBps)");
    expect(src).to.contain("slippageBps: legSlippageBps(budget, input.slippageBps)");
  });
});

describe("many-asset mint: client wiring (DEC-0294)", () => {
  const client = readFileSync(join(__dirname, "../src/merge/lib/multiAssetBuyClient.ts"), "utf8");
  it("every swap round (first, retry, top-up) goes through the sequencer", () => {
    expect(client).to.not.contain("submitSwaps(");
    expect(client.match(/runSwapRound\(/g)?.length ?? 0).to.equal(3); // first round, retry, top-up
  });
  it("a one-at-a-time wallet signs nothing up front in a batch; the mint is signed after the swaps", () => {
    expect(client).to.contain('const signUpFront = build.mode === "single" || canSignAll || hasLegacyAltSetup;');
    expect(client).to.contain("[mintSigned] = await signMany([decode(mintTx!)]);");
  });
  it("the DEC-0293 setup-first step still runs before the batch", () => {
    expect(client.indexOf("landAltSetupThenRebuild(")).to.be.greaterThan(0);
    expect(client.indexOf("landAltSetupThenRebuild(")).to.be.lessThan(client.indexOf("const signUpFront"));
  });
  it("UI copy for one-at-a-time approvals says Mint terms, not Buy", () => {
    const s = describeBatchBuyWalletPrompt({ swaps: 10, total: 11, ticker: "SSR26", oneAtATime: true });
    expect(s).to.contain("one after another");
    expect(s).to.contain("each sent as soon as you approve it");
    expect(s).to.contain("mints your SSR26");
    expect(s.toLowerCase()).to.not.match(/\bbuy\b|\bpurchase\b/);
  });
});
