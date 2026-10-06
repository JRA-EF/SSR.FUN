# SSR.fun

SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves. Build a basket of Solana assets, set your fees, and issue a Reserve Token backed by transparent, on-chain holdings.

Live on Solana Mainnet at [ssr.fun](https://ssr.fun). Product documentation is at [ssr.fun/docs](https://ssr.fun/docs).

## How it works

- **Reserve**: the basket product. A Manager launches it, chooses its reserve assets and target weights, and sets its fees.
- **reserve assets**: the Solana tokens held inside a Reserve, custodied in program-owned vaults. Classic SPL mints, Token-2022 mints, and tokenized stocks (xStocks) are all supported.
- **Reserve Token**: the fungible SPL token that represents ownership of a Reserve. Minting and redemption are proportional and in-kind, so the core accounting never depends on a price oracle.
- **Co-Managers**: wallets the Manager grants scoped, revocable permissions to help run a Reserve.
- **Mint and Redeem**: minting with USDC routes the payment through Jupiter swaps into the reserve assets, with USD pricing from Pyth; redeeming returns the proportional reserve assets in kind or swapped back to USDC. Both sit on top of the proportional core.
- **Fees**: management and protocol fees accrue on-chain and settle in USDC to the Manager's fee recipients and the protocol treasury.

## Deployed programs

| Cluster | Program | Address |
| --- | --- | --- |
| Mainnet | `ssr_protocol` | `8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9` |
| DevNet | `ssr_protocol` | `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` |
| DevNet | `ssr_devnet_amm` (test-only AMM) | `AJbXGWSU1x9LtJW7uRKJCwS3JZYqXwqHXpX6erY7dS6c` |

The Mainnet program's upgrade authority is a Squads multisig. The canonical IDL is published on-chain.

## Repository layout

```
programs/ssr_protocol/   Anchor program (Rust): Reserves, vaults, fees, co-managers, metadata
programs/ssr_devnet_amm/ DevNet-only test AMM, never deployed to Mainnet
packages/sdk/            @ssr/sdk: TypeScript client, PDAs, instruction builders, pricing helpers
src/                     Vite + React 19 frontend (Discover, Launch, Reserve detail, Portfolio, Manage, Docs)
api/                     Vercel serverless functions: Mainnet pricing and swaps, ledger, KPIs, crons
lib/                     Server-side modules shared by api/ (ledger, metadata, warm cache, rate limit)
docs/protocol/           Architecture, account model, instruction reference, security invariants
docs/project/            Project status and append-only decision log
scripts/                 Deployment, migration, and verification scripts
tests/                   Program and integration test suites (ts-mocha)
```

## Stack

- **On-chain**: Rust, Anchor 1.1.2, SPL Token and Token-2022, Metaplex token metadata
- **Frontend**: Vite 8, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Zustand, Recharts, Solana Wallet Adapter
- **Backend**: Vercel Functions and Cron Jobs, Neon Postgres
- **Market data**: Jupiter (swaps, token catalogue, fallback prices), Pyth (primary prices), Helius RPC

## Getting started

Prerequisites: Node.js 20+, and for program work Rust, the Solana CLI, and Anchor 1.1.2.

```bash
git clone https://github.com/JRA-EF/SSR.FUN.git
cd SSR.FUN
npm ci
cp .env.example .env.local   # fill in what you need; the frontend runs against DevNet with no vars set
npm run dev
```

Useful commands:

```bash
npm run dev             # frontend dev server
npm run build           # build the SDK, typecheck, and bundle the frontend
npm run lint            # oxlint
npm run test:program    # full program suite against a local validator (needs ANCHOR_PROVIDER_URL)
npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_*.ts   # offline suite, no validator needed
anchor build            # compile the programs
```

Environment variables are documented inline in `.env.example`. Anything prefixed `VITE_` is inlined into the browser bundle, so only public values belong there. Signer keys, database URLs, and API keys are server-only.

## Documentation

- [Protocol architecture](docs/protocol/SSR_ARCHITECTURE.md)
- [Account model](docs/protocol/ACCOUNT_MODEL.md)
- [Instruction reference](docs/protocol/INSTRUCTION_REFERENCE.md)
- [Fee model](docs/protocol/FEE_MODEL.md)
- [Security invariants](docs/protocol/SECURITY_INVARIANTS.md)
- [Frontend integration](docs/protocol/FRONTEND_INTEGRATION.md)
- [Ledger architecture](docs/protocol/LEDGER_ARCHITECTURE.md)
- [Fee settlement runbook](docs/project/FEE_SETTLEMENT_RUNBOOK.md)
- [Decision log](docs/project/DECISION_LOG.md)

## Deployment

Production deploys go out through the Vercel CLI from a clean, committed tree. Git-triggered deployments are disabled in `vercel.json`. Program upgrades are proposed and executed through the Squads multisig.

## License

No open-source license has been granted. All rights reserved.
