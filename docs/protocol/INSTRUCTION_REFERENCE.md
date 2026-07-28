<!--
  Per-instruction reference for the SSR Protocol v1 program. Companion to
  ACCOUNT_MODEL.md (nouns) and SECURITY_INVARIANTS.md (why). Source of truth
  is programs/ssr_protocol/src/instructions/*.rs -- this document summarizes
  it for readability; if the two ever disagree, the Rust source wins.
-->

# Instruction Reference

## `initialize_protocol`
- **Signer:** `authority` (becomes `ProtocolConfig.authority`).
- **Accounts:** `protocol_config` (init, PDA), `authority`, `system_program`.
- **Args:** `max_reserve_assets: u8`, `default_protocol_fee_bps: u16`, `default_protocol_fee_destination: Pubkey`.
- **Validation:** `0 < max_reserve_assets <= ABSOLUTE_MAX_RESERVE_ASSETS (24)`.
- **State transition:** creates the singleton `ProtocolConfig`, `reserve_count = 0`, `paused = false`.
- **Token movement:** none.
- **Event:** `ProtocolInitialized`.
- **Errors:** `MaxReserveAssetsTooHigh`.
- **Frontend use:** one-time deploy-time setup; not a user-facing action.

## `create_reserve`
- **Signer:** `manager` (becomes `Reserve.manager`, root Reserve Manager).
- **Accounts:** `protocol_config` (mut), `reserve` (init, PDA seeded by `reserve_count`), `mint_authority` (PDA, unchecked), `reserve_token_mint` (init, PDA), `manager`, `token_program`, `system_program`.
- **Args:** `metadata_uri: String`, `mint_fee_bps`, `redemption_fee_bps`, `annual_tvl_fee_bps`, `manager_fee_share_bps`, `protocol_fee_share_bps: u16` each, `fee_destination: Pubkey`.
- **Validation:** protocol not paused; `metadata_uri` length; all fee values against their absolute caps; `manager_fee_share_bps + protocol_fee_share_bps <= 10000`.
- **State transition:** `ProtocolConfig.reserve_count += 1`; new `Reserve` at `status = Created`, `asset_count = 0`.
- **Token movement:** none (Reserve Token mint is created with zero supply).
- **Event:** `ReserveCreated`.
- **Errors:** `ProtocolPaused`, `MetadataUriTooLong`, `FeeExceedsMaximum`, `InvalidFeeShareSplit`, `MathOverflow`.
- **Frontend use:** Create-a-Reserve flow, step "Review & Deploy" → "Launch Reserve" (first of the multi-instruction creation sequence -- see SSR_ARCHITECTURE.md section 4).

## `initialize_reserve_asset`
- **Signer:** `manager` (root manager only -- not delegable in v1, see ACCOUNT_MODEL.md).
- **Accounts:** `protocol_config` (read), `reserve` (mut), `reserve_asset` (init, PDA), `asset_mint` (the basket token being registered), `vault` (init, PDA token account), `vault_authority` (PDA, unchecked), `manager`, `token_program` (Interface, SPL Token or Token-2022), `system_program`.
- **Args:** `target_weight_bps: u16`.
- **Validation:** `Reserve.status ∈ {Created, AssetsInitializing}`; `asset_count < ProtocolConfig.max_reserve_assets`; `total_target_weight_bps + target_weight_bps <= 10000`; token program is SPL Token or Token-2022; Token-2022 extension allow-list (see SECURITY_INVARIANTS.md); duplicate mint rejected structurally by `init` on an already-existing PDA.
- **State transition:** `asset_count += 1`, `total_target_weight_bps += target_weight_bps`, `configured_at = now`, `status: Created → AssetsInitializing` (first call only).
- **Token movement:** none (vault created empty).
- **Event:** `ReserveAssetInitialized`.
- **Errors:** `UnexpectedReserveStatus`, `ReserveAssetLimitReached`, `TargetWeightExceedsTotal`, `UnsupportedTokenProgram`, `UnsupportedMintExtension`.
- **Frontend use:** Create-a-Reserve flow, step "Composition" (one call per selected asset).

## `seed_reserve`
- **Signer:** `manager`.
- **Accounts:** `protocol_config` (read), `reserve` (mut), `reserve_token_mint` (mut), `mint_authority` (PDA), `manager_reserve_token_account` (init_if_needed ATA), `manager`, `token_program`, `associated_token_program`, `system_program`. **Remaining accounts:** `asset_count` groups of `[reserve_asset, vault, manager_asset_token_account, mint, token_program]`.
- **Args:** `seed_amounts: Vec<u64>` (parallel to registered assets, `order_index` order), `initial_reserve_tokens: u64`.
- **Validation:** protocol not paused; `status == AssetsInitializing`; `asset_count > 0`; `initial_reserve_tokens > 0`; each `seed_amounts[i] >= MIN_SEED_AMOUNT_PER_ASSET`; every vault reloads to a nonzero balance post-transfer.
- **State transition:** `status → Active`.
- **Token movement:** each seed amount transferred manager → vault (CPI, manager's own signature); `initial_reserve_tokens` minted to `manager_reserve_token_account` (CPI, `mint_authority` PDA signature).
- **Event:** `ReserveSeeded`.
- **Errors:** `ProtocolPaused`, `UnexpectedReserveStatus`, `ZeroValue`, `SeedAmountTooLow`, `RemainingAccountsMismatch`.
- **Frontend use:** final step of Create-a-Reserve ("Initial Liquidity"/seed deposit), immediately following the last `initialize_reserve_asset` call.

## `mint_reserve_tokens_in_kind`
- **Signer:** `depositor` (any wallet -- permissionless).
- **Accounts:** `protocol_config` (read), `reserve` (mut), `reserve_token_mint` (mut), `mint_authority` (PDA), `depositor_reserve_token_account` (init_if_needed ATA), `depositor`, `token_program`, `associated_token_program`, `system_program`. **Remaining accounts:** `asset_count` groups of `[reserve_asset, vault, depositor_asset_token_account, mint, token_program]`.
- **Args:** `reserve_tokens_requested: u64` (gross, pre-fee), `min_reserve_tokens_out: u64`, `max_asset_amounts: Vec<u64>`.
- **Validation:** protocol not paused; `status == Active`; `reserve_tokens_requested > 0`; `total_supply_before > 0`; per-asset `required_amount <= max_asset_amounts[i]`; `net_shares_out >= min_reserve_tokens_out` and `> 0`.
- **State transition:** `FeeConfig.pending_manager_fee_shares`/`pending_protocol_fee_shares` increase by the fee split (deferred mint, not paid out yet).
- **Token movement:** required amount per asset transferred depositor → vault (ceil-rounded on pre-transaction ratio); `net_shares_out` (= requested − mint fee) minted to depositor.
- **Event:** `ReserveTokensMinted`.
- **Errors:** `ProtocolPaused`, `UnexpectedReserveStatus`, `ZeroValue`, `ZeroSupply`, `SlippageMaxInputExceeded`, `ZeroAmountAfterFeesOrRounding`, `SlippageMinOutputNotMet`, `RemainingAccountsMismatch`.
- **Frontend use:** the NEW proportional-mint UI surface (not yet built -- see FRONTEND_INTEGRATION.md; distinct from the existing AMM "Buy" tab).

## `redeem_reserve_tokens_in_kind`
- **Signer:** `redeemer` (any holder -- permissionless; deliberately has no `ProtocolConfig` account at all, see DEC-0016).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (mut), `vault_authority` (PDA), `redeemer_reserve_token_account` (mut), `redeemer`, `token_program`. **Remaining accounts:** `asset_count` groups of `[reserve_asset, vault, redeemer_asset_token_account, mint, token_program]`.
- **Args:** `reserve_tokens_to_redeem: u64`, `min_asset_amounts_out: Vec<u64>`.
- **Validation:** `status ∈ {Active, Paused}`; `reserve_tokens_to_redeem > 0` and `<=` redeemer's balance; `total_supply_before > 0`; per-asset `entitlement >= min_asset_amounts_out[i]`.
- **State transition:** none beyond the burn (no fee-share accounting change -- see below).
- **Token movement:** full `reserve_tokens_to_redeem` burned from redeemer; proportional entitlement (computed on the *net*, post-redemption-fee portion) transferred vault → redeemer per asset. The fee portion's backing assets are deliberately left in the vaults (accretion to remaining holders, not a mint to any fee recipient).
- **Event:** `ReserveTokensRedeemed`.
- **Errors:** `UnexpectedReserveStatus`, `ZeroValue`, `RedemptionExceedsEntitlement`, `ZeroSupply`, `ZeroAmountAfterFeesOrRounding`, `SlippageMinOutputNotMet`, `RemainingAccountsMismatch`.
- **Frontend use:** the NEW proportional-redeem UI surface (not yet built); also the canonical "redeem via SDK with no website" path for the frontend-independence test requirement.

## `update_targets`
- **Signer:** manager, or delegate with `UPDATE_TARGETS`.
- **Accounts:** `reserve` (mut), `delegate` (unchecked, conditionally validated), `signer`. **Remaining accounts:** `asset_count` `ReserveAsset` accounts (mut).
- **Args:** `new_target_weights_bps: Vec<u16>`.
- **Validation:** not paused; permission check; each asset either `enabled` or new weight is `0`; new sum `<= 10000`.
- **State transition:** each `ReserveAsset.target_weight_bps` overwritten; `Reserve.total_target_weight_bps`/`configured_at` updated. **Moves no tokens** (see SSR_ARCHITECTURE.md section 0 -- rebalance execution is a separate, deferred concern).
- **Token movement:** none.
- **Event:** `TargetsUpdated`.
- **Errors:** `ReservePaused`, `DelegatePermissionDenied`/`NotReserveManager` (via `require_reserve_permission`), `ReserveAssetDisabled`, `TargetWeightExceedsTotal`, `RemainingAccountsMismatch`.
- **Frontend use:** Manage → Rebalance tab, "set new targets" step (before any actual trade).

## `add_delegate`
- **Signer:** manager (unrestricted delegate) or delegate with `ADD_RESTRICTED_DELEGATE` (restricted delegate only).
- **Accounts:** `reserve` (mut), `delegate_account` (init, PDA), `acting_delegate` (unchecked, the signer's own delegate record if applicable), `signer`, `system_program`.
- **Args:** `delegate_wallet: Pubkey`, `permissions: u16`, `restricted: bool`.
- **Validation:** not paused; `permissions` has no reserved bits set; authority check depends on `restricted`.
- **State transition:** new `Delegate` account; `Reserve.delegate_count += 1`.
- **Token movement:** none.
- **Event:** `DelegateAdded`.
- **Errors:** `ReservedPermissionBitSet`, `DelegatePermissionDenied`, `UnrestrictedDelegateRequiresManager`.
- **Frontend use:** Manage → Delegates tab, "add delegate."

## `update_delegate_permissions`
- **Signer:** manager (any delegate) or delegate with `ADD_RESTRICTED_DELEGATE` (restricted delegates only).
- **Accounts:** `reserve` (read), `delegate_account` (mut, PDA), `acting_delegate` (unchecked), `signer`.
- **Args:** `new_permissions: u16`.
- **Validation:** not paused; reserved bits check; authority check by target's `restricted` flag.
- **State transition:** `Delegate.permissions` overwritten.
- **Token movement:** none.
- **Event:** `DelegatePermissionsUpdated`.
- **Errors:** same family as `add_delegate`.
- **Frontend use:** Manage → Delegates tab, "edit permissions."

## `remove_delegate`
- **Signer:** manager (any delegate) or delegate with `REMOVE_RESTRICTED_DELEGATE` (restricted delegates only).
- **Accounts:** `reserve` (mut), `delegate_account` (mut, `close = signer`), `acting_delegate` (unchecked), `signer`.
- **Args:** none.
- **Validation:** authority check by target's `restricted` flag.
- **State transition:** `Delegate` account closed (rent reclaimed to `signer`); `Reserve.delegate_count -= 1`.
- **Token movement:** none (SOL rent reclaim only).
- **Event:** `DelegateRemoved`.
- **Errors:** `DelegatePermissionDenied`, `UnrestrictedDelegateRequiresManager`, `MathUnderflow`.
- **Frontend use:** Manage → Delegates tab, "remove."

## `transfer_reserve_manager`
- **Signer:** current `manager` only -- root-exclusive, never delegable.
- **Accounts:** `reserve` (mut, `has_one = manager`), `manager`.
- **Args:** `new_manager: Pubkey`.
- **Validation:** signer must equal current manager (enforced by `has_one`).
- **State transition:** `Reserve.manager = new_manager`.
- **Token movement:** none.
- **Event:** `ReserveManagerTransferred`.
- **Errors:** Anchor's `has_one` constraint violation (surfaces as a generic constraint error, not a custom `SsrError` -- consider adding an explicit check with `SsrError::NotReserveManager` for a clearer client-facing message; ⏳ follow-up).
- **Frontend use:** Manage → Overview, "transfer ownership" (a deliberately rare, high-friction action -- no dedicated UI exists yet, matches its root-exclusive/irreversible nature).

## `pause_reserve` / `unpause_reserve`
- **Signer:** manager, or delegate with `PAUSE_RESERVE`/`UNPAUSE_RESERVE` respectively.
- **Accounts:** `reserve` (mut), `delegate` (unchecked), `signer`.
- **Args:** none.
- **Validation:** `status == Active` (to pause) / `status == Paused` (to unpause); permission check.
- **State transition:** `status ↔ Paused/Active`.
- **Token movement:** none.
- **Events:** `ReservePaused` / `ReserveUnpaused`.
- **Errors:** `UnexpectedReserveStatus`, `ReserveNotPaused`, `DelegatePermissionDenied`.
- **Frontend use:** Manage → Overview, emergency pause control (not yet built in the frontend -- see FRONTEND_INTEGRATION.md item 11).

## `accrue_fees`
- **Signer:** none required -- permissionless, pure accounting (see reference protocol's `distributeFees` precedent).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (read).
- **Args:** none.
- **Validation:** none beyond arithmetic overflow checks; no-ops (returns `Ok(())` early) if less than one full day has elapsed since the last checkpoint.
- **State transition:** `FeeConfig.pending_manager_fee_shares`/`pending_protocol_fee_shares` increase (ceil-rounded, linear/simple-interest approximation -- see accrue_fees.rs for why this differs from the reference protocol's true exponential compounding); `last_fee_accrual_ts` advances by whole elapsed days.
- **Token movement:** none (accounting only).
- **Event:** `FeesAccrued`.
- **Errors:** `MathOverflow`/`MathUnderflow`.
- **Frontend use:** background/cron-style call (could be triggered by anyone, including the frontend opportunistically before displaying fee state); no dedicated button needed.

## `collect_fees`
- **Signer:** `payer` (permissionless trigger; only pays destination-ATA rent if needed -- cannot redirect funds).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (mut), `mint_authority` (PDA), `manager_fee_destination_token_account` (init_if_needed ATA) + `manager_fee_destination` (unchecked, checked == `fee_config.fee_destination`), `protocol_fee_destination_token_account` (init_if_needed ATA) + `protocol_fee_destination` (unchecked, **not yet independently validated** -- see SECURITY_INVARIANTS.md gap list), `payer`, `token_program`, `associated_token_program`, `system_program`.
- **Args:** none.
- **Validation:** `manager_fee_destination` must equal `Reserve.fee_config.fee_destination`; at least one pending amount must be nonzero.
- **State transition:** `pending_manager_fee_shares`/`pending_protocol_fee_shares` reset to `0`.
- **Token movement:** mints the two pending amounts to their respective destination ATAs.
- **Event:** `FeesCollected`.
- **Errors:** `InvalidFeeShareSplit`, `NoPendingFees`.
- **Frontend use:** Manage → Overview, "collect fees" (manager-triggered convenience; permissionless so it could also run unattended).

## `record_rebalance`
- **Signer:** delegate with `EXECUTE_REBALANCE` (or manager).
- **Accounts:** `reserve` (read), `delegate` (unchecked), `signer`. **Remaining accounts:** `asset_count` pairs of `[reserve_asset, vault]`.
- **Args:** `balances_before: Vec<u64>` (caller-attested, **not independently verified on-chain** -- see SECURITY_INVARIANTS.md and the module doc comment in record_rebalance.rs), `note: String`.
- **Validation:** permission check; account/count matching.
- **State transition:** none (pure attestation/event emission).
- **Token movement:** none -- **v1 has no on-chain trade-execution instruction at all**; the actual asset-swapping trade happens outside this program (deferred per DEC-0017), and this instruction only records the outcome for indexing.
- **Event:** `RebalanceRecorded`.
- **Errors:** `DelegatePermissionDenied`, `RemainingAccountsMismatch`, `ReserveAssetMismatch`, `InvalidReserveVault`.
- **Frontend use:** Manage → Rebalance tab, "record outcome" (after a manager has manually executed a trade through some other means).

## `update_metadata`
- **Signer:** manager, or delegate with `UPDATE_METADATA`.
- **Accounts:** `reserve` (mut), `delegate` (unchecked), `signer`.
- **Args:** `new_metadata_uri: String`.
- **Validation:** length check; permission check.
- **State transition:** `Reserve.metadata_uri` overwritten, `configured_at` updated.
- **Token movement:** none.
- **Event:** `MetadataUpdated`.
- **Errors:** `MetadataUriTooLong`, `DelegatePermissionDenied`.
- **Frontend use:** Manage → Overview, "edit description/logo reference" (metadata itself lives off-chain at the referenced URI, matching the mission's "metadata reference" field guidance).
