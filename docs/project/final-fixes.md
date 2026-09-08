# Final fixes -- closed-Mainnet function checklist, worked to green

Working list for the 11 Mainnet function checks on `/road-to-mainnet` (Mainnet tab).
One block per check; every clause of its criterion is a checkbox with the exact
on-chain evidence that closes it. The database rows on the page (`rtm_controls`)
mirror this file -- update both. Program `8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9`
(DEC-0173 build, slot 445241220). Prod = ssr.fun, dev = strategic-super-reserve.fun.

Legend: `[x]` proven with a real Mainnet signature · `[ ]` open · `[~]` partial / by simulation only.

---

## MCR-01 Create Reserve -- **Passed** (closed 2026-09-08)

Criterion clauses:

- [x] **Authorized wallet creates a Reserve with valid metadata, fees, authorities through the live site.**
  21 Reserves on Mainnet by 2 real wallets. Latest: CYhMBkEL... (3-asset GOLF) by `6BjTPAWG...`:
  create + 3x initialize_reserve_asset + manager fee recipients
  `5xaioqvvb4xo3qr3SGXZ83jT8QK47E1o7Nc43QnhuUA4ua5ZEdAznZqPJgrX6194CkPeGfAA3ciHuVr3GTcJEcmj` (2026-09-07 14:55:17Z),
  seed `2J8MewzAL9Kn1ybvSVPwFDo7cTWTZSAT3APh45p31TD2sxW6AsJeKAJwLMbheYMD4kNoL23yMwpnMypVxAPH9gbK` (14:55:49Z).
- [x] **Initial balances, Reserve Token supply and starting NAV match the documented formula exactly.**
  From the seed tx's token deltas: vaults received 5.578475 RAY + 26.836667 JUP + 0.0056073 ZEC
  (three ~$6.67 legs of a $20 seed). Gross seed = floor($20) = 20.000000 tokens;
  effective mint fee 1.00% -> fee = ceil(20 x 1%) = 0.200000; net to manager = **19.800000**
  (on-chain: +19,800,000 raw to `6BjTPAWG...`); fee split 50/50 -> **0.100000 protocol** minted
  straight to the Treasury vault `3CBpVMPD...` (+100,000 raw, on-chain) + 0.100000 manager pending
  (managerFeeShareAccrued event). Starting NAV = $20 / 20 = **$1.00 per token** by construction.
  Every figure matches `estimateNetSeedReserveTokens` / `split_configured_bps` / `split_total_fee`.
- [x] **Invalid input is rejected with no partial state created.** Two deliberately invalid creations
  submitted for real on Mainnet (preflight skipped so the rejection is recorded on-chain), signed by the
  developer wallet `52b7pBNF...`:
  - A) `create_reserve` with `mintFeeBps = 600` (on-chain max 500):
    `2iGfD6McD9SsQNTP2qgzBMxVc2mhUVAKoqamuvGcm2oZQu5sWsCt7iwwnMzyTqHffNMnnLRWY3n5MVXGrWkQuW1`
    -> FAILED, custom error 6036 `FeeExceedsMaximum` (create_reserve.rs:88).
  - B) a VALID `create_reserve` + `initialize_reserve_asset` with weight 15,000 bps (> 100%) in ONE atomic tx:
    `2TiZ5bkQ6Z1fe2kerLfGTQHADSSfuN1nvpTxRJVKGUGeMLkc1mDRgkpMqU4uhSvRGBiA9BCdQhTEmAugWfnvTPBi`
    -> FAILED at instruction 1, custom error 6008 `TargetWeightExceedsTotal` (initialize_reserve_asset.rs:78);
    because the tx is atomic the valid create in instruction 0 was rolled back too.
  - Proof of no partial state: the would-be Reserve PDA `B5VQi9GyZRPZcvBUMuKaVbwfbLQstHHM8kyShKxUkqEm`
    (reserve id 21) does not exist and `ProtocolConfig.reserveCount` is still 21 after both.
  - Read-only simulation also confirmed `MetadataUriTooLong` (6000) for a 316-char URI.
  - The live site's client validation refuses to submit any of these in the first place (weights must total
    100%, fee sliders are capped), so these on-chain rejections are the second, independent line.
- [x] **Non-authorized wallet cannot create one** -- N/A by design: Reserve creation is permissionless
  (any wallet may create); the authority checks that matter are on manage/rebalance/pause, covered by MDL-01/MPU-01.

---

