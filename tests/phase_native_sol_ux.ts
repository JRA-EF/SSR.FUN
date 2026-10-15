// DEC-0244: users only ever see and hold native SOL. Vaults keep custody as
// wrapped SOL; every Mainnet flow unwraps inside the transaction that used
// it, as its LAST instruction (anything earlier is the DEC-0156 incident:
// the leg unwrapped before the mint could deposit it).
import { expect } from "chai";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { displayAssetIdentity, WRAPPED_SOL_MINT } from "../packages/sdk/src/zapPricing";
import { assembleSingleBuyInstructions, buildUnwrapSolInstructions } from "../src/merge/lib/singleTxBuy";

const WSOL = WRAPPED_SOL_MINT.toBase58();
const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CLOSE_ACCOUNT = 9; // SPL Token instruction tag

describe("DEC-0244 native SOL -- display", () => {
  it("shows the wrapped-SOL mint as SOL / Solana, never Jupiter's 'Wrapped SOL'", () => {
    expect(displayAssetIdentity(WSOL, "SOL", "Wrapped SOL")).to.deep.equal({ symbol: "SOL", name: "Solana" });
    expect(displayAssetIdentity(WSOL, "WSOL", null)).to.deep.equal({ symbol: "SOL", name: "Solana" });
  });
  it("leaves every other asset as the catalogue has it (name falls back to symbol)", () => {
    expect(displayAssetIdentity(RAY, "RAY", "Raydium")).to.deep.equal({ symbol: "RAY", name: "Raydium" });
    expect(displayAssetIdentity(RAY, "RAY", "")).to.deep.equal({ symbol: "RAY", name: "RAY" });
  });
});

describe("DEC-0244 native SOL -- unwrap instruction", () => {
  const owner = Keypair.generate().publicKey;

  it("closes the owner's wrapped-SOL account to the owner when the Reserve has a SOL leg", () => {
    const [ix] = buildUnwrapSolInstructions(owner, [RAY, WSOL]);
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).to.equal(true);
    expect(ix.data[0]).to.equal(CLOSE_ACCOUNT);
    expect(ix.keys[0].pubkey.equals(getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, owner))).to.equal(true);
    expect(ix.keys[1].pubkey.equals(owner)).to.equal(true); // lamports go back to the owner as native SOL
    expect(ix.keys[2].pubkey.equals(owner)).to.equal(true);
  });

  it("adds nothing when the Reserve holds no SOL", () => {
    expect(buildUnwrapSolInstructions(owner, [RAY])).to.deep.equal([]);
  });

  it("in the one-transaction mint the unwrap comes AFTER the mint, never before it", () => {
    const mintIx = SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const unwrap = buildUnwrapSolInstructions(owner, [WSOL]);
    const ixs = assembleSingleBuyInstructions({ ataCreateInstructions: [], swapSets: [], wrapInstructions: [], mintInstruction: mintIx, unwrapInstructions: unwrap });
    expect(ixs[ixs.length - 1]).to.equal(unwrap[0]);
    expect(ixs[ixs.length - 2]).to.equal(mintIx);
    expect(ixs.filter((i) => i.programId.equals(ComputeBudgetProgram.programId))).to.have.length(2);
  });

  it("without a SOL leg the mint stays last, unchanged", () => {
    const mintIx = SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(RAY), lamports: 1 });
    const ixs = assembleSingleBuyInstructions({ ataCreateInstructions: [], swapSets: [], wrapInstructions: [], mintInstruction: mintIx });
    expect(ixs[ixs.length - 1]).to.equal(mintIx);
  });
});
