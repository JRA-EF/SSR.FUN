// Pure-logic coverage for packages/sdk/src/directInstructions.ts -- the
// Mainnet-native single-asset direct mint/redeem path (no swap authority,
// no server co-signer). See the file's own header comment for why this
// exists: zapInstructions.ts's DevNet zap depends on a swap authority that
// can mint fake test tokens, which has no Mainnet equivalent.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_mainnet_direct_instructions.ts
import { expect } from "chai";
import { computeDirectReserveTokensRequested } from "../packages/sdk/src/directInstructions";
import { computeMintRequirements } from "../packages/sdk/src/calculations";

describe("computeDirectReserveTokensRequested (packages/sdk/src/directInstructions.ts)", () => {
  it("is the exact floor-inverse of computeMintRequirements's per-leg ceil formula -- required amount never exceeds amountIn", () => {
    const vaultBalance = 901_500n;
    const totalSupply = 1_200_000n;
    const amountIn = 250_000n;

    const reserveTokensRequested = computeDirectReserveTokensRequested(amountIn, vaultBalance, totalSupply);
    const [requirement] = computeMintRequirements(reserveTokensRequested, totalSupply, [{ mint: "USDC", vaultBalance }]);

    expect(requirement.requiredAmount <= amountIn).to.equal(true);
    // Within 1 raw unit of amountIn for any non-trivial deposit -- the
    // floor/ceil round-trip loses at most a single unit of precision.
    expect(amountIn - requirement.requiredAmount).to.be.lessThan(2n);
  });

  it("computes exact proportional math for a simple round-number case", () => {
    // Vault holds 1,000,000 raw units backing 1,000,000 raw Reserve Tokens
    // (1:1 NAV) -- depositing 100,000 should request ~100,000 Reserve Tokens.
    const result = computeDirectReserveTokensRequested(100_000n, 1_000_000n, 1_000_000n);
    expect(result).to.equal(100_000n);
  });

  it("scales correctly once NAV has grown above 1:1 (vault worth more per Reserve Token than at genesis)", () => {
    // Vault holds 2,000,000 backing only 1,000,000 Reserve Tokens (NAV = 2x) --
    // the same 100,000 deposit should now request only ~50,000 Reserve Tokens.
    const result = computeDirectReserveTokensRequested(100_000n, 2_000_000n, 1_000_000n);
    expect(result).to.equal(50_000n);
  });

  it("throws rather than silently returning zero/garbage when the Reserve has zero supply (must be seeded first)", () => {
    expect(() => computeDirectReserveTokensRequested(1_000n, 1_000n, 0n)).to.throw(/must already be seeded/);
  });

  it("throws when the vault balance is zero (would divide by zero)", () => {
    expect(() => computeDirectReserveTokensRequested(1_000n, 0n, 1_000_000n)).to.throw(/must already be seeded/);
  });

  it("throws for a non-positive deposit amount rather than returning a nonsensical negative/zero requested amount", () => {
    expect(() => computeDirectReserveTokensRequested(0n, 1_000n, 1_000_000n)).to.throw(/must be positive/);
    expect(() => computeDirectReserveTokensRequested(-1n, 1_000n, 1_000_000n)).to.throw(/must be positive/);
  });
});
