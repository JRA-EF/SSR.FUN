#!/usr/bin/env node
// DEC-0268: read-only Mainnet fetch of what src/raydium_tax.rs needs to run
// real Raydium CPMM swaps in LiteSVM: the CPMM program, SSR's AMM config, the
// SSR pool payer's Raydium permission and Raydium's pool-creation fee account.
// Writes ./fixtures (git-ignored). RPC: HELIUS_MAINNET_RPC_URL, else the repo's .env.local.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let url = process.env.HELIUS_MAINNET_RPC_URL
if (!url) {
  const common = path.resolve(here, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim())
  const file = [path.join(here, '../../.env.local'), path.join(path.dirname(common), '.env.local')].find((p) => fs.existsSync(p))
  url = file && fs.readFileSync(file, 'utf8').match(/^HELIUS_MAINNET_RPC_URL="?(.*?)"?\r?$/m)?.[1]
}
if (!url) { console.error('Set HELIUS_MAINNET_RPC_URL.'); process.exit(1) }
const rpc = async (method, params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(JSON.stringify(r.error))
  return r.result
}
const out = path.join(here, 'fixtures')
fs.mkdirSync(out, { recursive: true })
const accounts = {
  'amm_config.bin': 'LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC',
  'permission.bin': 'HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB',
  'pool_fee.bin': 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8',
}
const got = await rpc('getMultipleAccounts', [Object.values(accounts), { encoding: 'base64' }])
Object.keys(accounts).forEach((name, i) => fs.writeFileSync(path.join(out, name), Buffer.from(got.value[i].data[0], 'base64')))
// Upgradeable program: the ELF sits in its ProgramData account after a 45-byte header.
const program = await rpc('getAccountInfo', ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', { encoding: 'jsonParsed' }])
const data = await rpc('getAccountInfo', [program.value.data.parsed.info.programData, { encoding: 'base64' }])
fs.writeFileSync(path.join(out, 'raydium_cpmm.so'), Buffer.from(data.value.data[0], 'base64').subarray(45))
console.log(`fixtures written to ${out}`)