## MMT-01 Mint (Buy) -- **Partial**
- [x] Depositor USDC / Reserve Token balances change by the expected amounts; supply + AUM grow proportionately.
  10 mints by 4 wallets; latest `HniecHQPqEN8x2BJF2mBHcgCtVHnEDWNoufq1fJFEGkEwFv8AN7vZnE3dTPNJpynuWishmMQqfUE68NRaZWGPjB` (19,738,082 raw after 3 same-slot swaps).
- [x] Mint fee charged at the configured rate. Same tx credited the fee vault 99,688 protocol / 99,687 manager units.
- [ ] Fee reaches the Squads Treasury vault -- now delivered as USDC by the keeper; **blocked on `set_fee_settlement_keeper`** (Creator/Boss, `/internal/set-keeper`).
- [ ] Minimum / zero / dust amounts cannot mint zero value.

## MRD-01 Redeem (Sell) -- **Partial**
- [x] Pro-rata payout to the redeemer's own wallet; supply/AUM decrease. 6 redemptions; latest `4FnsRvf7Pr82Vam36hknVrn6QW61bukbQbrv4mkKKk1d5X6L8cCune8UqAhZ38BCfqB5iCHJbyFvLdkFx3jRLatb`.
- [ ] Redemption fee reaches the Treasury -- since the 2026-09-08 upgrade it is re-minted into the fee vault; **no post-upgrade redemption recorded yet**.
- [ ] Minimum / zero / dust redemptions cannot strand or leak value.

## MAR-01 Add Reserve asset -- **Partial** (scope note on the page is outdated: multi-asset Reserves exist)
- [x] add_reserve_asset_active: `3iAMCcqiCbqsX7Fe3XMQTiyFQw4JKoCjszx6EodsosENeVcXXwhKUcvqZeuaJTEcFYChXYW5FFp24gYXAnuTJgY6` (manager `6BjTPAWG...`, H7NDKmf9...).
- [ ] fund_new_reserve_asset.
- [ ] Unauthorized wallet rejected.

## MRR-01 Remove Reserve asset -- **Not tested**
- [ ] remove_reserve_asset on an empty asset. - [ ] Unauthorized wallet rejected.

## MRB-01 Rebalance -- **Partial**
- [x] update_targets: same tx `3iAMCcqi...` (BpdH...=0 bps, EPjF...=10000 bps).
- [ ] record_rebalance / execute_rebalance_leg actually move holdings. - [ ] Unauthorized wallet rejected.

## MDL-01 Co-managers & authority -- **Partial**
- [x] add_delegate within permission bounds: 13 adds; latest `4yW1zegQJg14fKEjhWeSjU7DAdE2SRZnwqPtireW99ZCGgCUrBoKeAToPSwQuD4x9eXmTpmpyUy2yzkRRfJnwDXs` (EME96..., restricted).
- [x] Two-admin ProtocolConfig: authority `CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8`, admin_2 `PSpQGPvw7tZedKJvN21dJkh3vdDQeXkwA5n9DKBRZw5` (read on-chain 2026-09-08).
- [ ] update_delegate_permissions. - [ ] remove_delegate takes effect immediately. - [ ] transfer_reserve_manager from a non-manager rejected. - [ ] co-manager acting outside role/limits/expiry rejected.

## MPU-01 Pause / Unpause -- **Not tested** (DEC-0115 script evidence exists but the criterion excludes scripts)
- [ ] pause_reserve from an admin wallet blocks a Buy. - [ ] unpause resumes. - [ ] set_protocol_paused. - [ ] non-admin rejected.

## MFE-01 Fees & protocol config -- **Blocked** (one Creator/Boss signature)
- [x] accrue_fees runs on Mainnet: hourly keeper (`AuaJRdbR...`), first run 2026-09-08 00:15 UTC.
- [x] Fees crystallize into the fee vault at the configured rate (HniecHQ... above).
- [ ] USDC reaches the Treasury vault `3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5` and manager recipients -- **blocked on `set_fee_settlement_keeper`**.
- [ ] update_protocol_config by an admin; non-admin rejected. - [x] update_metadata by the Reserve manager: `5hTcsyWAZZyWPrBrSmHQi8y453kC1fKVAQoHbei8NK66d9uXU3CP6vunD7pNjkyrNuUSSTTdDedL3h4hDuVhzsmX`.

## MWD-01 Wind-down / Closure -- **Not tested** (by design; needs a disposable test Reserve)
- [ ] initiate_wind_down. - [ ] redeem out. - [ ] close_reserve.

## MSC-01 Security review by a non-builder -- **Not tested**
- [ ] Reviewer + date per function above.
