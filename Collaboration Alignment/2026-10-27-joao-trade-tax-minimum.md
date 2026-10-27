# Trade tax: on-chain 0.15% minimum (Mainnet upgrade)

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `fix/trade-tax-min-guard`, rebased onto and merged into `main`
- **Deployed to:** Mainnet program, Squads #18, slot 462115394, sha256 5fa3ec1e...7283. No frontend deploy (no app change).
- **Decision log:** DEC-0268

## What shipped
- **`enable_trade_tax` refuses a tax under 0.15%.** It also refuses any combined rate at or under the 0.25% ceiling. Taxes of 0.05% and 0.10% were invisible to the guards on `collect_transfer_fees` / `update_transfer_fee`.
- **Buys and sells were verified against the pre-upgrade live binary first.** The test used the real Raydium CPMM program in LiteSVM (`tools/rebalance-litesvm/src/raydium_tax.rs`). Both charge 0.15% for the first two epochs and the protocol rate plus the tax after that. The collect split matches the formula exactly.
- **The program space was extended by 10,240 bytes.** That is the Mainnet minimum per extension; the build only needed 200.

## Effect on others: READ THIS
- **No IDL, SDK or app change.** Error codes are unchanged.
- **To rerun the Raydium test,** run `node tools/rebalance-litesvm/fetch_raydium_fixtures.mjs` first. It writes to `fixtures/`, which is git-ignored. `SSR_PROGRAM_SO` runs the suite against any binary.
- **Still open:** the epoch-split (fees from the 0.15% period collected after the switch are split as taxed). It is small and deferred.
