import { expect } from "chai";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { landAltSetupThenRebuild } from "../src/merge/lib/reserveAltSetupFirst";

// DEC-0293: the table setup is signed alone and landed before the main batch is built.
const payer = Keypair.generate().publicKey;
const tx = () => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [] }).compileToV0Message()).serialize()).toString("base64");
const t = (kind: string) => ({ kind, base64: tx(), lastValidBlockHeight: 1 });
const ALT = Keypair.generate().publicKey.toBase58();

function deps(log: string[]) {
  return {
    connection: {} as never,
    reserve: "R",
    signMany: async (txs: VersionedTransaction[]) => { log.push(`sign:${txs.length}`); return txs; },
    submitAndConfirm: async (_tx: VersionedTransaction, _h: number, what: string) => { log.push(`send:${what}`); },
    waitForTable: async (_c: unknown, p: PublicKey) => { log.push(`wait:${p.toBase58() === ALT}`); },
    waitForTableExists: async () => { log.push("exists"); },
    register: async () => { log.push("register"); },
    sleep: async () => {},
  };
}

describe("lookup-table setup in its own prompt (DEC-0293)", () => {
  it("returns a build without setup unchanged and signs nothing", async () => {
    const log: string[] = [];
    const build = { transactions: [t("redeem"), t("swap")], altToRegister: null };
    const out = await landAltSetupThenRebuild(build, async () => { throw new Error("no rebuild"); }, deps(log));
    expect(out).to.equal(build);
    expect(log).to.deep.equal([]);
  });

  it("signs each setup transaction alone, lands them in order, registers, then rebuilds", async () => {
    const log: string[] = [];
    const build = { transactions: [t("alt-create"), t("alt-extend"), t("redeem"), t("swap"), t("swap")], altToRegister: ALT };
    const fresh = { transactions: [t("redeem"), t("swap"), t("swap")], altToRegister: null };
    const out = await landAltSetupThenRebuild(build, async () => { log.push("rebuild"); return fresh; }, deps(log));
    expect(out).to.equal(fresh);
    expect(log).to.deep.equal(["sign:1", "send:the lookup table creation", "exists", "sign:1", "send:the lookup table extension", "wait:true", "register", "rebuild"]);
  });

  it("refuses to go on if the server keeps returning setup", async () => {
    const build = { transactions: [t("alt-create"), t("mint")], altToRegister: ALT };
    let err: unknown = null;
    await landAltSetupThenRebuild(build, async () => build, deps([])).catch((e) => (err = e));
    expect(String(err)).to.include("does not see its lookup table yet");
  });
});
