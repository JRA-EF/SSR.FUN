# MetaMask turned off in production (VITE_ENABLE_METAMASK)

- **Date:** 2026-10-23
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `fix/metamask-off` -> `main`
- **Deployed to:** production `dpl_9svA1wuVmPXJPSLWcooTHcVAYirX` (ssr.fun, main a37734f; an identical first build `ssr-9gjkjsimx` also exists); staging not redeployed
- **Decision log:** none (feature switch, same pattern as DEC-0245)

## What shipped
Creator, 2026-10-23: "lets turn off metamask on production for now - it needs some fixing". MetaMask (2026-10-21, `2026-10-21-joao-metamask-wallet.md`) now hides behind one build-time switch, `VITE_ENABLE_METAMASK`, off unless set to `true` -- the same mechanism as `VITE_ENABLE_EVM` and `VITE_ENABLE_LIQUIDITY`. With it off:
- the Solana wallet picker shows Backpack, Phantom and Solflare only;
- a returning visitor whose saved wallet (`ssr.fun:walletName`) is MetaMask has that choice forgotten before the wallet provider mounts, so autoConnect does not reconnect it. They see the picker as a new visitor would.

The EVM (Robinhood Chain) picker is not gated: it only exists when `VITE_ENABLE_EVM=true`, which production does not set.

## Code touched
- `src/merge/lib/metamaskFeature.ts` (new) -- `METAMASK_ENABLED`, `WALLET_NAME_STORAGE_KEY`, `forgetDisabledWalletChoice()`.
- `src/components/WalletModal.tsx` -- `WALLET_OPTIONS` filters MetaMask out when the switch is off.
- `src/merge/lib/SolanaProviders.tsx` -- calls `forgetDisabledWalletChoice()` at module load; the storage key comes from the shared constant.
- `.env.example` -- documents the variable.
- `tests/phase_metamask_feature.ts` (new) -- source contract for the gate.

## Effect on others -- READ THIS
- To work on MetaMask, build with `VITE_ENABLE_METAMASK=true` (local `.env.local`, or the staging project's env). Staging does NOT have it set yet, so the next staging build also hides MetaMask until someone adds it.
- Turning it back on in production = set `VITE_ENABLE_METAMASK=true` on `ssr-fun` and rebuild. Nothing else changes.

## Verification
`tsc -b` clean (after rebuilding `packages/sdk`), oxlint on the changed files clean, `tests/phase_metamask_feature.ts` 3 passing plus the wallet-related suites (31 passing). Built both ways with `VITE_SOLANA_CLUSTER=mainnet-beta`: switch off, the bundle carries `.filter(e=>e.id!==\`metamask\`)` and the saved-choice cleanup; switch on, `.filter(e=>!0)` and no cleanup.
