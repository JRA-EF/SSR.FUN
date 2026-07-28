<!--
  Test plan for the SSR Protocol, structured per the mission's own Testing
  Requirements categories. Marks what's actually written (tests/ssr_protocol.ts)
  vs. planned.

  UPDATE 2026-07-28: the full suite has now been EXECUTED against the live
  DevNet program (not just typechecked) via
  `npx mocha --require ts-node/register tests/ssr_protocol.ts` with
  ANCHOR_PROVIDER_URL pointed at https://api.devnet.solana.com and
  ANCHOR_WALLET pointed at the funded deployer keypair. Result: 14 passing,
  0 failing. See DEVNET_RUNBOOK.md for the full run record.
-->

# Test Plan

## Status legend
- ✅ **PASSED** -- exists in `tests/ssr_protocol.ts`, executed against the live DevNet program, and passed (2026-07-28 run, 14/14).
- ✅ **Written** -- exists in `tests/ssr_protocol.ts`, typechecks, not yet executed.
- ⏳ **Planned** -- not yet written.

## Unit tests (target: Rust, ideally via `litesvm` per Anchor 1.0's default template -- see DEVNET_RUNBOOK.md)

None written yet at the Rust unit level (would live under `programs/ssr_protocol/tests/` or inline `#[cfg(test)]` modules using `litesvm` for in-process, no-validator-needed speed). Planned coverage, mapped to `instructions/common.rs`'s pure functions:
- ⏳ `mul_div_ceil`/`mul_div_floor`: zero denominator, overflow at `u64::MAX` boundaries, exact-division cases, non-exact rounding in both directions.
- ⏳ Target-weight validation: exact 10,000 boundary, one-over-boundary rejection, disabled-asset-with-nonzero-weight rejection.
- ⏳ Duplicate-asset detection (structural, via `init` on an existing PDA -- more naturally an integration-level test, see below).
- ⏳ Delegate permission bitmask: every individual flag in isolation, reserved-bit rejection, `ALL_V1_FLAGS` mask correctness.
- ⏳ PDA derivation determinism: same inputs always produce the same address (trivial but worth asserting once compiling, to catch a seed-order typo early).
- ⏳ Zero-supply guard on mint/redeem calculators.
- ⏳ Overflow handling for every `checked_*` call site (deliberately construct near-`u64::MAX` inputs).

## Integration tests (Anchor `tests/ssr_protocol.ts`, TypeScript)

