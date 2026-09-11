<!--
  Per-instruction reference for the SSR Protocol v1 program. Companion to
  ACCOUNT_MODEL.md (nouns) and SECURITY_INVARIANTS.md (why). Source of truth
  is programs/ssr_protocol/src/instructions/*.rs -- this document summarizes
  it for readability; if the two ever disagree, the Rust source wins.

  Refreshed 2026-08-13 (see docs/project/DECISION_LOG.md DEC-0092): brought
  up to date with the 6 instructions added since this doc was last edited
  (update_protocol_config, add_reserve_asset_active, fund_new_reserve_asset,
  remove_reserve_asset, initiate_wind_down, close_reserve -- Phase F/G and
  DEC-0033), and corrected several "Frontend use" lines that had drifted
  stale (mint/redeem were described as "not yet built" -- they are the live
  Buy/Sell tabs; pause/unpause were described as "not yet built" -- they
  WERE built and have since been deliberately removed again, DEC-0086;
  record_rebalance's described UI step does not actually exist in the
  current frontend). See docs/protocol/DEVNET_INSTRUCTION_AUDIT_2026-08-13.md
  for the full naming/Solscan-identifiability audit this refresh was part
  of -- every one of the 23 currently-deployed instruction names below was
  confirmed already clear and consistent; none were renamed.
-->

# Instruction Reference

## `initialize_protocol`
- **Signer:** `authority` (becomes `ProtocolConfig.authority`, the first of two independent Protocol Admins).
- **Accounts:** `protocol_config` (init, PDA), `authority`, `system_program`.
- **Args:** `admin_2: Pubkey` (the second Protocol Admin wallet -- need not sign; recorded only), `max_reserve_assets: u8`, `default_protocol_fee_bps: u16`, `default_protocol_fee_destination: Pubkey`.
- **Validation:** `0 < max_reserve_assets <= ABSOLUTE_MAX_RESERVE_ASSETS (24)`; `admin_2 != authority` (`DuplicateProtocolAdmin`).
- **State transition:** creates the singleton `ProtocolConfig`, `reserve_count = 0`, `paused = false`.
- **Token movement:** none.
- **Event:** `ProtocolInitialized`.
- **Errors:** `MaxReserveAssetsTooHigh`, `DuplicateProtocolAdmin`.
- **Frontend use:** one-time deploy-time setup; not a user-facing action.

## `create_reserve`
- **Signer:** `manager` (becomes `Reserve.manager`, root Reserve Manager).
- **Accounts:** `protocol_config` (mut), `reserve` (init, PDA seeded by `reserve_count`), `mint_authority` (PDA, unchecked), `reserve_token_mint` (init, PDA), `manager`, `token_program`, `system_program`.
- **Args (DEC-0094: `manager_fee_share_bps`/`protocol_fee_share_bps` REMOVED -- no longer caller-supplied):** `metadata_uri: String`, `mint_fee_bps`, `redemption_fee_bps`, `annual_tvl_fee_bps: u16` each, `fee_destination: Pubkey` (the "Primary Fee Destination").
- **Validation:** protocol not paused; `metadata_uri` length; all fee values against their absolute caps.
- **State transition:** `ProtocolConfig.reserve_count += 1`; new `Reserve` at `status = Created`, `asset_count = 0`; `fee_config.manager_fee_share_bps`/`protocol_fee_share_bps` initialized to 0 (repurposed as program-maintained "last effective mint-fee split" telemetry, populated by the first real mint -- see `mint_reserve_tokens_in_kind` below).
- **Token movement:** none (Reserve Token mint is created with zero supply).
- **Event:** `ReserveCreated`.
- **Errors:** `ProtocolPaused`, `MetadataUriTooLong`, `FeeExceedsMaximum`, `MathOverflow`.
- **Frontend use:** Create-a-Reserve flow, step "Review & Deploy" → "Launch Reserve" (first of the multi-instruction creation sequence -- see SSR_ARCHITECTURE.md section 4). For >1 Manager fee recipient, `initialize_manager_fee_recipients` (see below) is bundled into the SAME transaction.
- **DEC-0094 note:** the Protocol/Manager split is no longer a caller-chosen ratio -- see `mint_reserve_tokens_in_kind`/`accrue_fees` below for the formula now applied fresh at every accrual.

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
- **Accounts:** `protocol_config` (read), `reserve` (mut), `reserve_token_mint` (mut), `mint_authority` (PDA), `depositor_reserve_token_account` (init_if_needed ATA), `depositor`, `manager_fee_recipients` (DEC-0094, **optional** -- `Option<Account<ManagerFeeRecipients>>`; client passes the program ID itself as the `None` sentinel for a not-yet-migrated Reserve), `token_program`, `associated_token_program`, `system_program`. **Remaining accounts:** `asset_count` groups of `[reserve_asset, vault, depositor_asset_token_account, mint, token_program]`.
- **Args:** `reserve_tokens_requested: u64` (gross, pre-fee), `min_reserve_tokens_out: u64`, `max_asset_amounts: Vec<u64>`.
- **Validation:** protocol not paused; `status == Active`; `reserve_tokens_requested > 0`; `total_supply_before > 0`; per-asset `required_amount <= max_asset_amounts[i]`; `net_shares_out >= min_reserve_tokens_out` and `> 0`.
- **DEC-0094 fee formula (mint fee):** `protocol_bps = max(50, mint_fee_bps / 2)`, `manager_bps = max(mint_fee_bps - protocol_bps, 0)` (`fee_math::split_configured_bps`), computed FRESH every call -- never a stored ratio. The effective total (`protocol_bps + manager_bps`) can exceed the configured `mint_fee_bps` when it's below the 0.5% floor. `fee_config.manager_fee_share_bps`/`protocol_fee_share_bps` are overwritten each call as informational "last effective split" telemetry only.
- **State transition:** piggybacks a TVL-fee checkpoint on pre-mint supply (`accrue_fees::checkpoint_tvl_fee`, safe no-op if <1 day elapsed) before its own logic. `FeeConfig.pending_protocol_fee_shares` increases by the protocol's share. The manager's share is credited via `common::credit_manager_fee_shares`: if `manager_fee_recipients` is `Some` (migrated Reserve), apportioned across up to 10 recipients (largest-remainder) into `ManagerFeeRecipients.recipients[i].pending_fee_shares`; if `None`, credited to the legacy `FeeConfig.pending_manager_fee_shares` aggregate exactly as before this pass.
- **Token movement:** required amount per asset transferred depositor → vault (ceil-rounded on pre-transaction ratio); `net_shares_out` (= requested − effective total fee) minted to depositor.
- **Event:** `ReserveTokensMinted`, plus `FeesAccrued` (TVL piggyback, if any elapsed) and `ManagerFeeShareAccrued` (if migrated and manager total > 0).
- **Errors:** `ProtocolPaused`, `UnexpectedReserveStatus`, `ZeroValue`, `ZeroSupply`, `SlippageMaxInputExceeded`, `ZeroAmountAfterFeesOrRounding`, `SlippageMinOutputNotMet`, `RemainingAccountsMismatch`, `ManagerFeeRecipientsMismatch`, `InvalidFeeRecipientCount`.
- **Frontend use:** the Reserve-detail page's "Buy" tab (`src/merge/pages/DTRDetail.tsx`, via `zapInstructions.ts`) -- live and wired, not the "not yet built" placeholder this line previously described.

## `redeem_reserve_tokens_in_kind`
- **Signer:** `redeemer` (any holder -- permissionless; deliberately has no `ProtocolConfig` account at all, see DEC-0016).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (mut), `vault_authority` (PDA), `redeemer_reserve_token_account` (mut), `redeemer`, `manager_fee_recipients` (DEC-0094, optional -- used only for the TVL-fee piggyback below, unrelated to the redemption fee), `token_program`. **Remaining accounts:** `asset_count` groups of `[reserve_asset, vault, redeemer_asset_token_account, mint, token_program]`.
- **Args:** `reserve_tokens_to_redeem: u64`, `min_asset_amounts_out: Vec<u64>`.
- **Validation:** `status ∈ {Active, Paused, WindDown}`; `reserve_tokens_to_redeem > 0` and `<=` redeemer's balance; `total_supply_before > 0`; per-asset `entitlement >= min_asset_amounts_out[i]`.
- **State transition:** DEC-0094: piggybacks a TVL-fee checkpoint on pre-burn supply (`accrue_fees::checkpoint_tvl_fee`, same as `mint_reserve_tokens_in_kind` -- safe no-op if <1 day elapsed) before its own logic; unrelated to and does not affect the redemption fee below.
- **Token movement:** full `reserve_tokens_to_redeem` burned from redeemer; proportional entitlement (computed on the *net*, post-redemption-fee portion) transferred vault → redeemer per asset. The fee portion's backing assets are deliberately left in the vaults (accretion to remaining holders, not a mint to any fee recipient).
- **Event:** `ReserveTokensRedeemed`.
- **Errors:** `UnexpectedReserveStatus`, `ZeroValue`, `RedemptionExceedsEntitlement`, `ZeroSupply`, `ZeroAmountAfterFeesOrRounding`, `SlippageMinOutputNotMet`, `RemainingAccountsMismatch`.
- **Frontend use:** the Reserve-detail page's "Sell" tab (`src/merge/pages/DTRDetail.tsx`, via `zapInstructions.ts`) -- live and wired, not the "not yet built" placeholder this line previously described. Also the canonical "redeem via SDK with no website" path for the frontend-independence test requirement.

## `update_targets`
- **Signer:** manager, or co-manager with `UPDATE_TARGETS`.
- **Accounts:** `reserve` (mut), `delegate` (unchecked, conditionally validated), `signer`. **Remaining accounts:** `asset_count` `ReserveAsset` accounts (mut).
- **Args:** `new_target_weights_bps: Vec<u16>`.
- **Validation:** not paused; permission check; each asset either `enabled` or new weight is `0`; new sum `<= 10000`.
- **State transition:** each `ReserveAsset.target_weight_bps` overwritten; `Reserve.total_target_weight_bps`/`configured_at` updated. **Moves no tokens** (see SSR_ARCHITECTURE.md section 0 -- rebalance execution is a separate, deferred concern).
- **Token movement:** none.
- **Event:** `TargetsUpdated`.
- **Errors:** `ReservePaused`, `DelegatePermissionDenied`/`NotReserveManager` (via `require_reserve_permission`), `ReserveAssetDisabled`, `TargetWeightExceedsTotal`, `RemainingAccountsMismatch`.
- **Frontend use:** Manage → Rebalance tab, "Submit Rebalance" button (`src/merge/pages/ManageDTR.tsx`, via `executeSubmitRebalance`/`executeUpdateTargets` in `managementClient.ts`) -- changes intent only, no trade; also batched with `add_reserve_asset_active` calls in the same transaction when the proposed composition includes a not-yet-registered asset.

## `add_delegate`
- **Signer:** manager (unrestricted co-manager) or co-manager with `ADD_RESTRICTED_DELEGATE` (restricted co-manager only).
- **Accounts:** `reserve` (mut), `delegate_account` (init, PDA), `acting_delegate` (unchecked, the signer's own co-manager record if applicable), `signer`, `system_program`.
- **Args:** `delegate_wallet: Pubkey`, `permissions: u16`, `restricted: bool`.
- **Validation:** not paused; `permissions` has no reserved bits set; authority check depends on `restricted`.
- **State transition:** new `Delegate` account; `Reserve.delegate_count += 1`.
- **Token movement:** none.
- **Event:** `DelegateAdded`.
- **Errors:** `ReservedPermissionBitSet`, `DelegatePermissionDenied`, `UnrestrictedDelegateRequiresManager`.
- **Frontend use:** Manage → Co-Managers tab, "add co-manager."

## `update_delegate_permissions`
- **Signer:** manager (any co-manager) or co-manager with `ADD_RESTRICTED_DELEGATE` (restricted co-managers only).
- **Accounts:** `reserve` (read), `delegate_account` (mut, PDA), `acting_delegate` (unchecked), `signer`.
- **Args:** `new_permissions: u16`.
- **Validation:** not paused; reserved bits check; authority check by target's `restricted` flag.
- **State transition:** `Delegate.permissions` overwritten.
- **Token movement:** none.
- **Event:** `DelegatePermissionsUpdated`.
- **Errors:** same family as `add_delegate`.
- **Frontend use:** Manage → Co-Managers tab, "edit permissions."

## `remove_delegate`
- **Signer:** manager (any co-manager) or co-manager with `REMOVE_RESTRICTED_DELEGATE` (restricted co-managers only).
- **Accounts:** `reserve` (mut), `delegate_account` (mut, `close = signer`), `acting_delegate` (unchecked), `signer`.
- **Args:** none.
- **Validation:** authority check by target's `restricted` flag.
- **State transition:** `Delegate` account closed (rent reclaimed to `signer`); `Reserve.delegate_count -= 1`.
- **Token movement:** none (SOL rent reclaim only).
- **Event:** `DelegateRemoved`.
- **Errors:** `DelegatePermissionDenied`, `UnrestrictedDelegateRequiresManager`, `MathUnderflow`.
- **Frontend use:** Manage → Co-Managers tab, "remove."

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
- **Signer:** manager, or co-manager with `PAUSE_RESERVE`/`UNPAUSE_RESERVE` respectively.
- **Accounts:** `reserve` (mut), `delegate` (unchecked), `signer`.
- **Args:** none.
- **Validation:** `status == Active` (to pause) / `status == Paused` (to unpause); permission check.
- **State transition:** `status ↔ Paused/Active`.
- **Token movement:** none.
- **Events:** `ReservePaused` / `ReserveUnpaused`.
- **Errors:** `UnexpectedReserveStatus`, `ReserveNotPaused`, `DelegatePermissionDenied`.
- **Frontend use:** none currently -- a Pause/Unpause control WAS built into Manage → Overview, then deliberately removed per explicit product decision (2026-08-12, DEC-0086; see `docs/project/DECISION_LOG.md`). The on-chain instructions and the `PAUSE_RESERVE`/`UNPAUSE_RESERVE` permission-flag bits were left untouched (no program change), so the on-chain capability is unaffected, only its UI exposure. Currently only reachable via `scripts/devnet_fixtures.ts`'s fixture demo and this doc's own audit script.

## `accrue_fees`
- **Signer:** none required -- permissionless, pure accounting (see reference protocol's `distributeFees` precedent).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (read), `manager_fee_recipients` (DEC-0094, **optional**, same `None`-sentinel convention as `mint_reserve_tokens_in_kind`).
- **Args:** none.
- **Validation:** none beyond arithmetic overflow checks; no-ops (returns `Ok(())` early) if less than one full day has elapsed since the last checkpoint.
- **DEC-0094 fee formula (TVL fee), computed fresh every call:** `protocol_bps = max(50, annual_tvl_fee_bps / 2)`, `manager_bps = max(annual_tvl_fee_bps - protocol_bps, 0)` -- same formula/floor as the mint fee, applied to the TVL fee independently.
- **DEC-0094 cadence:** this core logic now lives in `checkpoint_tvl_fee` (shared), also called automatically from `mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` so a normal Buy/Sell checkpoints TVL fees for free -- this standalone instruction is now primarily the permissionless fallback for a dormant Reserve, triggered weekly by `api/devnet/accrue-fees-cron.ts` (Vercel Cron) with a ~25-day staleness threshold, well inside the 30-day requirement.
- **State transition:** `FeeConfig.pending_protocol_fee_shares` increases; the manager's share is credited via `common::credit_manager_fee_shares` (per-recipient if migrated, else the legacy aggregate) -- see `mint_reserve_tokens_in_kind` above. `last_fee_accrual_ts` advances by whole elapsed days.
- **Token movement:** none (accounting only).
- **Event:** `FeesAccrued`, plus `ManagerFeeShareAccrued` if migrated and manager total > 0.
- **Errors:** `MathOverflow`/`MathUnderflow`, `ManagerFeeRecipientsMismatch`, `InvalidFeeRecipientCount`.
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
- **DEC-0094 note:** left COMPLETELY UNTOUCHED by design -- for a Reserve that has opted into multi-recipient routing, `pending_manager_fee_shares` simply stays 0 forever (accrual now routes there instead -- see `mint_reserve_tokens_in_kind` above), so this instruction naturally degrades into a protocol-only collector with zero code change. Use the new `collect_manager_fee_share` below for a migrated Reserve's Manager-side payouts.

## `initialize_manager_fee_recipients` (new, DEC-0094)
- **Signer:** `signer` (root manager, or a co-manager holding `MANAGE_FEES`); `payer` (any wallet, covers the new account's one-time rent).
- **Accounts:** `reserve` (read), `manager_fee_recipients` (init, PDA `[b"manager_fee_recipients", reserve]`), `delegate` (unchecked, see `common::require_reserve_permission`), `signer`, `payer` (mut, signer), `system_program`.
- **Args:** `recipients: Vec<FeeRecipientInput>` (`{ wallet: Pubkey, allocation_bps: u16 }`, 1-10 entries).
- **Validation:** `MANAGE_FEES` permission; `Reserve.fee_config.pending_manager_fee_shares == 0` (collect the legacy aggregate first); recipient list: 1-10 entries, no zero/default wallet, no zero allocation, no duplicate wallet, allocations sum to exactly 10,000 bps.
- **State transition:** new `ManagerFeeRecipients` account populated (fixed 10-slot array, `recipient_count` set), `routing_updated_at = now`.
- **Token movement:** none.
- **Event:** `ManagerFeeRecipientsConfigured`.
- **Errors:** `PendingFeesBlockRoutingChange`, `InvalidFeeRecipientCount`, `FeeRecipientZeroAddress`, `ZeroFeeRecipientAllocation`, `DuplicateFeeRecipientWallet`, `FeeRecipientAllocationNotFull`, `DelegatePermissionDenied`.
- **Frontend use:** Create Reserve's "Fee Routing" step (bundled into the create transaction for >1 recipient) and Manage Reserve's "Set Up Recipients" action (for a Reserve that hasn't opted in yet).

## `update_fee_recipients` (new, DEC-0094)
- **Signer:** `signer` (root manager, or a co-manager holding `MANAGE_FEES`).
- **Accounts:** `reserve` (read), `manager_fee_recipients` (mut, must already exist), `delegate` (unchecked), `signer`.
- **Args:** `recipients: Vec<FeeRecipientInput>` (same shape/validation as above).
- **Validation:** `MANAGE_FEES` permission; every CURRENT recipient's `pending_fee_shares == 0` (so a routing change can never reallocate already-accrued fees); same recipient-list validation as `initialize_manager_fee_recipients`.
- **State transition:** overwrites `recipients`/`recipient_count`/`routing_updated_at`; carries forward each surviving wallet's lifetime `collected_fee_shares` by identity (not slot index).
- **Token movement:** none.
- **Event:** `ManagerFeeRecipientsConfigured`.
- **Errors:** `PendingFeesBlockRoutingChange`, `InvalidFeeRecipientCount`, `FeeRecipientZeroAddress`, `ZeroFeeRecipientAllocation`, `DuplicateFeeRecipientWallet`, `FeeRecipientAllocationNotFull`, `DelegatePermissionDenied`, `ManagerFeeRecipientsMismatch`.
- **Frontend use:** Manage Reserve's "Change Routing" action -- auto-bundles a `collect_manager_fee_share` per current recipient with a nonzero pending balance into the same transaction first (see `src/merge/lib/managementClient.ts`'s `executeUpdateFeeRecipients`).

## `collect_manager_fee_share` (new, DEC-0094)
- **Signer:** `payer` (permissionless trigger, pays destination-ATA rent if needed -- cannot redirect funds).
- **Accounts:** `reserve` (mut), `reserve_token_mint` (mut), `mint_authority` (PDA), `manager_fee_recipients` (optional, `None` sentinel for the legacy fallback path), `recipient` (unchecked -- validated against the on-chain array or `fee_config.fee_destination` in the handler), `recipient_token_account` (init_if_needed ATA), `payer`, `token_program`, `associated_token_program`, `system_program`.
- **Args:** none.
- **Validation:** `recipient` must match a configured recipient (or the legacy `fee_destination`); that recipient's pending balance must be nonzero.
- **State transition:** zeroes that ONE recipient's `pending_fee_shares`, increments its `collected_fee_shares` (or, legacy path, zeroes `FeeConfig.pending_manager_fee_shares`).
- **Token movement:** mints the recipient's pending amount to their own ATA.
- **Event:** `ManagerFeeShareCollected`.
- **Errors:** `RecipientNotFound`, `NoPendingFees`, `ManagerFeeRecipientsMismatch`.
- **Frontend use:** Manage Reserve's per-recipient "Collect" button.

## `record_rebalance`
- **Signer:** co-manager with `EXECUTE_REBALANCE` (or manager).
- **Accounts:** `reserve` (read), `delegate` (unchecked), `signer`. **Remaining accounts:** `asset_count` pairs of `[reserve_asset, vault]`.
- **Args:** `balances_before: Vec<u64>` (caller-attested, **not independently verified on-chain** -- see SECURITY_INVARIANTS.md and the module doc comment in record_rebalance.rs), `note: String`.
- **Validation:** permission check; account/count matching.
- **State transition:** none (pure attestation/event emission).
- **Token movement:** none -- **v1 has no on-chain trade-execution instruction at all**; the actual asset-swapping trade happens outside this program (deferred per DEC-0017), and this instruction only records the outcome for indexing.
- **Event:** `RebalanceRecorded`.
- **Errors:** `DelegatePermissionDenied`, `RemainingAccountsMismatch`, `ReserveAssetMismatch`, `InvalidReserveVault`.
- **Frontend use:** none currently wired -- the live Rebalance tab's "Submit Rebalance" flow (2026-08-12, DEC-0084) only calls `update_targets`/`add_reserve_asset_active` (a pure config-intent change), not this attestation instruction; `record_rebalance` belongs to an earlier/parallel "manager manually trades externally, then attests the outcome" design that the current UI doesn't expose a step for. Still a real, deployed, callable instruction -- exercised directly for this doc's audit (see `docs/protocol/DEVNET_INSTRUCTION_AUDIT_2026-08-13.md`).

## `update_metadata`
- **Signer:** manager, or co-manager with `UPDATE_METADATA`.
- **Accounts:** `reserve` (mut), `delegate` (unchecked), `signer`.
- **Args:** `new_metadata_uri: String`.
- **Validation:** length check; permission check.
- **State transition:** `Reserve.metadata_uri` overwritten, `configured_at` updated.
- **Token movement:** none.
- **Event:** `MetadataUpdated`.
- **Errors:** `MetadataUriTooLong`, `DelegatePermissionDenied`.
- **Frontend use:** none currently wired -- no "edit Reserve description/logo" UI feature exists yet. Metadata itself lives off-chain at the referenced URI, matching the mission's "metadata reference" field guidance.

## `update_protocol_config`
- **Signer:** `authority` (either Protocol Admin -- `ProtocolConfig.authority` or `admin_2` -- act independently).
- **Accounts:** `protocol_config` (mut, `constraint = protocol_config.is_admin(&authority.key())`), `authority`.
- **Args:** `new_default_protocol_fee_destination: Pubkey`, `new_default_protocol_fee_bps: u16`.
- **Validation:** signer must be one of the two configured admins (`ProtocolConfig::is_admin`); no cap check on the new fee bps value itself -- the caller is trusted admin input.
- **State transition:** `ProtocolConfig.default_protocol_fee_destination`/`default_protocol_fee_bps` overwritten.
- **Token movement:** none.
- **Event:** `ProtocolConfigUpdated`.
- **Errors:** `NotProtocolAuthority`.
- **Frontend use:** none currently wired -- admin-only, invoked historically to set the real DevNet treasury address (2026-07-28, DEC-0033/DEC-0035) but not exposed in the product UI. `initialize_protocol` only ever runs once, so this is the only way to correct the treasury address after genesis.

## `set_protocol_paused`
- **Signer:** `authority` (either Protocol Admin, same independent-admin model as `update_protocol_config`).
- **Accounts:** `protocol_config` (mut, `constraint = protocol_config.is_admin(&authority.key())`), `authority`.
- **Args:** `paused: bool`.
- **Validation:** signer must be one of the two configured admins.
- **State transition:** `ProtocolConfig.paused` set directly.
- **Token movement:** none.
- **Event:** `ProtocolPausedSet`.
- **Errors:** `NotProtocolAuthority`.
- **Frontend use:** none -- admin/ops-only, invoked via CLI/SDK script, not exposed in the product UI. Added in the Mainnet authority-model pass: `ProtocolConfig.paused` existed and was checked by `create_reserve`/`mint_reserve_tokens_in_kind`/`seed_reserve` since v1, but no instruction had ever set it -- this was the only way to actually engage the documented global emergency pause, and it did not previously exist.

## `add_reserve_asset_active`
- **Signer:** manager, or co-manager with `MANAGE_LIQUIDITY_CONFIG`.
- **Accounts:** `protocol_config` (read), `reserve` (mut), `reserve_asset` (init, PDA), `asset_mint`, `vault` (init, PDA token account), `vault_authority` (PDA, unchecked), `delegate` (unchecked), `signer`, `token_program`, `system_program`.
- **Args:** `target_weight_bps: u16`.
- **Validation:** `Reserve.status == Active` (deliberately separate from `initialize_reserve_asset`, which only runs pre-Active -- see the module doc comment for why splitting these two keeps the pre-Active creation flow's account interface unchanged); permission check; same weight/limit/token-program checks as `initialize_reserve_asset`.
- **State transition:** `asset_count += 1`; registers the asset at `order_index = asset_count` (pre-increment).
- **Token movement:** none (vault created empty -- registration only, funding is a separate step).
- **Event:** `ReserveAssetAdded` (distinct from `initialize_reserve_asset`'s `ReserveAssetInitialized`, despite both being "a new asset slot was registered").
- **Errors:** `UnexpectedReserveStatus`, `ReserveAssetLimitReached`, `TargetWeightExceedsTotal`, `MathOverflow`, `DelegatePermissionDenied`.
- **Frontend use:** Manage → Rebalance tab, "Submit Rebalance" (`executeSubmitRebalance` registers each not-yet-on-chain asset at 0 bps in the same transaction, immediately followed by one `update_targets` call covering every asset's real final weight -- see DEC-0084 for why: registering directly at a nonzero weight could blow the 10,000bps cap before `update_targets` has a chance to rebalance the total).

## `fund_new_reserve_asset`
- **Signer:** `manager` (root-only, no co-manager path; `reserve` is read-only here, `has_one = manager` enforces it).
- **Accounts:** `reserve` (read, `has_one = manager`), `reserve_asset` (read), `asset_mint`, `vault` (mut), `manager_token_account` (mut), `manager`, `token_program` (Interface, SPL Token or Token-2022).
- **Args:** `amount: u64`.
- **Validation:** `Reserve.status == Active`; `amount > 0`; the target vault's balance must be exactly zero (a one-time bootstrap, not a general top-up -- see the module doc comment: `mint_reserve_tokens_in_kind`'s deposit math is purely balance-ratio-based, so a vault stuck at 0 could never be funded through ordinary Buy activity).
- **State transition:** none beyond the transfer (additive-only -- no Reserve Token minted; a pure backing increase that benefits every existing holder and dilutes nobody).
- **Token movement:** `amount` transferred manager → vault (CPI, manager's own signature).
- **Event:** `ReserveAssetFunded`.
- **Errors:** `NotReserveManager`, `ReserveAssetMismatch`, `InvalidReserveVault`, `UnexpectedReserveStatus`, `ZeroValue`, `VaultNotEmpty`.
- **Frontend use:** Manage → Rebalance tab, "Fund {symbol}" (`executeFundReserveAsset` in `managementClient.ts`) -- a separate, individually-approved maintenance action, distinct from "Submit Rebalance".

## `remove_reserve_asset`
- **Signer:** manager, or co-manager with `MANAGE_LIQUIDITY_CONFIG`.
- **Accounts:** `reserve` (mut), `reserve_asset` (mut, `close = manager`), `asset_mint`, `vault` (mut, closed), `vault_authority` (PDA, unchecked), `manager` (unchecked, rent destination -- always the Reserve's root manager, never the calling co-manager), `delegate` (unchecked), `signer`, `token_program` (Interface).
- **Args:** none.
- **Validation:** `Reserve.status ∈ {AssetsInitializing, Active, Paused}`; permission check; target must be the LAST-registered asset (`order_index == asset_count - 1`, so no other asset's `order_index` needs to shift); its vault balance must be exactly zero (removal can never strand value attributable to existing holders).
- **State transition:** `asset_count -= 1`; `ReserveAsset` and vault accounts closed, rent reclaimed to `manager`.
- **Token movement:** none (vault is already empty by the validation above).
- **Event:** `ReserveAssetRemoved`.
- **Errors:** `UnexpectedReserveStatus`, `DelegatePermissionDenied`, `MathUnderflow`, `AssetNotLastRegistered`, `VaultNotEmpty`, `ReserveAssetMismatch`, `InvalidReserveVault`, `NotReserveManager`.
- **Frontend use:** Manage → Rebalance tab, "Remove {symbol}" (`executeRemoveReserveAsset` in `managementClient.ts`) -- only enabled for an asset that is both last-registered and currently zero-balance.

## `initiate_wind_down`
- **Signer:** `manager` (root-only, no co-manager path -- matches the "root-exclusive unless explicitly defined otherwise" authority model, same as `transfer_reserve_manager`).
- **Accounts:** `reserve` (mut), `manager`.
- **Args:** none.
- **Validation:** `Reserve.status == Active`.
- **State transition:** one-way `Active → WindDown`. Deliberately does NOT revoke the Reserve Token mint authority (`collect_fees` still needs it during WindDown); new issuance is already blocked with zero extra code since `mint_reserve_tokens_in_kind` requires `status == Active` exactly.
- **Token movement:** none.
- **Event:** `WindDownInitiated`.
- **Errors:** `UnexpectedReserveStatus`.
- **Frontend use:** Manage → Overview, "Initiate Wind Down" (`executeInitiateWindDown` in `managementClient.ts`).

## `close_reserve`
- **Signer:** `manager` (root-only, no co-manager path).
- **Accounts:** `reserve` (mut, closed), `reserve_token_mint` (mut), `vault_authority` (PDA), `manager_fee_recipients` (DEC-0094, optional, closed too when present -- rent reclaimed to `manager`), `manager`, `token_program`. **Remaining accounts:** `asset_count` pairs of `[reserve_asset, vault]`, in `order_index` order (lighter than `mint`/`redeem`'s per-leg groups -- no owner-token-account/mint/token-program needed per leg here).
- **Args:** none.
- **Validation:** `Reserve.status == WindDown`; Reserve Token supply must be exactly zero; every registered asset's vault balance must be exactly zero (i.e. every holder has already redeemed out -- redemption stays available during `WindDown`); the legacy aggregate `pending_manager_fee_shares`/`pending_protocol_fee_shares` must both be zero (`PendingFeesNotCollected`, DEC-0093); if `manager_fee_recipients` is present, every active recipient's `pending_fee_shares` must also be zero (`PendingManagerFeeSharesNotCollected`, DEC-0094 -- the legacy check alone can't catch this for a migrated Reserve, since its aggregate field stops accumulating once migrated).
- **State transition:** terminal `WindDown → Closed`, immediately followed by closing the `Reserve` account itself, every `ReserveAsset` account, the `ManagerFeeRecipients` account if present, and every vault token account -- rent reclaimed to `manager`. Deliberately does NOT attempt to close the `reserve_token_mint` account (SPL Token mint-account closing semantics are a live-program risk not worth taking for a small amount of permanently-locked rent).
- **Token movement:** none (all balances already zero by the validation above).
- **Event:** `ReserveClosed`.
- **Errors:** `NotReserveManager`, `UnexpectedReserveStatus`, `ReserveTokenSupplyNotZero`, `PendingFeesNotCollected`, `PendingManagerFeeSharesNotCollected`, `ManagerFeeRecipientsMismatch`, `RemainingAccountsMismatch`, `ReserveAssetMismatch`, `InvalidReserveVault`, `VaultNotEmpty`.
- **Frontend use:** Manage → Overview, "Close Reserve" (`executeCloseReserve` in `managementClient.ts`).
