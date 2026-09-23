# Upgrade buffer: Token-2022 rules by configuration

Ready for Squads execution. Nothing is live until the upgrade is executed.

| | |
| --- | --- |
| Buffer | `HaqBRFk62yP5WBFtHBKrwtk9rL6c1uay17RZVDQbHCff` |
| Buffer authority | `HFmqpPVVdMRcwaSKkbxLNga8byBJb3LK1FsURsDQqYoW` (the Squads vault) |
| Program | `8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9` |
| New size | 955,384 bytes (currently deployed: 1,099,592) |
| sha256 of the artifact | `075f17b2416dea09278e87f88bac412c32d9aaaf55e75d9ec851d2470b2614f2` |
| Built with | `cargo-build-sbf --arch v0`, zero stack-frame warnings |
| Buffer rent | 4.854 SOL, paid by `ssr-deploy` (52b7…7ERa), refunded to the upgrade authority on execution |

`--arch v0` matters: the 2026-09 brick was an `anchor build` artifact whose
newer SBF arch produced 1,099,592 bytes with stack-frame overflows, and every
instruction then failed at 44 CU. This build is the smaller, clean one.

## What changes

`validate_asset_mint_extensions` judges a Token-2022 mint by what its
extensions are CONFIGURED to do, not by which types are present:

- transfer hook: allowed when no hook program is set (nothing runs);
- transfer fee: allowed below 100%, and every deposit is grossed up
  (`gross_up_for_transfer_fee`) so the vault still receives the full pro-rata
  amount and the depositor pays their own fee;
- permanent delegate: allowed only for `APPROVED_PERMANENT_DELEGATES`
  (currently xStocks' single delegate, which covers all 1,025 of their mints);
- confidential transfers: allowed while new accounts are not auto-approved;
- non-transferable: still always refused.

Effect measured across the 1,732 Token-2022 mints in the catalogue: 1,618
holdable, 114 blocked (71 unapproved delegate, 42 transfer fee at 100% or
otherwise unhandled, 1 real hook).

## Verified before staging this buffer

Local validator, real mainnet mints cloned, real signed transactions:
TSLAx, NVDAx, PUMP, USDC accepted; ANDURIL rejected with
`UnsupportedMintExtension`.

Devnet, real deployment (`AkWeVonLiSVwQMydWmhWWxBnREKfagAuEzvCYoQVkeqL`), mints
built to replicate the mainnet configurations including xStocks' real delegate:
approved-delegate and 1%-fee mints accepted; unapproved-delegate and 100%-fee
mints rejected; classic SPL accepted.

Full lifecycle on a 1% fee mint, on BOTH nets, identical results:

    seed_reserve lands the full amount        vault 1000000 of 1000000
    mint in-kind: vault receives the deposit  +500000 (without gross-up: 495000)
    mint in-kind: depositor pays the fee      debited 505051 for 500000
    redeem: vault debited pro-rata            -375000, pro-rata 375000
    redeem: redeemer receives minus the fee   371250 of 375000 (1.00% withheld)

Repeatable: `scripts/verify_mint_extensions_local.ts`,
`scripts/verify_mint_rules_devnet.ts`, `scripts/verify_fee_mint_lifecycle.ts`.

## Not covered

Rebalance legs have not been executed with these assets.
`execute_rebalance_leg` measures balance deltas rather than trusting amounts,
so a fee is handled there by construction, but it has not been run.

## Order of operations

1. Execute the upgrade in Squads against the buffer above.
2. Only then ship the client: `packages/sdk/src/mintExtensions.ts` is already
   permissive, so releasing it first would offer assets the deployed program
   still refuses -- the PUMP failure in reverse.
3. Re-run the catalogue scan so `ssr_status` flips for the newly holdable
   mints (`markIncompatibleMints`).

## On a redemption

On a fee-bearing asset a redeemer receives their pro-rata share MINUS the
mint's transfer fee -- their own transfer, their own fee. Grossing that up
would take the difference from the remaining holders. It must be disclosed in
the UI before anyone redeems; `assessMint` already returns the sentence.
