# MetaMask connects on Solana, and can be picked on every EVM connect button

- **Date:** 2026-10-21
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `fix/metamask-solana` -> `main`
- **Deployed to:** production (`dpl_DgV5aD4beB1PkicUfsVBxEyQFcb3`, ssr.fun); staging not yet
- **Decision log:** none (bug fix)

## What shipped
- **Solana:** choosing MetaMask in the Connect a wallet picker always failed with "MetaMask doesn't support Solana yet" -- the picker never tried it. MetaMask's extension registers a Solana wallet named "MetaMask" through the Wallet Standard, the same way Phantom, Solflare and Backpack do, so it now goes through the same wallet-adapter path: detected from the Wallet Standard registry (not `window.ethereum`, which is its EVM side), selected, connected. A browser without MetaMask's Solana wallet shows "not installed", as for the other three.
- **EVM (Robinhood, and the Base/Ethereum chains on staging):** the header chip already let the person choose between installed wallets (EIP-6963), but the connect buttons on Create, Portfolio and the reserve page called `connectEvmWallet()` with no choice and took whichever wallet announced first -- often Phantom, so MetaMask could not be chosen there. Those buttons now reuse the wallet picked last time (its EIP-6963 `rdns`, stored under `ssr.fun:evmWalletRdns`) and otherwise open the same picker. The picker is now a centred modal (same look as the Solana one) instead of a header dropdown, so it is visible from anywhere on the page.

## Code touched
- `src/components/WalletModal.tsx` -- MetaMask special case removed; all four wallets resolve through the Wallet Standard.
- `src/merge/lib/types.ts` -- `WalletProviderId` gains `"metamask"`.
- `src/merge/lib/WalletSync.tsx` -- maps the adapter name "MetaMask" to `"metamask"`.
- `src/merge/components/robinhood/useEvmWallet.ts` -- shared picker state (`choices`, `askEvmWalletChoice`, `pickEvmWallet`, `dismissEvmWalletPicker`), remembered last wallet, account/chain listeners per provider and only for the connected one.
- `src/components/EvmWalletChip.tsx` -- renders the shared picker as a modal; the header always asks when several wallets are installed, so the person can switch.

## Effect on others -- READ THIS
- `EvmWalletState` gains `choices`. `connectEvmWallet()` with no argument may now wait on the picker; closing it rejects with code 4001, which `describeEvmError` already reads as "declined".
- The picker lives in `EvmWalletChip`, which Shell mounts only when `VITE_ENABLE_EVM=true` -- the same flag that gates every in-page EVM connect button, so they always appear together.
- `origin/base` / `origin/ethmainnet` have identical copies of the touched EVM files, so merging main into the staging build is conflict-free.
- NOT verified with a real MetaMask yet: whether MetaMask, like Phantom, rewrites single-signer Solana transactions before signing (see the Lighthouse note in `2026-10-20-joao-liquidity-signing-flow.md`). Mint/Redeem/Create use the adapter as-is; worth a real mint with MetaMask before calling it done.

## Verification
`tsc -p tsconfig.app.json`, oxlint on the changed files (clean), offline suite 1616 passing / 5 pre-existing failures (chart range selector, button-reset CSS x3, IDL drift pin -- none in wallet code). A `VITE_ENABLE_EVM=true VITE_SOLANA_CLUSTER=mainnet-beta` build: the old MetaMask message is gone, the picker and remembered-wallet key are in the bundle, viem stays out of the main chunk.
