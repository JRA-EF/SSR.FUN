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

## MMT-01 Mint (Buy) -- **Passed** (closed 2026-09-08; the USDC payout of the fee is tracked under MFE-01)
- [x] Depositor USDC / Reserve Token balances change by the expected amounts; supply + AUM grow proportionately.
  10 mints by 4 wallets; latest `HniecHQPqEN8x2BJF2mBHcgCtVHnEDWNoufq1fJFEGkEwFv8AN7vZnE3dTPNJpynuWishmMQqfUE68NRaZWGPjB` (19,738,082 raw after 3 same-slot swaps).
  Plus on the disposable test Reserve #21: `zWEGK8i1xYsuJ4knvMrAiN1CKxw53Z3m6mgEibwQiVMyDiYx2q5Lke2jb2zbs4btWnbHiZUWGDECCnwiCY592SP` -- 100,000 raw requested, supply 2,000,000 -> 2,100,000, fee vault 20,000 -> 21,000 (ceil(1%) = 1,000 = 500 protocol + 500 manager).
- [x] Mint fee charged at the configured rate. Same tx credited the fee vault 99,688 protocol / 99,687 manager units.
- [x] Fee crystallizes into the fee vault for USDC delivery (design since Tier B). The Treasury USDC leg itself is MFE-01's open clause (`set_fee_settlement_keeper`), not a mint defect.
- [x] **Zero / dust amounts cannot mint zero value or leak value** (real Mainnet rejections, developer wallet, test Reserve #21):
  - `reserve_tokens_requested = 0` -> `2x3LsZ95PCDto3iitCvNciCSKRYi5k8QTpqhCqDaq3bWRgVSr2qf6KS86mX6yz989zC2zPP2hkXEfG3f7NSXHyNb` FAILED custom 6001 `ZeroValue` (mint_reserve_tokens_in_kind.rs:124).
  - `reserve_tokens_requested = 1` raw (dust) -> `6acN83RaoTgZDDbWdcp4REmEGeLDNmRf7Bpn5p5x52q11aYTVGd6yqm7TM9JaHaNou7UYhMcguTAkBC9Qnv2vri` FAILED custom 6024 `ZeroAmountAfterFeesOrRounding` (mint...rs:202); supply unchanged at 2,100,000.
  - Mint while the Reserve is PAUSED -> `5MgaHqPULq62y5mjBshrzQ9EL3NWJa4frZLDP7kh9TLv3LpZm5njkYCuz7Tj3vELupAuG2P8kUeHKTouup8rAuKL` FAILED 6010 `UnexpectedReserveStatus`; on a WindDown Reserve -> `23KKzHwswkzijJrHcCz2g2QnVFT6W51p8MwGeHVZiQroenktZbvaUvJMVivVLp2Lwd93iwdxndqevAbK4deQ3stE` FAILED 6010.

## MRD-01 Redeem (Sell) -- **Passed** (closed 2026-09-08)
- [x] **Post-upgrade redemption through the site's own build path (`/api/mainnet/build-sell`), real wallet, real USDC.**
  Developer wallet `52b7pBNF...` sold 0.200000 tokens of Reserve 8 (`52eHitfwh7sPNnF9Ft8YHBd4EqY6TkjygVfCEhVdxw9y`, 4 assets):
  redeem `44EVEVHT8x9yowbdxLoPxfgK9DcV81nSRR3J9Sc73bKMJuc5xQSvZGZWvZh67LdxH2gSnURVz9TYEQnZ3fiojdLX`, then four swaps
  `4VWCFvCNMzmRVZXKuuiR5nW5MyiBJizpMhZHDkNVJGLuznpRZuNjYeR5M54fStNvV8HAffapNke1c8bRbS67x27n` (wSOL),
  `2WEr4LydoGx9FpnpyfKtsqMPiHhaAwsJZGVk8wQY89aBCWtjVgjk8yYRQyhe4bQjMtBJcswTjEJb5b7ETBKzY28h`,
  `23jXLG9PKCyLUf7pdcV52zsYpnMuhVtEuksoUyBDjehxteSnEHKvs4YF91iN2eXN2s2iErvYGRA42b14tV8DqsgJ`,
  `3oSFzDzfXYAPD32bVx4nrgjGMBzD5d1CXScHsMREKBupAgyYsaDwvJZqwsxoJmZj6e1RKrUssunKzpBLAYzmH4RG`, all confirmed.
  Server build 1.5 s (reads 746 ms, quotes 124 ms, build 629 ms).
- [x] **Redeemer balance down by exactly the amount; supply down proportionately; payout to the redeemer's own wallet.**
  Wallet Reserve Tokens 879,552 -> 679,552 (-200,000); supply 13,508,705 -> 13,308,705 (-200,000); USDC 5.829173 -> 6.897610
  (**+1.068437 USDC** vs 1.068560 quoted, 99.99%); every asset leg paid into the redeemer's own ATAs.
- [x] **Pro-rata amounts exact.** From the redeem tx's token deltas, each leg == floor(200,000 x vault / 13,508,705):
  wSOL 2,513,763 (vault 169,788,421) · 9BB6...pump 289,227 (vault 19,535,450) · 6GmA...UNgx 5,025,608,330 (vault 339,447,301,888) · 6Nwar... 3,625,792 (vault 244,898,778) -- all MATCH.
- [x] **NAV unchanged by a fair redemption**: burn and payout are both exactly pro-rata (above), so AUM/supply is invariant by construction; the fee vault was untouched (21,952 before and after).
- [x] **Redemption fee handling -- exercised with a NONZERO fee on the disposable test Reserve #21 (50 bps).**
  `4Sp4Cc1sHFp47acAr3ZD8dWumLiotCNHioSxV6hXEceXVtoj9ukxMb5qvsHsXztSrfhSbcAe9EPhj9xghHeeZctT`: redeemed 100,000 raw;
  fee vault 21,000 -> 21,500 (**+500 == ceil(100,000 x 50 bps)**), supply 2,100,000 -> 2,000,500 (burn 100,000, fee re-minted 500),
  FeeSettlement protocol share 10,500 -> 11,000 (per `split_redemption_bps`: the protocol floor equals the whole 50 bps, so the manager share is 0),
  two events in the tx (RedemptionFee credit + redeem). Per-asset payouts == the SDK's entitlements exactly: USDC 49,750 / JUP 217,227 / wSOL 4,738.
  Every other live Reserve is configured with `redemption_fee_bps = 0` (Reserves 7, 8, 13, 16, 18 checked), so on those no fee is owed and none taken.
- [x] **Zero / dust amounts cannot strand or leak value.** Two independent guards, both exercised:
  the SDK/site refuses a zero redemption before it is ever signed (`computeRedemptionEntitlements: fee consumes the entire redeemed amount`),
  and the program rejects it on-chain -- a valid redeem instruction with its amount field patched to 0 was submitted for real
  (preflight skipped): `2XfJPMdb59VPJCrZnfAKFXDhVWqzypSnkGXxPFq2jXW4piHAKu5Gtak9wpF3EU11fhSqdvrTs6YkXCTf1cQd7Zvv`
  FAILED custom 6001 `ZeroValue` (redeem_reserve_tokens_in_kind.rs:143); wallet balance 679,552 before and after. Dust is bounded the same way: each leg is floor(amount x vault / supply), so a redemption too small to earn one raw unit of an asset simply pays 0 of that asset while burning the tokens -- the client shows the exact per-asset payout before signing.

> **Disposable test Reserve #21 used below** (DEC-0193): `B5VQi9GyZRPZcvBUMuKaVbwfbLQstHHM8kyShKxUkqEm`, token mint `GP53KN1V3uRxHZtPkcYJV9KAXJiuDoNQQGTk6RTEUDAo`, manager = developer wallet `52b7pBNF...`, USDC 50% + JUP 50% (wSOL added later), mint 100 bps / redemption 50 bps / TVL 100 bps.
> Created `LmWUxmitHBiLjJrFNiK9K9PCQM5Y93KgPk9moVb6n1mCoBjpdmzKVTQN9Kf32Rar6qmQsNBo7rYWaLh2fooo8Yv` (create + 2 initialize_reserve_asset), JUP bought `GLyjLKeeuRJQTGgm4hpTYJsaLsHWeABLWd2C1Ah63wvShNQoMEgGz9kL41NsURrdMTgDUqyJd3fs1nrS962s3Z1`,
> seeded `4mcg4jPXdsNFRh6Si4uvdTrxY432fB5moip7oCh4apasvXovrXxoCdQwJEnF7APGAw6d3dhZpohoUwmGa7edm4LJ` with 1.000000 USDC + 4.366382 JUP: gross 2,000,000, fee ceil(1%) 20,000 -> fee vault 20,000 (10,000 protocol / 10,000 manager), net **1,980,000** to the manager, supply 2,000,000 -- second independent confirmation of MCR-01's seed formula.
> Throwaway co-manager `B8Y2aKdiHY17xLnNsfqwdxP3DmPaRZ3pzbwmCwdJcsDT`; "stranger" = a funded wallet with no role.

## MAR-01 Add Reserve asset -- **Passed** (closed 2026-09-08; the page's "single-asset USDC" scope note is outdated -- multi-asset Reserves exist)
- [x] add_reserve_asset_active on a live Reserve: `3iAMCcqiCbqsX7Fe3XMQTiyFQw4JKoCjszx6EodsosENeVcXXwhKUcvqZeuaJTEcFYChXYW5FFp24gYXAnuTJgY6` (manager `6BjTPAWG...`, H7NDKmf9...); on #21 by its manager: wSOL at 0 bps `3MK1jwtAtjWcHpj1BUJgPkJM7csd3rQs8fY9XW3dxiqyMZ7NrrSWApQYcLzUQbaDUnKgUyuapLXuZacXXgACbacN` (asset_count 2 -> 3).
- [x] fund_new_reserve_asset: 100,000 raw wSOL `3fpdWrZTVvbgaGNLDm8frZhmHNGFx2qo6no2x7zRv4rMEocFuhcNVmWUEsTf5yPxfMtpTnFG3dRHWdDYBwKPcWBQ` (vault 0 -> 100,000);
  amount 0 rejected `54gnA46BFuqZepgDcjTNKpEwEkeWVPV8oPkRn1PWAZAXoZS2uV1TGV3nG3w8vaBEEyc7Ky3aZRjybfbPfv61cnXJ` (6001 ZeroValue);
  funding an already-funded asset rejected `4Jrzrj3Dc6xMKyyBEXbFWNXHEaH5iQPJGf5Xq11JSGFbaKq4ZpV1JSWa3r41LLV4uV1TW1vHTLapXNgaqGEVeyyN` (6017 VaultNotEmpty).
- [x] Unauthorized rejected: co-manager without MANAGE_LIQUIDITY_CONFIG `t5fVAuxQb6Z431dUcZcqcbkY1crcjobPig5h4FjvNvjaGKvjFPJM85UYMHV9q4C7FGiw2CKqfCfU1i3yoc7t5HS` (6028 DelegatePermissionDenied).

## MRR-01 Remove Reserve asset -- **Passed** (closed 2026-09-08)
- [x] remove_reserve_asset on an empty, last-registered asset: wSOL `3uwrFYCXistqihwHeWneu7snY7r5AW3TVKqqkmQYHTCooPh7kYn5TDhmbuxqsrHA1ywbcbLmxA4jKoTxb1GdsHna` (asset_count 3 -> 2, vault closed).
- [x] Guards: non-empty vault rejected `CafyttegW3FPiMnP7ZFw8SbF1Whp5yxbrCgUPgf9wvvty7xpkzRu4mXHJroJS266QSS2phf2jsVENKzYfjotjTd` (6017 VaultNotEmpty);
  not the last-registered asset (JUP) rejected `5XGseqrNBKJm7neKeTQUumuJJoiphnMYYBDNGiNh8ixyq4Rv2g6iKeevmLFNtJDanSLnzPLo2DRHtFL2onhTxWsn` (6016 AssetNotLastRegistered);
  co-manager without permission rejected `3g9Mws9XDNf58WkgPjeUpAQMoEMvWMtPHhikyR5Jp5rCUYBL55CQu5ouGjEQXErv9TbGw67eE4CRtUzyQUH44fk5` (6028).
- Note: the only way to empty a vault is redemption, so the sequence was: `redeem_fee_vault_shares` (permissionless) `Z1QLFhJreuuYonbJ2vNZ83pzyYcsKnfuMen9e6bzbiZWbioc9mL967WbADVUyV16M5fNGDz7jrfDH1KduM6ykwo` (21,500 shares), full manager redemption `4jq6khTSkCSpb6wdQWdpdPVJKMXx8oNuGEtfPiGrDkdjV7t6M3gpM2WwcsnTRdMcgUCCc9c4Amwz2dz4ncPrecQF` (1,979,000 raw; 50 bps fee 9,895 re-minted), `redeem_fee_vault_shares` again `3SfbXHo2FiVg47kXYpj42CsfLNM2KuUtYDTQhFcysz8S9nYF6SXkJic5MRup2VRmiAHHYZairBHyFvurBUkUPwfK` (9,895 shares -> supply 0, every vault 0).

## MRB-01 Rebalance -- **Passed with a scope note** (closed 2026-09-08)
- [x] update_targets: live `3iAMCcqi...` (H7NDKmf9); on #21 to 45/45/10 `4FBgh5h6kmjPDVgpp9WKuPvnyM6a6p2Jr4e3a39DfEeKQtiSXxW6Cvi9Dx4V7kfYWkJdp4seiLwPwipsPwPmjtQF` (ReserveAsset targets read back: USDC 4500, JUP 4500, wSOL 1000); by a co-manager WITH UPDATE_TARGETS `9bNGjS2VwcpNriqtKwQnhp5VjeSahySwat8ZSbces6ufD2pLt78vW95A1aHzSb4nQZ4ZWwEq23NfsDRmsMZWfhL` (60/40).
- [x] record_rebalance (manager attestation with real balances_before): `3eowVWCcZe2Q5Rvjm1Dp4jzLH7TytM5PPKmRVLZqsvH5s3KLFpCnQ43aw5qEDzAJfv23XvyNvngdTd8sDfqityAQ`.
- [x] Unauthorized rejected: stranger update_targets `KTo19YoMVV1qjiVZPxNKGoZuvHqazsN16fynTjvrtdaYsr5Xj9WwFPrASaEiBc8hQnLKPkvvyL3MqkjWqt1dbnL` (6032 DelegateNotFound); co-manager without UPDATE_TARGETS `57KdnPBYn12G5Gbkd6kARgQSv4LZUm6Qv9G38QCtY4wqKWm9fv9ysXQeHfWBCk8Q6uFMuy4zceG3ruN9BjEUkb6K` (6028); stranger record_rebalance `3XXHQj1G4zAbBLgRmwAKVPhWztJhcADCbAj8gWczZnvGDmC71HqG4gBZQe1ueqTk4aKYM4cYDQ5E5yRZ2dfixndf` (6032).
- [~] **execute_rebalance_leg cannot run on Mainnet by construction**: it CPIs the DevNet-only AMM (`AJbXGWSU1x9LtJW7uRKJCwS3JZYqXwqHXpX6erY7dS6c`, which does not exist on Mainnet -- account null). On Mainnet, holdings are moved off-chain (Jupiter) and attested with record_rebalance; the site's Submit Rebalance only writes targets. This is a product-scope fact, not a defect; a real on-chain Mainnet rebalance leg would need a Jupiter-routed instruction.

## MDL-01 Co-managers & authority -- **Passed** (closed 2026-09-08; the real transfer_reserve_manager round-trip included)
- [x] add_delegate within bounds: live `4yW1zegQJg14fKEjhWeSjU7DAdE2SRZnwqPtireW99ZCGgCUrBoKeAToPSwQuD4x9eXmTpmpyUy2yzkRRfJnwDXs` (EME96...); on #21 restricted UPDATE_METADATA-only `2mbCJ8ndK92jhKr6YU6XqHoSXD7wrLSsm8AXaYxyCMkrChASX4kzFjqgQeRmnidrvsX8rGEvvwSaMim7BFHz8Fbw`.
- [x] Co-manager cannot act outside its permissions: update_targets without UPDATE_TARGETS `57KdnPBYn12G5Gbkd6kARgQSv4LZUm6Qv9G38QCtY4wqKWm9fv9ysXQeHfWBCk8Q6uFMuy4zceG3ruN9BjEUkb6K` (6028); pause without PAUSE_RESERVE `3k9zcEm1jrYMTCDdGXoeqK7qddH1EA76wnJ4Cw83r7vw3eKS4xffBFAptnkJHYrQDcQxmsW9m6LVPZ7tv8P7hUGw` (6028); add/remove asset without MANAGE_LIQUIDITY_CONFIG (`t5fVAuxQ...`, `3g9Mws9X...`, 6028). Inside its permission it works: update_metadata `3sJu7ajfG9VF48T96wLDbwmYXQid3pgdp689PPbsELaQUczsc4iTb3ZnBMMCdqT7FBMLaYcErKvyExRgBMaLvf3g`.
- [x] update_delegate_permissions: `2gXS4wuqkf8XgJ2bB7PnbjC9P2WYYSqkPQpmco4hoZJwjmT33v4NjATmN7QJ6x2cnE9y9xsRmwrXDKM4FddBqwfr` (+UPDATE_TARGETS), then the same co-manager's update_targets succeeds `9bNGjS2V...`; `3bjo3ynEVpfY5Y8hjHKEbuDSAJ5T9r3LBc2BmGAsyEWBFSXyroXcEVsvgP331PSwspwFKAvF35uD3ZQGdEzo57bP` (+PAUSE/UNPAUSE) then its pause/unpause succeed (see MPU-01). Finding: permission changes are refused while the Reserve is paused -- `5QQKwin1mX4itw9htD1cag3nNqxgoVnTXguatjC1pxq63brUpkNCnmbn8fS9h2QR2NjTr4MprSjPuLUh41CSq1oo` (6011 ReservePaused), by design.
- [x] remove_delegate takes effect immediately: `4QB1ALukAFbDiWyhKCXVNT5Nxu75RyLSHferXksKsgmZRjw4tEbTcKennSLG5SwUUmrswAb6dqhwTwDezfYi6Tjh`; the removed co-manager's next action `vzGeqNfcP84j7awvCy5k8KgG9QBSUD84QomcoXQHehyQv47J9eEJxx53j4q2nKhymyKwcsfDLCjpouLLjrD8cWR` FAILED 6032 DelegateNotFound. A wallet with no role: `SVv5vfiSrn3n7AdzDomYYpCXzwQoVYauerB7gvPNudELp1N1RP5VvtS8oFyQ8mcFjdUtvYMSMXy3FsaP5M4Px6H` (6032).
- [x] transfer_reserve_manager: from a non-manager rejected `3o6WitDEfVLzU1ZJqfnm2BAPZF2ghUDDPgchN31y6jxWwAGgETKES658kH5KMPYgLtyFijruePNAGWew8ts85Fx3` (Anchor 2001 ConstraintHasOne on reserve.manager); real transfer to the throwaway `t8aoAbF3ZG5FrntseLaNsWNqZ7XhxZwFdv4AzMcyoKhxx4xAto5v8k9sMSznhLC5StwW18bTw6wMNk3gLVXqJea` (reserve.manager read back = B8Y2aKdi...) and back `3njt9zuKJVUZnZtFwwYeY6cCxvmkFr9BieuSJZq5VEBfxMwvsrGy9WapuxrDxUPfDszEWZsU4NvqnKARbK9Kb95G` (= 52b7pBNF...).
- [x] Two-admin ProtocolConfig: authority `CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8`, admin_2 `PSpQGPvw7tZedKJvN21dJkh3vdDQeXkwA5n9DKBRZw5` (read on-chain); a third wallet is rejected with 6031 on every admin instruction (MFE-01 evidence).
- [ ] Co-manager expiration: the deployed Delegate has no expiry field to exercise (permissions bitmask + restricted flag only) -- N/A.

## MPU-01 Pause / Unpause -- **Partial** (only `set_protocol_paused` by an admin wallet is left; that is Creator/Boss-only)
- [x] pause_reserve blocks a Buy: manager pause `5tyr4oAxXMoCpdHGiLfzqx57dLpB4GExvEoChupnHwX3kryrJhfxS3qtCmKXYHtoTQvrr8ZT8qSdZapRe52tzqY3` (status paused) -> mint `5MgaHqPULq62y5mjBshrzQ9EL3NWJa4frZLDP7kh9TLv3LpZm5njkYCuz7Tj3vELupAuG2P8kUeHKTouup8rAuKL` FAILED 6010 UnexpectedReserveStatus.
- [x] unpause resumes: manager unpause `4vdRDmoxPoL286sZTUCHppMEwSDuofrp6s4dWBivQjdHRaTgCEpVykaMhVECYd4EvdZcNbGwDbTXEHmTVNGnKtf2` -> the same mint succeeds `zWEGK8i1xYsuJ4knvMrAiN1CKxw53Z3m6mgEibwQiVMyDiYx2q5Lke2jb2zbs4btWnbHiZUWGDECCnwiCY592SP` (supply 2,000,000 -> 2,100,000).
- [x] Co-manager with PAUSE/UNPAUSE: pause `5bAtSR3jzsxWMNSDrReoNeD1tdGy1TXD6ZZFdUZceAqz3dbWFkYi12SdPQdYQjeJrMyugYyjcFeLqBriBxFVE3wu`, unpause `5LiJWxYqi3tPxusMtpzCEWx8q2vNRfYY8XGWXDjma8doFh8g3K8iWA1zNdHMwLv3XZJg88ppkV1qezsr5nnrsETC`; without the bit rejected `3k9zcEm1...` (6028); a wallet with no role rejected `SVv5vfiS...` (6032).
- [ ] set_protocol_paused by an admin wallet (Creator/Boss). Non-admin already rejected: `5TNGN3Aw9tqZ4Qbk9qFFLxMUHmksF8jfQ8gQmcQtuerd1HcniggE5zNhDKB3DJpePYQjde6rQKJFwja67ygpUA6Y` (6031 NotProtocolAuthority).

## MFE-01 Fees & protocol config -- **Blocked** (one Creator/Boss signature for the payout leg; everything else green)
- [x] accrue_fees runs on Mainnet: hourly keeper (`AuaJRdbR...`), first run 2026-09-08 00:15 UTC.
- [x] **Fees accrue at the configured rate -- six real TVL settlements, each checked against the formula
  `ceil(period_supply_seconds x 100 bps / (10,000 x 31,536,000))`, all exact to the raw unit** (keeper-signed, 2026-09-08 ~02:23 UTC):
  | Reserve | supply | period (supply-seconds) | minted | expected | signature |
  |---|---|---|---|---|---|
  | 7 H7NDKmf9 | 3,467,888 | 4,906,848,350,000 | 2,224 | 2,224 | `46ezztwbB2XY5ovVqyT3v8NuN33AsTHL1YiPnAXSYg5fibqDENgEjMozvtbqCJJSwvsmfywp9f5LrWssgLCpwV7w` |
  | 8 52eHitfw | 13,504,158 | 14,193,003,544,920 | 4,547 | 4,547 | `366zGJmGyUpSZSJ3J6RUbJaoTXkgErN8hDCSyL4Xv3vNJEWb6a436eQjK9VeuQSd2ynZnbkGzL7Swut25t5Sb4R6` |
  | 13 EK5WwpsR | 7,485,039 | 1,553,581,153,488 | 3,165 | 3,165 | `3bFJqT5tuQthMtgFmzBAS9nQRWwTMDvY25ngKCEK6ehV7xRmV8BVoQwoBtg5yRf95mYke64paf78JoKEi5zCBEfv` |
  | 16 9oBkwdrT | 20,515,859 | 20,500,343,200,000 | 6,529 | 6,529 | `5pu7tUpgS7kmiw4fBL2veZbCHYYTyqh5npURxUTSbT4Rkdn7axim1PJeUZWz3gtYECPEo5rgbSbcXvGUSc4zb3b6` |
  | 17 D6juoQKw | 99,956 | 5,272,098,256 | 35 | 35 | `2Yqg4NAcB7qbLA6TkPfVAdcZsKq6GKcapixnEM5tJDLk719hgw5p6zAdnnwo3vnAFYxYJtz8ScWvQeJ7xaxL8gmt` |
  | 18 9rHRibvi | 25,256,908 | 1,556,920,000,000 | 4,736 | 4,736 | `3WXHWKiS5njKN32GBNL8KdxDCGva4Xdkn43pr8EYxjauX7kZkDqrTc6j5Uh2pgRu8kTxckLsHjjF7N5EaovJTAiw` |
  Each settlement reset `period_supply_seconds` to 0 and advanced `last_settled_ts` to the block time; the 50/50 split lands in the fee vault (FeeVaultCredited, source AnnualTvlFee).
  **Bug found on the way (DEC-0192):** the deployed `AccrueFees` struct declares the Reserve Token mint without `mut`, so the IDL marks it read-only and the mint CPI fails with `PrivilegeEscalation` the moment there is anything to bill (clock-starts mint nothing, so the first run passed). Fix: the keeper passes the mint writable (runtime accepts it; the program does not require read-only); `mut` added in source and the IDL for the next upgrade.
- [x] Mint fees crystallize into the fee vault at the configured rate (HniecHQ... above; four vaults now hold shares: CYhMBkEL 99,688/99,687, HYK2pVFZ 20,545/20,544, 52eHitfw 8,703/8,702, 9oBkwdrT 3,080/3,079).
- [ ] USDC reaches the Treasury vault `3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5` and manager recipients -- **blocked on `set_fee_settlement_keeper`**.
- [x] **Guarded: a non-admin wallet cannot change protocol config or the keeper.** Real Mainnet rejections
  (preflight skipped, signed by developer wallet `52b7pBNF...`, which is NOT a Protocol Admin), all
  custom error 6031 `NotProtocolAuthority`, ProtocolConfig unchanged afterwards (paused=false, destination still `3CBpV...`):
  - `update_protocol_config` -> `2wHMexi5Kr9c6P1R7WqZKSX3cfMGvm44kEoGjrJYZ8xyeC98y28TXG5uSH1u4Ponc3Ttx3H6WMHEw2tcaJZCSM4w`
  - `set_fee_settlement_keeper` -> `PXoqsuEnofLfKWiecKpUPy2p7a32EzcSJ7jwPhbf5KUYtyuxeiquY3gAmAEUCbKAMiuBrxnfGgnPuTRLnj8zEgB`
- [ ] update_protocol_config by an admin wallet succeeds (needs Creator/Boss).
- [x] update_metadata by the Reserve manager: `5hTcsyWAZZyWPrBrSmHQi8y453kC1fKVAQoHbei8NK66d9uXU3CP6vunD7pNjkyrNuUSSTTdDedL3h4hDuVhzsmX`.

## MWD-01 Wind-down / Closure -- **Partial** (blocked on a program fix found by this very test)
- [x] initiate_wind_down: by a non-manager rejected `3kbGh3TPPvG11p3n7rNDUGD7VfBMc8aRB7yYaLSQE6DPbHoYLdFGXoFDkap5ZaT3y5XwAFEJCMFN1Lkc6vzVsoMP` (6027 NotReserveManager); by the manager `2NLwdDv9bHY1FLfmByAcPd32yvBakp3Trmoqy3dewdkqYpjmdmUQsHPzTPzQrCnoVRX58rd95mNqFB92h8jg4rn8` (status WindDown).
- [x] Buy blocked while wound down: `23KKzHwswkzijJrHcCz2g2QnVFT6W51p8MwGeHVZiQroenktZbvaUvJMVivVLp2Lwd93iwdxndqevAbK4deQ3stE` FAILED 6010.
- [x] Redeem out: every holder (the manager) and the fee vault were redeemed to zero BEFORE the wind-down (see MRR-01), supply 0, every vault 0 -- redemption remains allowed in WindDown by the program (`require_redemption_allowed`).
- [ ] **close_reserve -- FAILS on the deployed program for any Reserve with 2+ assets**: `3ub72R3KzUaAYAi6nNd11tppADc4BC7Su1A45XjX8WPjS5JyMrH8eEey2tArr1h4qkJgZBLea73R7Uxy4MMCZRc6` FAILED `UnbalancedInstruction` after the first vault-close CPI (simulation: "sum of account balances before and after instruction do not match"). Cause: the loop closed a vault (token CPI) then its ReserveAsset config (Rust-side lamport move) per iteration; at the next CPI the runtime sees the manager's credit but not the config's not-yet-synced debit. **Fixed in source** (two-pass close, `programs/ssr_protocol/src/instructions/close_reserve.rs`, cargo test 17/17) -- ships with the next Squads upgrade together with DEC-0192's `mut`. Reserve #21 stays in WindDown (supply 0, vaults 0, ~$0.02 staged for the keeper) until then, and its close will be this clause's signature.

## MSC-01 Security review by a non-builder -- **Not tested**
- [ ] Reviewer + date per function above.
