# Yeh's revenue policy implementation — DEC-0232

- Date: 2026-10-11
- Author: Yeh via Codex
- Branch: feature/raydium-permissioned-cpmm
- Deployed to: none
- Decision: DEC-0232; next free ID 0233 (check other branches first)

## Implemented

Mint, initial seed and redemption now use an unconditional SSR floor: max(50 bps, half configured fee), including configured zero. Annual TVL retains the existing zero exemption. Rust handlers, SDK calculations/builders/discovery, creation preview and configurable redemption fee are aligned.

New per-Reserve liquidity_revenue PDA becomes the native Raydium CPMM pool creator. Fixed-destination distribution carves SSR's 0.05% native-fee-base equivalent from the existing creator bucket. At the observed 5% Raydium retention, SSR receives 4/57 of collected USDC, creator 53/57. Fractional carry prevents collection fragmentation evading SSR. The ratio is pinned at registration; retention/config changes fail closed and require reconciliation before future migration. Direct native collection can only deposit into the PDA, never bypass the split.

Optional 0-2% per-side project tax is secondary-only: on-chain Raydium swap wrapper, 25% SSR/75% creator, tax on gross USDC input for Buy or actual USDC output for Sell. Final net minimum output is enforced atomically. Direct external swaps bypass this optional interface tax; the Token-2022 transfer fee remains independent, 0.15% (0.25% ceiling), entirely SSR in Reserve Tokens. No mint/redeem tax module, legacy metadata fields or tax transaction step restored.

Prepared atomic native pool creation + revenue registration, native collection + distribution, and SDK instruction builders; generated IDL includes the three new instructions, revenue state/events and appended errors. Existing instruction layouts, account layouts and error codes preserved. Builders never sign/submit. Initial payer asset ownership and LP ownership exposed explicitly. UI still design preview; no live liquidity flow enabled. Review notes and all governing docs updated.

## Open gates and effect on others

- OPEN-14: funding/signing arrangement for Raydium-approved payer and return of LP ownership. An asynchronous question is pending. No service custody or private key assumed. Creation requires payer and Reserve manager signatures.
- OPEN-13: live Compound remains blocked until Reserve Token sourcing is selected. No live Compound builder.
- Timed/permanent lock workflows and keyed real-basket Jupiter quote verification remain pending. Arbitrage script now includes effective redemption minimum, Reserve transfer fee and preferred CPMM versus CLMM fallback; quoted basket costs remain independent by direction. No new live quote report claimed.
- Release must coordinate program upgrade, IDL/SDK and frontend: current deployed economics have not been changed. Do not deploy frontend fee previews independently of the program update.
- Existing ManageDTR hooks-order issue untouched. Unrelated untracked .claude/launch.json left untouched. No Raydium outreach, deployment, signing, pool creation, or merge to design/staging/main.

## Verification and limitations

- 31 Rust unit tests pass, including hostile pool/config validation, fee conservation, transaction minimum and split-fragmentation checks.
- Full offline phase suite: 1362 passing / 4 pre-existing chart/native-control-reset failures. Updated three older expectations for the newly authorized minimum; terminology and mint/redeem tax-isolation protections remain intact.
- SDK build, app typecheck and Vite production build pass. Generated IDL checked to preserve all existing instruction layouts and error definitions. Focused revenue/pool/mint/redeem suites pass.
- SBF compiler exits successfully and generates artifacts/IDL, but reports stack-limit violations in older instructions plus unresolved-syscall warnings. An untouched HEAD checkout reproduces the same affected instructions and syscall list. New liquidity_revenue functions produce no stack-limit diagnostic. This is NOT a clean deployment-ready build; resolve these toolchain/runtime checks before any program release.
- No end-to-end Raydium CPI transaction simulation, mainnet execution or new audit claimed. Native preparation layouts checked against previously inspected Raydium source revision b3187ae53a1b95a201f855a59024a12ca8f5b51a. No dependency installed or third-party skill executed.