✅ **PASSED** (all in `tests/ssr_protocol.ts`, executed 2026-07-28 against live DevNet, 14/14 passing):
- Protocol initialization. (Made idempotent-safe for a persistent network: `ProtocolConfig` is a true one-time singleton PDA, so on a re-run it detects the already-initialized account via `fetchNullable` and verifies its contents instead of re-sending `initializeProtocol`, which would fail with "already in use" on a network that doesn't reset state between runs the way a local validator does.)
- Reserve creation.
- Reserve Asset registration (two assets, weights summing to exactly 10,000).
- Duplicate Reserve Asset rejection.
- Vault creation (implicit in the above -- not separately asserted for balance-zero state; ⏳ add an explicit assertion).
- Reserve Token mint creation (implicit; ⏳ add an explicit decimals/authority/freeze-authority assertion).
- Initial seeding (asserts vault balances and nonzero recipient balance -- fixed a stale-snapshot test bug where the recipient's token-account object was checked before re-fetching post-transaction state, which made the assertion vacuously pass against pre-transaction data; now re-fetches via `getAccount` after the `seedReserve` call).
- Rejecting re-seeding an already-`Active` Reserve.
- A second holder minting proportionally.
- A second holder redeeming proportionally (partial redemption).
- Unauthorized pause attempt (random wallet) rejected.
- Manager pause → unpause round-trip.
- Restricted delegate granted `UPDATE_TARGETS` only: succeeds at updating targets, fails at pausing (privilege-boundary check).
- Rejecting re-initialization of the `ProtocolConfig` singleton (repeated `initialize_protocol`).
- Rejecting redemption of more Reserve Tokens than the caller's actual balance.

⏳ **Planned, not yet written:**
- Multiple mint operations from multiple holders in sequence (supply/ratio consistency across 3+ mints).
- Multiple redemptions in sequence.
- Root manager transfer.
- Fee accrual (`accrue_fees`) across simulated day boundaries (needs local-validator clock manipulation or a `litesvm`-style test harness with a controllable clock -- `anchor test`'s default validator clock behavior needs checking once available).
- Fee collection (`collect_fees`) minting to manager/protocol destinations and resetting pending counters.
- `update_metadata` happy path.
- `remove_delegate` happy path (including rent-reclaim assertion).
- Unrestricted vs. restricted delegate distinction: an unrestricted delegate can add/remove restricted delegates; a restricted delegate cannot grant/revoke an unrestricted one.
- Successful AND failed transactions for every instruction (this plan currently over-indexes on happy paths + a few adversarial cases; a systematic failure-mode sweep per instruction, cross-referenced against each `errors.rs` variant, is still needed).

## Adversarial tests

✅ **PASSED** (executed 2026-07-28 against live DevNet):
- Unauthorized (non-manager, non-delegate) pause attempt.
- Delegate privilege escalation (delegate without `PAUSE_RESERVE` cannot pause).
- Duplicate Reserve Asset registration.

⏳ **Planned, not yet written** (mapped to the mission's required scenario list):
- Wrong Reserve account supplied to an instruction expecting a specific Reserve.
- ✅ **PASSED**: wrong Reserve Vault supplied / cross-Reserve vault substitution (**the single most important test in this entire plan** -- proves invariant 5 in SECURITY_INVARIANTS.md). `tests/ssr_protocol.ts`'s "cross-Reserve isolation" test creates two real Reserves on live DevNet and confirms substituting Reserve Two's vault into a Reserve-One mint call is rejected on-chain.
- Forged Reserve Token mint (supplying an attacker-controlled mint account in place of the real `reserve_token_mint`).
- Malicious remaining-account substitution (e.g. swapping the order of two legitimate assets to try to trick `order_index` validation, or substituting a legitimate vault from the SAME Reserve for the wrong asset).
- Invalid token program (a mint owned by neither classic SPL Token nor Token-2022).
- Direct vault-drain attempt (any instruction, any signer, trying to move vault tokens outside `mint`/`redeem`'s own transfer calls -- should be impossible by construction, but worth a negative test attempting to CPI `transfer_checked` directly against a vault from a non-program context).
- ✅ **PASSED**: excess redemption (redeeming more than the caller's Reserve Token balance).
- Unbacked mint attempt (trying to mint before seeding, or with insufficient vault balance).
- Rounding-direction attacks (repeated tiny mints/redeems probing whether a sequence can extract more value than deposited -- adapt the reference protocol's "Extreme" parametrized sweep concept, see RESERVE_REFERENCE_ANALYSIS.md section 17).
- ✅ **PASSED** (protocol singleton only): repeated `initialize_protocol` re-init is rejected. ⏳ **Still planned**: the same test for `create_reserve`/`initialize_reserve_asset` against an already-used PDA.
- Replay-like repeated workflow execution (resubmitting an already-executed transaction -- largely a Solana-runtime-level guarantee via recent-blockhash/nonce mechanics, but worth an explicit test to confirm no custom code accidentally weakens it).
- Partial multi-step execution (abandoning Reserve creation after `create_reserve` but before any `initialize_reserve_asset`, or after some-but-not-all assets registered, then attempting to mint/redeem -- should fail on `Reserve.status`).
- Invalid fee recipient (`collect_fees` with a `manager_fee_destination` that doesn't match `Reserve.fee_config.fee_destination`).
- Paused-operation bypass attempts (trying to mint, update targets, or otherwise act on a paused Reserve through any code path).
- Fake metadata authority (calling `update_metadata` without `UPDATE_METADATA` permission).
- Dishonest/malicious token behavior: a mock Token-2022 mint with a rejected extension, attempting to register it anyway (tests `validate_asset_mint_extensions`).

## Frontend-independence tests

⏳ **Planned, not yet written.** Once Gate 8/9 produce a real deployed program and Gate 6's SDK is validated against it, write a standalone script (no website, no indexer) that: derives a Reserve's accounts from just its `reserveId`; reads live state; computes a proportional mint via `packages/sdk`'s calculators; builds and submits a real mint transaction; computes and submits a real redemption; all using only `@solana/web3.js` + `packages/sdk` + a keypair. This directly exercises the mission's frontend-independence requirement and should be kept as a permanent script/test, not a one-off.

## Property / invariant testing

⏳ **Planned, not yet written.** Given the toolchain gap, no Foundry-style `invariant`/fuzz equivalent has been run. Once `litesvm`-based Rust tests are possible, adopt the reference protocol's "Extreme" pattern (RESERVE_REFERENCE_ANALYSIS.md section 17): hand-built parameter sweeps across token decimals (6/9/18 if ever relevant on Solana -- Solana tokens are more commonly 6-9 decimals than EVM's typical 18, so the sweep range should reflect that), amounts, and fee rates, asserting: solvency (vault-value-per-share never decreases outside documented fee mechanics); proportional ownership preserved across sequences of mint/redeem/target-change/fee-accrual; dust stays bounded; no cross-Reserve access is ever achievable; no unauthorized authority escalation survives a sequence of delegate/manager operations.

## What "done" looks like for Gate 7 (Local Validation)

Per the mission's own Gate 7 checklist: formatting (`cargo fmt --check`), linting (`cargo clippy`), Rust build (`cargo build` / `anchor build`), unit tests, integration tests, invariant tests where available, SDK typecheck (✅ **already passing**, see DEVNET_RUNBOOK.md), frontend typecheck (✅ **already passing**, unrelated to this protocol work), production frontend build (✅ **already passing**, unrelated). The four Rust/Anchor-dependent items remain blocked on the toolchain gap.
