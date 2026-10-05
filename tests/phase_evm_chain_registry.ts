// The chain registry's invariants. These are what make "add a chain" a config
// change rather than a refactor, so they are pinned.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_evm_chain_registry.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS, LIVE_EVM_CHAINS, chainByKey, chainByIdPrefix } from "../src/merge/lib/evmChain";
import { EVM_ID_PREFIXES, evmReserveId, parseEvmReserveId, rhReserveId, rhAddressFromId } from "../src/merge/lib/evmReserveId";

const ADDR = "0xADEd2d2967AC92EE8FB52612D3436511F302Fe2f";

describe("the EVM chain registry", () => {
  it("is keyed by CHAIN, not by Robinhood's environments", () => {
    expect(Object.keys(CHAINS)).to.include.members(["robinhood", "base", "bnb"]);
    expect(Object.keys(CHAINS)).to.not.include("mainnet");
    expect(Object.keys(CHAINS)).to.not.include("testnet");
  });

  it("every entry's key matches its slot, so lookups cannot lie", () => {
    for (const [slot, cfg] of Object.entries(CHAINS)) expect(cfg.key, slot).to.equal(slot);
  });

  it("id prefixes are unique -- a collision would route a reserve to the wrong chain", () => {
    const prefixes = Object.values(CHAINS).map((c) => c.idPrefix);
    expect(new Set(prefixes).size, prefixes.join(",")).to.equal(prefixes.length);
  });

  it("evmReserveId.ts's prefix table matches the configs exactly (it is duplicated to keep viem out of the router)", () => {
    const fromConfigs = Object.fromEntries(Object.values(CHAINS).map((c) => [c.idPrefix, c.key]));
    expect(EVM_ID_PREFIXES).to.deep.equal(fromConfigs);
  });

  it("only chains with a deployed stack are offered", () => {
    for (const cfg of LIVE_EVM_CHAINS) {
      expect(cfg.deployer, `${cfg.key} is live but has no factory`).to.not.equal("0x0000000000000000000000000000000000000000");
    }
    // Base and BNB are verified reference wiring, deliberately not offered.
    expect(CHAINS.base.live).to.equal(false);
    expect(CHAINS.bnb.live).to.equal(false);
  });

  it("every chain that can be offered can also price -- a live chain with no DEX reports $0 reserves", () => {
    for (const cfg of LIVE_EVM_CHAINS) {
      expect(cfg.dex, `${cfg.key} has no DEX`).to.not.equal(undefined);
      expect(cfg.quotes, `${cfg.key} has no quote assets`).to.not.equal(undefined);
    }
  });

  it("the reference chains carry real, probe-verified wiring", () => {
    expect(CHAINS.base.quotes?.usd.decimals, "Base USDC is 6").to.equal(6);
    expect(CHAINS.bnb.quotes?.usd.decimals, "BNB's USDT is 18, not 6 -- the defect that motivated this").to.equal(18);
    expect(CHAINS.bnb.dex?.fees, "PancakeSwap's tiers differ from Uniswap's").to.include(2500);
    expect(CHAINS.base.dex?.fees).to.include(3000);
  });
});

describe("reserve ids carry their chain", () => {
  it("round-trips for every configured chain", () => {
    for (const cfg of Object.values(CHAINS)) {
      const id = evmReserveId(cfg.idPrefix, ADDR);
      const ref = parseEvmReserveId(id);
      expect(ref, id).to.not.equal(null);
      expect(ref!.chainKey).to.equal(cfg.key);
      expect(ref!.address).to.equal(ADDR);
      expect(chainByKey(ref!.chainKey)).to.equal(cfg);
      expect(chainByIdPrefix(cfg.idPrefix)).to.equal(cfg);
    }
  });

  it("every rh- link already issued still resolves", () => {
    expect(rhReserveId(ADDR)).to.equal(`rh-${ADDR}`);
    expect(rhAddressFromId(`rh-${ADDR}`)).to.equal(ADDR);
    expect(parseEvmReserveId(`rh-${ADDR}`)!.chainKey).to.equal("robinhood");
  });

  it("refuses an unknown prefix, a Solana id and a malformed address rather than guessing", () => {
    expect(parseEvmReserveId(`zzz-${ADDR}`)).to.equal(null);
    expect(parseEvmReserveId("mainnet-beta-26")).to.equal(null);
    expect(parseEvmReserveId("rh-0xnope")).to.equal(null);
    expect(parseEvmReserveId(ADDR)).to.equal(null);
    // A Base id must NOT come back as Robinhood's address.
    expect(rhAddressFromId(`base-${ADDR}`)).to.equal(null);
  });
});

describe("no chain's wiring may live outside the registry", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("the chain-agnostic libs contain no 40-hex-digit literal", () => {
    for (const f of ["src/merge/lib/evmSwap.ts", "src/merge/lib/evmLaunch.ts"]) {
      expect(read(f), `${f} must take addresses from the ChainConfig`).to.not.match(/"0x[0-9a-fA-F]{40}"/);
    }
  });

  it("the components take their chain as a prop, never as a module constant", () => {
    for (const f of ["src/merge/components/robinhood/RobinhoodCreateForm.tsx", "src/merge/components/robinhood/RobinhoodReserveDetail.tsx"]) {
      const src = read(f);
      expect(src, `${f} must not fix a chain at module scope`).to.not.match(/^const cfg = ROBINHOOD;/m);
      expect(src, `${f} must accept a chain prop`).to.include("chain = ROBINHOOD");
    }
  });
});
