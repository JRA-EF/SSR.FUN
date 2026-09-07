<!--
  Full naming + Solscan-identifiability audit of all 23 currently-deployed
  ssr_protocol instructions. See docs/project/DECISION_LOG.md DEC-0092 for
  the decision record, and docs/protocol/INSTRUCTION_REFERENCE.md for the
  per-instruction technical reference this audit refreshed.
-->

# ssr_protocol DevNet Instruction Audit -- 2026-08-13

## Scope and headline finding

The deployed `ssr_protocol` program (`2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`) currently
serves **23 instructions**. The local source tree has a 24th (`execute_rebalance_leg`,
DEC-0077) that was never built or deployed -- confirmed during this pass to currently have a
real, pre-existing, unrelated Rust compile error (`CpiContext::new_with_signer` expects
`Pubkey`, is given `AccountInfo`) -- and is correctly out of scope here.

**No instruction was renamed.** Every one of the 23 names was already clear, unambiguous, and
used consistent "Reserve"/SSR terminology -- confirmed by reading every instruction's Rust
source, accounts struct, and doc comments in full. Zero `DTR`/`BYOR`/`BOR`/"Decentralized Token
Reserve" contamination anywhere in the program layer (one stale *comment* describing an
already-superseded terminology mapping was found and fixed in `state/reserve_asset.rs` --
comment-only, no discriminator/behavior change). This also matches CLAUDE.md's existing,
pre-established rule that Anchor instruction names are exempt from the mandatory-terminology
migration unless there is a separate, real reason to touch them -- there wasn't one.

The actual reason Solscan may not have been decoding this program's instructions was **not
naming** -- it was that **no Anchor IDL had ever been published on-chain** for it
(`anchor idl fetch`/`program-metadata fetch` both returned nothing beforehand). That is fixed by
this pass (see "IDL publication" below).

## Current-name -> proposed-name mapping

| # | Current name | Proposed name |
|---|---|---|
| 1-23 | (all 23 instructions below) | **No change** -- see headline finding above |

No discriminator-changing rename was applied. No program rebuild or DevNet redeploy of
`ssr_protocol` was required or performed. Mainnet was not touched (SSR.fun has no Mainnet
deployment at all yet -- this program has only ever existed on DevNet).

## IDL publication

