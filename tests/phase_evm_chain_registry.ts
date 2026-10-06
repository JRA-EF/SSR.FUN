// The chain registry's invariants. These are what make "add a chain" a config
// change rather than a refactor, so they are pinned.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_evm_chain_registry.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS, LIVE_EVM_CHAINS, chainByKey, chainByIdPrefix } from "../src/merge/lib/evmChain";
import { EVM_LAUNCH_OPTIONS, chainFromPath, launchOptions, pathForChain } from "../src/merge/lib/chainChoice";
import { UPSTREAMS, chainOf, upstreamUrl } from "../api/robinhood/rpc-proxy";
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
    // Base is verified reference wiring, deliberately not offered. BNB went
    // live 2026-10-06 with a deployed, registered stack.
    expect(CHAINS.base.live).to.equal(false);
    expect(CHAINS.bnb.live).to.equal(true);
    expect(CHAINS.bnb.deployer).to.equal("0x81dd183c53C95F251869520d8DB10B0A4a4F8858");
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
      expect(read(f), `${f} must not fix a chain at module scope`).to.not.match(/^const cfg = ROBINHOOD;/m);
    }
    expect(read("src/merge/components/robinhood/RobinhoodReserveDetail.tsx")).to.include("chain = ROBINHOOD");
    expect(read("src/merge/components/robinhood/RobinhoodCreateForm.tsx"), "the launch page can only hand over a key").to.include("chainByKey(chainKey)");
  });

  it("the launch form never names the dollar, the DEX, the chain or the gas token", () => {
    const form = read("src/merge/components/robinhood/RobinhoodCreateForm.tsx");
    // Strip comments; what is left is code and copy a user can see.
    const code = form.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const word of ["Uniswap", "Robinhood Chain asset list", "paid in ETH", "in USDG"]) {
      expect(code, `"${word}" is hardcoded -- on BNB it would be wrong`).to.not.include(word);
    }
  });
});

describe("the launch chooser stays in step with the registry", () => {
  it("offers exactly the LIVE EVM chains -- flipping `live` without listing it (or vice versa) fails here", () => {
    expect(EVM_LAUNCH_OPTIONS.map((o) => o.v).sort()).to.deep.equal(LIVE_EVM_CHAINS.map((c) => c.key).sort());
  });

  it("an unoffered chain in the URL falls back to Solana instead of rendering an unshipped form", () => {
    expect(chainFromPath("/create?chain=robinhood", true)).to.equal("robinhood");
    expect(chainFromPath("/create?chain=bnb", true), "bnb is live").to.equal("bnb");
    expect(chainFromPath("/create?chain=base", true), "base is not live").to.equal("solana");
    expect(chainFromPath("/create?chain=robinhood", false)).to.equal("solana");
    expect(launchOptions(false).map((o) => o.v)).to.deep.equal(["solana"]);
    expect(pathForChain("solana")).to.equal("/create");
    expect(pathForChain("bnb")).to.equal("/create?chain=bnb");
  });
});

describe("starter assets (chains with no discovery catalogue)", () => {
  const all = Object.values(CHAINS).filter((c) => c.starterAssets);

  it("BNB carries a verified list, including the 8-decimal DOGE the probe found", () => {
    const bnb = CHAINS.bnb.starterAssets!;
    expect(bnb.length).to.be.greaterThan(5);
    expect(bnb.find((a) => a.symbol === "DOGE")?.decimals).to.equal(8);
    expect(bnb.find((a) => a.symbol === "USDC")?.decimals, "BNB's USDC is 18").to.equal(18);
  });

  it("every starter asset routes through a pool on one of ITS chain's fee tiers, quoted against a role", () => {
    for (const c of all) for (const a of c.starterAssets!) {
      expect(c.dex!.fees, `${c.key}:${a.symbol} fee ${a.pool.fee}`).to.include(a.pool.fee);
      expect(["usd", "native"]).to.include(a.pool.quote);
      expect(a.address).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(a.pool.address).to.match(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("no asset is listed twice, and the dollar is never offered as a basket asset", () => {
    for (const c of all) {
      const addrs = c.starterAssets!.map((a) => a.address.toLowerCase());
      expect(new Set(addrs).size, c.key).to.equal(addrs.length);
      expect(addrs, `${c.key} lists its own dollar`).to.not.include(c.quotes!.usd.address.toLowerCase());
    }
  });
});

describe("the read proxy serves each chain from its own upstream", () => {
  it("no chain parameter means Robinhood, so every existing request is unchanged", () => {
    expect(chainOf({ query: {} })).to.equal("robinhood");
    expect(chainOf({})).to.equal("robinhood");
  });

  it("a known chain selects its upstream; an unknown one is refused, never defaulted", () => {
    expect(chainOf({ query: { chain: "bnb" } })).to.equal("bnb");
    expect(chainOf({ query: { chain: "solana" } })).to.equal(null);
    expect(chainOf({ query: { chain: "../../etc" } })).to.equal(null);
  });

  it("each chain's keyed URL comes from its OWN env var, falling back to its own public endpoint", () => {
    const saved = process.env.BNB_RPC_URL;
    delete process.env.BNB_RPC_URL;
    expect(upstreamUrl("bnb")).to.equal(UPSTREAMS.bnb.fallback);
    process.env.BNB_RPC_URL = "https://bsc.example/key";
    expect(upstreamUrl("bnb")).to.equal("https://bsc.example/key");
    expect(upstreamUrl("robinhood"), "setting BNB's key must not leak into Robinhood").to.not.equal("https://bsc.example/key");
    process.env.BNB_RPC_URL = "http://insecure";
    expect(upstreamUrl("bnb"), "non-https is refused").to.equal(UPSTREAMS.bnb.fallback);
    if (saved === undefined) delete process.env.BNB_RPC_URL; else process.env.BNB_RPC_URL = saved;
  });

  it("every chain whose config reads through the proxy has an upstream there", () => {
    for (const c of Object.values(CHAINS)) {
      if (!c.readProxyPath) continue;
      const q = new URLSearchParams(c.readProxyPath.split("?")[1] ?? "").get("chain") ?? "robinhood";
      expect(UPSTREAMS[q], `${c.key} reads via ?chain=${q}`).to.not.equal(undefined);
    }
  });
});
