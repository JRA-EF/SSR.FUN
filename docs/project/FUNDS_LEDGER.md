<!--
  Standing, append-only ledger of every situation where real money (SOL or
  other real value) is locked, at risk, or recoverable across this project --
  DevNet and Mainnet alike. Created per Creator (Claude User)'s explicit
  instruction (2026-08-17): "any situations where there might be loss of
  money, you will track everything." See docs/project/DECISION_LOG.md
  DEC-0106 for the confirmed decision this implements.

  Rules (mirrors DECISION_LOG.md's append-only convention):
  - Never edit or delete a previous entry's substantive fields. A status
    change (e.g. "locked" -> "recovered") gets a new entry or an explicit
    "Status update" line appended to the existing one -- never a silent edit.
  - Add an entry the same session any account is created, funded, abandoned,
    closed, or recovered, whenever real (non-test-faucet) money is involved,
    or whenever a DevNet situation sets a real precedent for a Mainnet risk.
  - This file tracks and reports. It does NOT authorize moving money. See
    "Recovery-request policy" below.
-->

# Funds Ledger

Tracks every account/situation where SOL (or other real value) is locked as
a rent-exemption deposit, temporarily at risk during a deploy, abandoned, or
recoverable -- so nothing is ever quietly forgotten between sessions.

## How Solana rent-exemption actually works here (read before adding an entry)

"Rent" on Solana is a one-time minimum-balance deposit, not a recurring fee.
Lamports held for rent-exemption are never spent or burned -- they are the
account's own balance, for as long as the account exists.

- **Upgrading a program (same program ID)** does not re-charge full rent --
  only the size *delta* if the new binary exceeds the already-reserved max
  length. Nothing already locked is lost on redeploy.
- **Getting locked SOL back always requires a deliberate close**, never an
  automatic side effect of anything else:
  - Program accounts: `solana program close <program-id>` -- reclaims the
    full balance to a wallet named at that moment. One-way: permanently
    disables that program ID. Never to be run without an explicit,
    same-session confirmation of exactly which program and destination.
  - Reserve accounts: `close_reserve` (see `programs/ssr_protocol/src/instructions/close_reserve.rs`)
    already returns Reserve/ReserveAsset/vault rent to the Reserve's manager
    automatically once wind-down reaches zero supply -- no separate action
    needed once a Reserve is genuinely closeable.
  - Deploy buffers: an interrupted deploy leaves an orphaned buffer account
    holding its own rent-exemption deposit -- reclaimable via
    `solana program close --buffers` while the buffer authority is still
    held, otherwise it sits locked, doing nothing.
- **The only true permanent-loss case:** losing the authority keypair that
  controls an account. Then no one can ever close it. This is why Creator's
  authority wallet is documented as security-critical (see
  `docs/project/DECISION_LOG.md` DEC-0105).

## Recovery-request policy

Tracking is standing and automatic (this file). **Actually moving any real
money is not.** A request to "push"/sweep/consolidate recoverable funds
requires, at the time of the request, an explicit confirmation of:
source account, exact amount, and destination address -- never inferred from
this ledger alone and never executed as a standing blanket authorization.
This matches how every other irreversible action in this project is
handled (see CLAUDE.md's "Executing actions with care").

**Default documented recovery destination (per Creator (Claude User)'s
instruction, 2026-08-17):** `6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen`
-- already an active wallet in this project (Reserve manager for reserveId
34/35/36/18/66; a Manager fee-share recipient elsewhere in the on-chain
history). Recorded here as instructed, not independently verified as
belonging to Creator or the boss.

## Ledger

### 2026-08-17 -- Standing policy created (DEC-0106)
- **Status:** N/A (policy entry, not a fund event).
- **Detail:** This file created; recovery-request policy and default
  destination recorded above.

### DevNet -- reserve_id 6 (`9y18purN7zmHRqBaByzc22BTGx48FkH65HHevq3AxmUc`)
- **Status:** Locked, NOT recoverable in v1 (no reclaim instruction exists
  for this case).
- **Detail:** An interrupted run of `scripts/devnet_fixtures.ts` (public RPC
  rate-limiting mid-flow, 2026-07-28) left this Reserve with 2 assets
  registered but never seeded, permanently stuck in `AssetsInitializing`.
  The creator's rent for the `Reserve`/`ReserveAsset`/vault accounts stays
  locked indefinitely -- an accepted, documented v1 limitation (real DevNet
  SOL, not test-faucet play money, but immaterial at DevNet valuation).
  See `docs/protocol/SECURITY_INVARIANTS.md`'s "Outstanding gaps" and
  `docs/protocol/DEVNET_RUNBOOK.md`'s "Wallet / fixture safety" section.
- **Mainnet implication:** the same v1 program has no `close_abandoned_reserve`
  instruction on Mainnet either -- an interrupted Reserve creation on Mainnet
  will lock real rent the same way, with no recovery path, until/unless such
  an instruction is built. Flagged here as a real pre-Mainnet engineering gap,
  not yet a decision to build it.

### Mainnet -- program deployment (pending, not yet incurred)
- **Status:** Estimated only. No Mainnet deploy has happened.
- **Detail:** Based on the last known DevNet-compiled program size (874,952
  bytes, DEC-0100/101/102/103) and Solana's 2-year rent-exemption rate
  (~6,960 lamports/byte): ~6.1 SOL rent-exemption for the program account
  alone (~$460 at the 2026-08-16 SOL/USD price of ~$75.4), plus negligible
  chunked-write transaction fees. Recommended working balance on the Mainnet
  deployer wallet before attempting deployment: ~10-12 SOL, to also cover
  `ProtocolConfig` initialization, initial closed-launch Reserve creation,
  and the kind of last-minute size-delta top-up DevNet needed more than once
  (DEC-0099, DEC-0100-103). Re-estimate against the actual compiled `.so`
  size and live SOL price immediately before the real deploy -- this figure
  will drift.
- **Recoverable how:** in full, only via a deliberate `solana program close`
  against the new Mainnet program ID -- a one-way action disabling that
  program ID, never to be run without a fresh explicit confirmation.
