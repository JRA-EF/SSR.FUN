// Pure-logic regression coverage for the Manager Dashboard -> Rebalance
// tab's "Add a Reserve Asset" list and for the token-program resolution the
// composition actions (Submit Rebalance / Fund / Remove) now perform. No
// wallet/RPC/program involvement, consistent with this repo's offline
// pure-function test convention (see tests/phase_rebalance_slider.ts).
//
// Background: on Mainnet the list was a hard-coded empty array left over
// from the USDC-only launch, so every Reserve showed "Every supported asset
// is already in your proposed composition" and no xStocks token could be
// added through Rebalance. And the three composition actions never passed
// the asset's token program, so a Token-2022 asset (every xStocks token)
// would have been registered, funded, or removed under classic SPL Token.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_rebalance_addable_assets.ts
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { MINT_SIZE, MintLayout } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../packages/sdk/src/tokenPrograms";
import { addableAssetsForRebalance, type AddableAsset } from "../src/merge/lib/rebalanceAddableAssets";
import { describeUnsupportedNewAssets, resolveAssetTokenPrograms } from "../src/merge/lib/assetTokenPrograms";

const USDC: AddableAsset = { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, issuer: null };
const SOL: AddableAsset = { symbol: "SOL", name: "Wrapped SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9, issuer: null };
const AAPL: AddableAsset = { symbol: "AAPLx", name: "Apple xStock", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, issuer: "xstocks" };
const TSLA: AddableAsset = { symbol: "TSLAx", name: "Tesla xStock", mint: "XsDoVfqeBukxuZHWZdqRxcHGJHCw8jzXf3cEDZ1zcgb", decimals: 8, issuer: "xstocks" };
const OFFERED = [USDC, SOL, AAPL, TSLA];

describe("Rebalance tab: Add a Reserve Asset list (addableAssetsForRebalance)", () => {
  it("offers every catalogue asset that is not already in the proposal, in catalogue order", () => {
    const r = addableAssetsForRebalance(OFFERED, [USDC.mint], "", "all");
    expect(r.emptyState).to.equal(null);
    expect(r.assets.map((a) => a.symbol)).to.deep.equal(["SOL", "AAPLx", "TSLAx"]);
  });

  it("a Mainnet Reserve holding only USDC can add an xStocks token -- the reported bug", () => {
    const r = addableAssetsForRebalance(OFFERED, [USDC.mint], "aapl", "all");
    expect(r.assets.map((a) => a.mint)).to.deep.equal([AAPL.mint]);
  });

  it("searches by name, ticker, or contract address, like Create Reserve's picker", () => {
    expect(addableAssetsForRebalance(OFFERED, [], "tesla", "all").assets.map((a) => a.symbol)).to.deep.equal(["TSLAx"]);
    expect(addableAssetsForRebalance(OFFERED, [], "tslax", "all").assets.map((a) => a.symbol)).to.deep.equal(["TSLAx"]);
    expect(addableAssetsForRebalance(OFFERED, [], AAPL.mint.slice(0, 8), "all").assets.map((a) => a.symbol)).to.deep.equal(["AAPLx"]);
  });

  it("the asset-type filter narrows to tokenised stocks or to crypto only, never widening what is offered", () => {
    expect(addableAssetsForRebalance(OFFERED, [], "", "xstocks").assets.map((a) => a.symbol)).to.deep.equal(["AAPLx", "TSLAx"]);
    expect(addableAssetsForRebalance(OFFERED, [], "", "crypto").assets.map((a) => a.symbol)).to.deep.equal(["USDC", "SOL"]);
  });

  it("says 'all added' ONLY when the whole offered list is already in the proposal", () => {
    expect(addableAssetsForRebalance(OFFERED, OFFERED.map((a) => a.mint), "", "all")).to.deep.equal({ assets: [], emptyState: "all-added" });
    // The old bug: an empty OFFERED list also read as "every supported asset
    // is already in your proposed composition". That wording is still the
    // honest one for a genuinely empty offer, but only the page's
    // catalogue-loading / unavailable states may now produce an empty offer.
    expect(addableAssetsForRebalance([], [USDC.mint], "", "all").emptyState).to.equal("all-added");
  });

  it("distinguishes 'no search match' from 'nothing of that type' so the page can say which", () => {
    expect(addableAssetsForRebalance(OFFERED, [], "zzz", "all")).to.deep.equal({ assets: [], emptyState: "no-match" });
    expect(addableAssetsForRebalance(OFFERED, [], "sol", "xstocks")).to.deep.equal({ assets: [], emptyState: "none-for-type" });
  });
});

describe("Composition actions: token program per asset mint (assetTokenPrograms)", () => {
  const classic = new PublicKey(SOL.mint);
  const t22 = new PublicKey(AAPL.mint);
  /** The 82-byte base mint layout -- a Token-2022 mint with no extensions is exactly this, so it decodes and is supported. */
  const baseMintData = () => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 8, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
      data,
    );
    return data;
  };
  const account = (owner: PublicKey, data: Buffer = baseMintData()) => ({ data, owner });

  it("resolves each mint to the program that owns it -- Token-2022 for an xStocks mint, classic otherwise", () => {
    const r = resolveAssetTokenPrograms([classic, t22], [account(TOKEN_PROGRAM_ID), account(TOKEN_2022_PROGRAM_ID)]);
    expect(r.map((x) => x.tokenProgram.toBase58())).to.deep.equal([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
    expect(r.map((x) => x.mint)).to.deep.equal([classic, t22]);
  });

  it("falls back to classic SPL Token when the read was skipped or the account is missing -- never blocks on a lookup", () => {
    expect(resolveAssetTokenPrograms([t22], null)[0].tokenProgram.equals(TOKEN_PROGRAM_ID)).to.equal(true);
    expect(resolveAssetTokenPrograms([t22], [null])[0].tokenProgram.equals(TOKEN_PROGRAM_ID)).to.equal(true);
  });

  it("refuses nothing when the mint read failed (null) -- the transaction fails the way it always did instead", () => {
    expect(describeUnsupportedNewAssets([{ mint: t22, symbol: "AAPLx" }], null)).to.deep.equal([]);
  });

  it("accepts a classic mint and a Token-2022 mint whose extensions are supported", () => {
    expect(describeUnsupportedNewAssets([{ mint: classic }, { mint: t22, symbol: "AAPLx" }], [account(TOKEN_PROGRAM_ID), account(TOKEN_2022_PROGRAM_ID)])).to.deep.equal([]);
  });

  it("refuses, by ticker and in plain words, a Token-2022 mint the program could not accept -- before the wallet ever opens", () => {
    const blocked = describeUnsupportedNewAssets([{ mint: t22, symbol: "AAPLx" }], [account(TOKEN_2022_PROGRAM_ID, Buffer.alloc(0))]);
    expect(blocked).to.have.length(1);
    expect(blocked[0]).to.match(/^AAPLx /);
    expect(blocked[0]).to.not.match(/add_reserve_asset_active|Token2022|UnsupportedTokenProgram/);
  });

  it("names the address when no ticker is known, so the refusal still identifies the asset", () => {
    const blocked = describeUnsupportedNewAssets([{ mint: t22 }], [account(TOKEN_2022_PROGRAM_ID, Buffer.alloc(0))]);
    expect(blocked[0].startsWith(t22.toBase58())).to.equal(true);
  });
});
