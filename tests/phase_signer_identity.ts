// Signer identity guards (DEC-0200) -- the 2026-09-11 QA report that a
// Reserve created with Solflare opened PHANTOM on Rebalance and failed.
//
// No code path in this repo picks a wallet provider, so these guards exist to
// make a wrong-wallet event LOUD and attributable rather than silent. The
// tests below pin the two properties that matter: a flow is never signed by an
// account it was not planned for, and a transaction that comes back without
// the connected account's signature is refused before submission.
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { SignerMismatchError, assertAllSignedBy, assertSignedBy, assertSignerReady, connectedWalletLabel, hasSignatureFrom } from "../src/merge/lib/assertSigner";

const BLOCKHASH = "GfVcyD5g4T1yY3aLj7Y5ZQhYjQ1kJ7RkS6oY8cQ8xY7Z";

function wallet(p: { name?: string | null; connected?: boolean; publicKey?: PublicKey | null; canSign?: boolean }): WalletContextState {
  return {
    wallet: p.name === null ? null : { adapter: { name: p.name ?? "Solflare" } },
    connected: p.connected ?? true,
    publicKey: p.publicKey === undefined ? Keypair.generate().publicKey : p.publicKey,
    signTransaction: (p.canSign ?? true) ? (async (t: unknown) => t) : undefined,
  } as unknown as WalletContextState;
}

function legacyTx(payer: PublicKey): Transaction {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
  tx.feePayer = payer;
  tx.recentBlockhash = BLOCKHASH;
  return tx;
}

function versionedTx(payer: PublicKey): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
  }).compileToV0Message([]);
  return new VersionedTransaction(msg);
}

describe("assertSignerReady -- preflight", () => {
  it("returns the connected key when a usable wallet is connected", () => {
    const kp = Keypair.generate();
    const w = wallet({ publicKey: kp.publicKey });
    expect(assertSignerReady({ wallet: w, action: "rebalance" }).toBase58()).to.equal(kp.publicKey.toBase58());
  });

  it("refuses when no wallet is connected, naming the action and stating nothing was submitted", () => {
    const w = wallet({ connected: false, publicKey: null });
    expect(() => assertSignerReady({ wallet: w, action: "rebalance" })).to.throw(/No wallet is connected.*rebalance.*nothing was submitted/i);
  });

  it("refuses a wallet that cannot sign, naming the wallet", () => {
    const w = wallet({ name: "Solflare", canSign: false });
    expect(() => assertSignerReady({ wallet: w, action: "sale" })).to.throw(/Solflare cannot sign transactions/);
  });

  it("THE REPORTED CASE: the flow was planned for one account but another is now connected -- refuses, names both keys and the wallet, submits nothing", () => {
    const planned = Keypair.generate().publicKey;
    const nowConnected = Keypair.generate().publicKey;
    const w = wallet({ name: "Phantom", publicKey: nowConnected });
    let err: unknown = null;
    try {
      assertSignerReady({ wallet: w, expectedOwner: planned, action: "rebalance" });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(SignerMismatchError);
    const e = err as SignerMismatchError;
    expect(e.expected).to.equal(planned.toBase58());
    expect(e.actual).to.equal(nowConnected.toBase58());
    expect(e.message).to.include("Phantom");
    expect(e.message).to.include(planned.toBase58());
    expect(e.message).to.include("Nothing was submitted");
  });

  it("accepts the expected owner given either as a PublicKey or as a base58 string", () => {
    const kp = Keypair.generate();
    const w = wallet({ publicKey: kp.publicKey });
    expect(() => assertSignerReady({ wallet: w, expectedOwner: kp.publicKey, action: "purchase" })).to.not.throw();
    expect(() => assertSignerReady({ wallet: w, expectedOwner: kp.publicKey.toBase58(), action: "purchase" })).to.not.throw();
  });

  it("falls back to a neutral label when the adapter exposes no name", () => {
    expect(connectedWalletLabel(wallet({ name: null }))).to.equal("the connected wallet");
    expect(connectedWalletLabel(wallet({ name: "Solflare" }))).to.equal("Solflare");
  });
});

describe("assertSignedBy -- post-sign, the guard that catches a different wallet signing", () => {
  it("passes for a legacy transaction genuinely signed by the connected key", () => {
    const kp = Keypair.generate();
    const tx = legacyTx(kp.publicKey);
    tx.sign(kp);
    expect(hasSignatureFrom(tx, kp.publicKey)).to.equal(true);
    expect(() => assertSignedBy(tx, kp.publicKey, wallet({}), "this rebalance")).to.not.throw();
  });

  it("refuses a legacy transaction that came back unsigned", () => {
    const kp = Keypair.generate();
    expect(hasSignatureFrom(legacyTx(kp.publicKey), kp.publicKey)).to.equal(false);
    expect(() => assertSignedBy(legacyTx(kp.publicKey), kp.publicKey, wallet({ name: "Phantom" }), "this rebalance")).to.throw(SignerMismatchError);
  });

  it("refuses a legacy transaction signed by a DIFFERENT key, and says so in words a tester can act on", () => {
    const connected = Keypair.generate();
    const other = Keypair.generate();
    const tx = legacyTx(other.publicKey);
    tx.sign(other);
    let err: unknown = null;
    try {
      assertSignedBy(tx, connected.publicKey, wallet({ name: "Phantom" }), "this rebalance");
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(SignerMismatchError);
    expect((err as Error).message).to.include("Phantom returned this rebalance without a signature from the connected account");
    expect((err as Error).message).to.include(connected.publicKey.toBase58());
    expect((err as Error).message).to.include("Nothing was submitted");
  });

  it("handles VersionedTransactions (the Buy/Sell shape): signed passes, unsigned refuses", () => {
    const kp = Keypair.generate();
    const unsigned = versionedTx(kp.publicKey);
    expect(hasSignatureFrom(unsigned, kp.publicKey)).to.equal(false);
    const signed = versionedTx(kp.publicKey);
    signed.sign([kp]);
    expect(hasSignatureFrom(signed, kp.publicKey)).to.equal(true);
    expect(() => assertSignedBy(signed, kp.publicKey, wallet({}), "the mint")).to.not.throw();
    expect(() => assertSignedBy(unsigned, kp.publicKey, wallet({}), "the mint")).to.throw(SignerMismatchError);
  });

  it("a versioned transaction that does not involve the connected key at all is refused (never silently accepted)", () => {
    const connected = Keypair.generate();
    const other = Keypair.generate();
    const tx = versionedTx(other.publicKey);
    tx.sign([other]);
    expect(hasSignatureFrom(tx, connected.publicKey)).to.equal(false);
    expect(() => assertSignedBy(tx, connected.publicKey, wallet({}), "the mint")).to.throw(SignerMismatchError);
  });

  it("assertAllSignedBy names WHICH transaction of a batch failed, so a 10-leg purchase is debuggable", () => {
    const kp = Keypair.generate();
    const good = versionedTx(kp.publicKey);
    good.sign([kp]);
    const bad = versionedTx(kp.publicKey);
    expect(() => assertAllSignedBy([good, good, bad], kp.publicKey, wallet({}), (i) => `transaction ${i + 1} of this purchase`)).to.throw(/transaction 3 of this purchase/);
    expect(() => assertAllSignedBy([good, good], kp.publicKey, wallet({}))).to.not.throw();
  });
});
