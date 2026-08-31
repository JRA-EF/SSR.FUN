// Creates the 1-of-3 Squads v4 multisig that will hold the ssr_protocol
// Mainnet program upgrade authority (DEC-0177): Creator + Boss + Developer,
// threshold 1 (any member ships a program upgrade alone), with the multisig
// CONTROLLED by the Creator (config_authority = Creator's wallet) so
// membership/threshold can ONLY ever be changed by the Creator directly --
// a member can never eject another member or change the rules, which an
// "autonomous" 1-of-N Squads multisig would allow any single member to do.
//
// The fee payer only pays rent/fees (~0.005 SOL) -- it gains NO rights over
// the multisig and can be a throwaway key. The Creator's wallet never needs
// to sign this creation; it only signs the later
// `solana program set-upgrade-authority` handover.
//
// Usage:
//   node scripts/create-upgrade-authority-multisig.mjs --payer <keypair.json> --cluster devnet|mainnet
//
// Requires @sqds/multisig (installed with `npm install --no-save @sqds/multisig`
// -- deliberately not a package.json dependency; this is a one-time
// operational script, not app code).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const CREATOR = new PublicKey('CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8') // Protocol authority + current upgrade authority
const BOSS = new PublicKey('PSpQGPvw7tZedKJvN21dJkh3vdDQeXkwA5n9DKBRZw5') // admin_2 (DEC-0112)
const DEVELOPER = new PublicKey('52b7pBNFNJpK7zEY4VJiMSnveu537ohxpv6VipC27ERa') // confirmed by the Creator, 2026-08-30
const THRESHOLD = 1
const SSR_PROGRAM_ID = '8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function loadEnvLocal() {
  const envPath = path.join(root, '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

function loadKeypair(p) {
  const raw = fs.readFileSync(p, 'utf8').trim()
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

async function main() {
  const cluster = arg('cluster')
  if (cluster !== 'devnet' && cluster !== 'mainnet') {
    console.error('Pass --cluster devnet (dry run) or --cluster mainnet (the real one).')
    process.exit(1)
  }
  const payerPath = arg('payer')
  if (!payerPath) {
    console.error('Pass --payer <keypair.json> (any funded wallet; pays ~0.005 SOL rent/fees, gains no rights).')
    process.exit(1)
  }
  const payer = loadKeypair(payerPath)

  loadEnvLocal()
  const rpc = cluster === 'mainnet'
    ? (process.env.HELIUS_MAINNET_RPC_URL || clusterApiUrl('mainnet-beta'))
    : (process.env.HELIUS_RPC_URL || clusterApiUrl('devnet'))
  const connection = new Connection(rpc, 'confirmed')

  const balance = await connection.getBalance(payer.publicKey)
  console.log(`cluster: ${cluster}  payer: ${payer.publicKey.toBase58()}  balance: ${(balance / 1e9).toFixed(4)} SOL`)
  if (balance < 8_000_000) {
    console.error('Payer needs at least ~0.008 SOL for rent + fees. Fund it and re-run.')
    process.exit(1)
  }

  // createKey is a one-time random seed for the multisig PDA -- it signs the
  // creation transaction and is worthless afterwards (kept nowhere).
  const createKey = Keypair.generate()
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey })
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 })

  const programConfigPda = multisig.getProgramConfigPda({})[0]
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda)

  const members = [
    { key: CREATOR, permissions: multisig.types.Permissions.all() },
    { key: BOSS, permissions: multisig.types.Permissions.all() },
    { key: DEVELOPER, permissions: multisig.types.Permissions.all() },
  ]

  console.log('creating controlled multisig...')
  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator: payer,
    multisigPda,
    // CONTROLLED: only this wallet can ever change members/threshold, and it
    // does so directly, outside the 1-of-3 voting -- the whole point.
    configAuthority: CREATOR,
    timeLock: 0, // upgrades execute immediately once approved (threshold 1)
    members,
    threshold: THRESHOLD,
    rentCollector: null,
    treasury: programConfig.treasury,
    sendOptions: { skipPreflight: false },
  })
  console.log('creation signature:', signature)
  await connection.confirmTransaction(signature, 'confirmed')

  // Verify by reading the account back -- never trust the send alone.
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda)
  console.log('\n=== VERIFIED ON-CHAIN ===')
  console.log('multisig PDA :', multisigPda.toBase58())
  console.log('vault PDA    :', vaultPda.toBase58(), ' <-- the new upgrade authority')
  console.log('threshold    :', account.threshold)
  console.log('configAuthority:', account.configAuthority.toBase58(), account.configAuthority.equals(CREATOR) ? '(Creator -- correct)' : '(UNEXPECTED)')
  for (const m of account.members) {
    const label = m.key.equals(CREATOR) ? 'Creator' : m.key.equals(BOSS) ? 'Boss' : m.key.equals(DEVELOPER) ? 'Developer' : 'UNEXPECTED MEMBER'
    console.log('member       :', m.key.toBase58(), `(${label}, permissions mask ${m.permissions.mask})`)
  }

  if (cluster === 'mainnet') {
    console.log('\n=== NEXT (Creator signs this one command with the current upgrade-authority keypair) ===')
    console.log(`solana program set-upgrade-authority ${SSR_PROGRAM_ID} \\`)
    console.log(`  --new-upgrade-authority ${vaultPda.toBase58()} \\`)
    console.log('  --skip-new-upgrade-authority-signer-check \\')
    console.log('  --keypair <path-to-CgHFxD4X-keypair.json> --url <mainnet rpc>')
    console.log('\nThen import the multisig in the Squads app (app.squads.so) by its PDA to manage upgrades from the UI.')
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