The committed IDL (`packages/sdk/idl/ssr_protocol.json`) was published on-chain via the
[Solana Program Metadata](https://github.com/solana-program/program-metadata) standard
(`program-metadata write idl`), signed by the program's real upgrade authority
(`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, confirmed via `solana program show`). The
on-chain copy was independently re-fetched afterward and diffed byte-for-byte identical (as
JSON) against the repo copy. Metadata account: `2691ZrDFyiRB9pZU4Hr2NvyMnQTstm9tmPtqmaNAFV9v`
(PDA, seed `"idl"`).

`anchor idl init`/`anchor idl fetch` themselves do not work in this native-Windows environment
-- their underlying implementation shells out via Rust's `Command::new("npx")`, which fails on
Windows because there is only `npx.cmd`, not `npx.exe` (a known Rust-on-Windows limitation,
unrelated to this program). Worked around by invoking the same underlying
`@solana-program/program-metadata` CLI directly.

Separately confirmed (via `sha256("global:<name>")`, Anchor's own deterministic discriminator
scheme -- no build required): **all 23 discriminators in the committed IDL are mathematically
correct for their instruction names**, the SDK (`packages/sdk/src/readOnly.ts`) statically
imports this exact IDL file, and the deployed program's data length (647,608 bytes, confirmed
via `solana program show`) is byte-identical to the last recorded `ssr_protocol` deploy
(DEC-0048) -- i.e. nothing has been deployed since, and the source now matches what's live.

## Solscan decoding

Solscan's transaction pages are gated behind an interactive Cloudflare "Verify you are human"
checkbox (Turnstile) -- confirmed live, screenshot on file. This is a legitimate anti-automation
measure; it was not (and should not be) scripted around. **Programmatic visual confirmation of
Solscan's own rendered UI was not possible in this environment.**

What *was* independently confirmed, for every signature below, via `solana confirm -v
<signature>` (official Solana CLI, not Solscan): the exact `Program log: Instruction: <Name>`
line Anchor's `#[program]` macro always emits at runtime, regardless of whether an IDL is
published anywhere. This is the same source Solscan (and every other Solana explorer) uses to
label an instruction by name in its UI -- so the instruction *name* was very likely already
decoding correctly on Solscan even before this pass. What the newly-published on-chain IDL adds
is decoded **account labels and argument values** within each instruction's detail view (e.g.
"reserve: `<addr>`, co-manager: `<addr>`" and parsed args like "targetWeightBps: 5000" instead of
raw hex/base58 blobs) -- that part could not be visually re-confirmed here for the same
Cloudflare reason.

**Action needed from you:** open any of the Solscan links in the checklist below (they all
already carry `?cluster=devnet`) in a real browser and click through the one-time human
verification once. If the instruction name and decoded accounts/args render correctly there
(expected, per the evidence above), no Solscan-side support ticket or program-verification
submission is needed. If Solscan still does not decode it after that, see "If Solscan support
is needed" below for exactly what to submit.

## Full audit table (all 23 instructions)

| Protocol instruction (Rust) | IDL name | Frontend action | Discriminator match | DevNet tx signature | Solscan decoding | Remaining blocker |
|---|---|---|---|---|---|---|
| `initialize_protocol` | `initialize_protocol` | None (one-time genesis, already run) | ✅ verified | [`3CRguz...3NR8p`](https://solscan.io/tx/3CRguzydZnvz685c9TXP91s8Z7Xck7fxUmJm476wMZRHqXL7JyJGGjtGHEVJ1EB2nYJ8HD1wskAZNbdiFX93NR8p?cluster=devnet) *(historical -- oldest tx on the ProtocolConfig PDA)* | Log-confirmed (`InitializeProtocol`) | Cannot be safely re-run (`init` -- would fail "already in use"); manual Solscan click-through still recommended |
| `create_reserve` | `create_reserve` | "Launch a Reserve", Step 1/2 | ✅ verified | [`3gcbLA...VMCYr`](https://solscan.io/tx/3gcbLAPCUs58iWWe8WJaL7mzieser293kRVNz9xSTkWF8bVVKChJ3RSbMX72eX8t6ZjsCX122HNvufTFbh8VMCYr?cluster=devnet) | Log-confirmed (`CreateReserve`) | Manual Solscan click-through recommended |
| `initialize_reserve_asset` | `initialize_reserve_asset` | "Launch a Reserve", Step 1/2 (one call per asset) | ✅ verified | same tx as `create_reserve` (2 calls batched in it) | Log-confirmed (`InitializeReserveAsset` x2) | Manual Solscan click-through recommended |
| `seed_reserve` | `seed_reserve` | "Launch a Reserve", Step 2/2 | ✅ verified | [`JUoPZ8...WYLu`](https://solscan.io/tx/JUoPZ8YQTfpqCSrraYG31Tm2xuhdwzvGDEmVD6odXZvbsp22gYgouzJ2sEjG4nP8o7Y6dmkYG2quPmWcUXTWYLu?cluster=devnet) | Log-confirmed (`SeedReserve`) | Manual Solscan click-through recommended |
| `mint_reserve_tokens_in_kind` | `mint_reserve_tokens_in_kind` | "Buy" tab (Reserve-detail page) | ✅ verified | [`28ZJdW...BKNw`](https://solscan.io/tx/28ZJdWnnGkUVrHC9rDSByY7mCFKCCjWXEffkkDj9VPAxFv7RRtkU1rZczTwmgSuTbshjRmiry7cSB8eR6HB4BKNw?cluster=devnet) | Log-confirmed (`MintReserveTokensInKind`) | Manual Solscan click-through recommended |
| `redeem_reserve_tokens_in_kind` | `redeem_reserve_tokens_in_kind` | "Sell" tab (Reserve-detail page) | ✅ verified | [`4WkJmZ...DnE2`](https://solscan.io/tx/4WkJmZHYsDD434QD4r3jmc5eLSFomQocgBVfTAKxtqzUYSF5yf7qHU6dPfSA1WoN6esy1KZGKZ5FvRBLCcMsDnE2?cluster=devnet) | Log-confirmed (`RedeemReserveTokensInKind`) | Manual Solscan click-through recommended |
| `update_targets` | `update_targets` | Manage -> Rebalance, "Submit Rebalance" | ✅ verified | [`4sacuh...7P56`](https://solscan.io/tx/4sacuho1MRo5Xk5LtGYKQWiFtAqjCH3DZBvFRpskwwHvxs3MkUzGwJTDfyb1yr4Kh9VwPxA3kgvwAFjf2RW87P56?cluster=devnet) | Log-confirmed (`UpdateTargets`) | Manual Solscan click-through recommended |
| `add_delegate` | `add_delegate` | Manage -> Co-Managers, "Grant Delegate" | ✅ verified | [`5zGpnR...vUAjq`](https://solscan.io/tx/5zGpnRULoNDdzjZG7gGPkA8nc3XzQ3BNguc1yF3JM6evDT3LHuJk6TaNZyqtiagwhhNhfcziobKbSKWSRnsvUAjq?cluster=devnet) | Log-confirmed (`AddDelegate`) | Manual Solscan click-through recommended |
| `update_delegate_permissions` | `update_delegate_permissions` | Manage -> Co-Managers, "Update permissions for {co-manager}" | ✅ verified | [`55tf1D...HAJrTB`](https://solscan.io/tx/55tf1DVLvD8hxfy9ZkxTugZYRmpTbWRe6b5bpPrTk8KPCC1j62NipVtX98Ba4WFVa51UVLmcEaHQsUChEBHAJrTB?cluster=devnet) | Log-confirmed (`UpdateDelegatePermissions`) | Manual Solscan click-through recommended |
| `remove_delegate` | `remove_delegate` | Manage -> Co-Managers, "Remove co-manager {co-manager}" | ✅ verified | [`3m48ky...KzPoX5`](https://solscan.io/tx/3m48kyBR4rtAHfcmotsi2N8cvk4kyuoicq8mhAJ4nLzxGBr1nhmkDCJLApTiDF15owkzbcU38hMHorUhPKKzPoX5?cluster=devnet) | Log-confirmed (`RemoveDelegate`) | Manual Solscan click-through recommended |
| `add_reserve_asset_active` | `add_reserve_asset_active` | Manage -> Rebalance, "Submit Rebalance" (new asset) | ✅ verified | [`mwmuqa...JcEJDK`](https://solscan.io/tx/mwmuqaHZuvFqW2keqKCp1TYfbW9fvCAARWtviLx4t78WvvZARsJHLLtg9bLT98sxiyuueU9dJR4hG8ghJ8cEJDK?cluster=devnet) | Log-confirmed (`AddReserveAssetActive`) | Manual Solscan click-through recommended |
| `fund_new_reserve_asset` | `fund_new_reserve_asset` | Manage -> Rebalance, "Fund {symbol}" | ✅ verified | [`pkaNBS...VTh6njYDsr`](https://solscan.io/tx/pkaNBSJ9HCH5Tq71EsopuK6Lqdq4asZ3L2UYZKnEPbg3NLzXxeqrUWqT7591N2iWzHHxLPUXFJmxjVTh6njYDsr?cluster=devnet) | Log-confirmed (`FundNewReserveAsset`) | Manual Solscan click-through recommended |
| `remove_reserve_asset` | `remove_reserve_asset` | Manage -> Rebalance, "Remove {symbol}" | ✅ verified | [`4WZW7u...enYxFU4`](https://solscan.io/tx/4WZW7u8uYHX42AfgGcUhr51MW55Shx98YxQfmCqr6rCB9Y4p3nvRGyW6RXvDzc6bakzCa1gMKYuHBKrJjenYxFU4?cluster=devnet) | Log-confirmed (`RemoveReserveAsset`) | Manual Solscan click-through recommended |
| `update_metadata` | `update_metadata` | None currently wired (no "edit Reserve" UI feature yet) | ✅ verified | [`2wTsdc...dxTFT`](https://solscan.io/tx/2wTsdcy9H3nmAKE31iPBsLM4P4a9s3TQqK8G9o3gLrKXWP2zhMCJf4L1NmJ7bck1FWWMExrT4vGrLxgQLwKdxTFT?cluster=devnet) | Log-confirmed (`UpdateMetadata`) | Product gap (no UI), not a naming/decoding issue |
| `transfer_reserve_manager` | `transfer_reserve_manager` | None currently wired | ✅ verified | [`4tLM5T...t1V4T`](https://solscan.io/tx/4tLM5ToxunYWKaZKxMuezd2NfSmzkwmRTTzzfM2rDBerxv7CHumetK48TB2xCRYLsNJaWd7rjUJZr6Le7Lgt1V4T?cluster=devnet) | Log-confirmed (`TransferReserveManager`) | Product gap (no UI -- deliberately rare/high-friction action), not a naming/decoding issue |
| `pause_reserve` | `pause_reserve` | None (removed from UI, DEC-0086); `scripts/devnet_fixtures.ts` only | ✅ verified | [`YcZv4K...XkthoG`](https://solscan.io/tx/YcZv4KunvJKyoU64fcd1K8LB3xHHKFiBgFs8zBrhZKo8c6CPDAmopPquXGvS8WqPNt169RnaDYSVoETPjXkthoG?cluster=devnet) | Log-confirmed (`PauseReserve`) | Deliberate product decision (DEC-0086), not a naming/decoding issue |
| `unpause_reserve` | `unpause_reserve` | None (removed from UI, DEC-0086); `scripts/devnet_fixtures.ts` only | ✅ verified | [`2yLnBV...ZSL28HfCTXm1Z`](https://solscan.io/tx/2yLnBVihfNMp3n63mcZ339S8oPPK4kXvVab6DvzQgBbQDSSPqqREu3byysHvcLKxcktKzUoC9FRZSL28HfCTXm1Z?cluster=devnet) | Log-confirmed (`UnpauseReserve`) | Deliberate product decision (DEC-0086), not a naming/decoding issue |
| `accrue_fees` | `accrue_fees` | None currently wired (permissionless TVL-fee checkpoint) | ✅ verified | [`5KDijM...q7dhzKj`](https://solscan.io/tx/5KDijMmTMKeDJg3wLH1cZijWxJjbTUCXzVpku7bRDdnM2XXrhjyFSjGhrSwbrqtokcoqytd4AJeDmEvXWq7dhzKj?cluster=devnet) | Log-confirmed (`AccrueFees`) | Product gap (never wired anywhere), not a naming/decoding issue |
| `collect_fees` | `collect_fees` | Manage -> Overview, "Collect Fees" | ✅ verified | [`4Pv3wo...udgBDH`](https://solscan.io/tx/4Pv3woh3TxWPqbsgbmorD9ryvfw2aUHvL6EbAqnNevLp8yNMpftKDn41NuwdXWZdNCcCwvfV3MHVPcmMXuudgBDH?cluster=devnet) | Log-confirmed (`CollectFees`) | Manual Solscan click-through recommended |
| `record_rebalance` | `record_rebalance` | None currently wired (superseded by the `update_targets`-only Submit Rebalance flow) | ✅ verified | [`5JAuZg...GjCy81Z`](https://solscan.io/tx/5JAuZgMM1cbDDHXnE2zS6H9UoLXHmxTtGpsBiP461tG8emdTca9SrZhVgqaaBNs4pR256T5qj3x59oUyGGjCy81Z?cluster=devnet) | Log-confirmed (`RecordRebalance`) | Product gap (superseded design), not a naming/decoding issue |
| `initiate_wind_down` | `initiate_wind_down` | Manage -> Overview, "Initiate Wind Down" | ✅ verified | [`4bXmQn...16dD`](https://solscan.io/tx/4bXmQnXa5Hj87ffK48p4YxVC6bLo2CKjxfLdd4fUDgCo7X7Tbm9j41uXUhQUriXCu12HTPHck6Y2tHpV7Wy16dD?cluster=devnet) | Log-confirmed (`InitiateWindDown`) | Manual Solscan click-through recommended |
| `close_reserve` | `close_reserve` | Manage -> Overview, "Close Reserve" | ✅ verified | [`4wpRnu...oEd4WDGSr`](https://solscan.io/tx/4wpRnu4ZE2ihvBycgZ7kwAKJThuunA6Jg3FkS3mpD2zqkT3pyZ1Dg3XjfsiPMsGtcRJE9z6cWVcSz7hoEd4WDGSr?cluster=devnet) *(historical -- DEC-0048)* | Log-confirmed (`CloseReserve`) | See "Test-Reserve close_reserve note" below |
| `update_protocol_config` | `update_protocol_config` | None currently wired (admin-only; product decision, not a gap) | ✅ verified | [`2cEtFT...Bexw9Ww`](https://solscan.io/tx/2cEtFTEPa5qiEWdPWZ16bTVdQaDZ7XyhUK6zjJpwUKkLvKYwwE8fD11gseoyZHgVRvRthD1d6spzy8VaYRZGcmTC?cluster=devnet) *(historical -- DEC-0035)* | Log-confirmed (`UpdateProtocolConfig`) | Deliberately not re-touched (shared, already-correct protocol-wide singleton) |

## Test-Reserve `close_reserve` note

This pass's own disposable test Reserve (`HN5gWeNKV22G52DjhbkJnk1pSrQNxoVx6f7UornjkJEW`) could
not be closed: `collect_fees` correctly minted a real, non-zero protocol-fee-share (250 raw
units) to `ProtocolConfig.default_protocol_fee_destination`
(`EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`) -- an account this session does not hold the
signing key for. `close_reserve` correctly refused (`ReserveTokenSupplyNotZero`) since that
balance can never be redeemed by anyone other than that account's owner. The test Reserve is
therefore left permanently open on DevNet, harmless and documented -- the same
"genuine on-chain side effect from real verification" pattern already established elsewhere in
this project (e.g. `reserveOne`'s permanent 3rd asset from DEC-0048). `close_reserve` itself was
still confirmed correct and Solscan-identifiable via DEC-0048's existing signature above.

## If Solscan support is needed

If, after clicking through Solscan's Turnstile once, the instruction names or account/argument
details still don't decode:

- **Program ID:** `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` (DevNet)
- **IDL:** now published on-chain via the Solana Program Metadata standard at metadata PDA
  `2691ZrDFyiRB9pZU4Hr2NvyMnQTstm9tmPtqmaNAFV9v` (seed `"idl"`), independently verified to match
  `packages/sdk/idl/ssr_protocol.json` byte-for-byte.
- **Anchor version:** `anchor-lang`/`anchor-spl` 1.1.2.
- **Program name:** `ssr_protocol` (per the IDL's `metadata.name`).
- This is a DevNet-only program; there is nothing to submit for Mainnet.

Per the task's explicit instruction, no memo was added to any transaction purely to compensate
for IDL/IDs -- the IDL publish is the real fix, and none of the exercised transactions needed
extra context a memo would add.
