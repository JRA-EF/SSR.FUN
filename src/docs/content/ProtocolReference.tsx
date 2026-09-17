import { CodeBlock } from '../components/CodeBlock'
import { DocTabs } from '../components/DocTabs'
import { Addr, Callout, Facts, Table } from '../components/primitives'
import { DocLink, docHref } from '../router'
import {
  MAX_METADATA_URI_LEN,
  RESERVE_DISCRIMINATOR_B58,
  RESERVE_DISCRIMINATOR_BYTES,
  RESERVE_TOKEN_DECIMALS,
  SPL_TOKEN_PROGRAM,
  SSR_PROGRAM_DEVNET,
  SSR_PROGRAM_MAINNET,
} from './addresses'

const DERIVE_CODE = `import { PublicKey } from '@solana/web3.js'

const SSR_PROGRAM = new PublicKey('${SSR_PROGRAM_MAINNET}')

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// Reserves are numbered from 0 in creation order.
export function reserveAddress(reserveId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('reserve'), u64le(reserveId)], SSR_PROGRAM)[0]
}

export function reserveTokenMint(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('reserve_token_mint'), reserve.toBuffer()], SSR_PROGRAM)[0]
}

export function mintAuthority(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('mint_authority'), reserve.toBuffer()], SSR_PROGRAM)[0]
}

export function vaultAuthority(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault_authority'), reserve.toBuffer()], SSR_PROGRAM)[0]
}

// One vault per reserve asset, owned by the vault authority above.
export function reserveVault(reserve: PublicKey, assetMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reserve_vault'), reserve.toBuffer(), assetMint.toBuffer()],
    SSR_PROGRAM,
  )[0]
}`

const READ_CODE = `import { Connection, PublicKey } from '@solana/web3.js'

const SSR_PROGRAM = new PublicKey('${SSR_PROGRAM_MAINNET}')

export async function readReserve(connection: Connection, reserve: PublicKey) {
  const info = await connection.getAccountInfo(reserve)
  if (!info || !info.owner.equals(SSR_PROGRAM)) throw new Error('Not a Reserve account')
  const d = info.data

  // Offsets follow the layout table on this page.
  const status = ['Created', 'AssetsInitializing', 'Active', 'Paused', 'WindDown', 'Closed'][d[81]] ?? 'Unknown'
  const uriLen = d.readUInt32LE(167)

  return {
    reserveId: d.readBigUInt64LE(9),
    manager: new PublicKey(d.subarray(17, 49)).toBase58(),
    reserveTokenMint: new PublicKey(d.subarray(49, 81)).toBase58(),
    status,
    assetCount: d[82],
    mintFeeBps: d.readUInt16LE(101),
    redemptionFeeBps: d.readUInt16LE(103),
    annualFeeBps: d.readUInt16LE(105),
    metadataUri: d.subarray(171, 171 + uriLen).toString('utf8'),
  }
}`

function Addresses() {
  return (
    <>
      <p>
        The SSR Protocol runs as one Anchor program per network. SSR.fun at ssr.fun talks to Mainnet. A separate test
        deployment on DevNet has its own program address and its own Reserves; the two never mix.
      </p>
      <Facts
        rows={[
          ['SSR Protocol, Mainnet', <Addr key="c86" value={SSR_PROGRAM_MAINNET} label="Mainnet program address" />],
          ['SSR Protocol, DevNet', <Addr key="c87" value={SSR_PROGRAM_DEVNET} label="DevNet program address" />],
          ['SPL Token program', <Addr key="c88" value={SPL_TOKEN_PROGRAM} label="SPL Token program address" />],
        ]}
      />
      <Facts
        caption="Reserve Token mint facts"
        rows={[
          ['Token standard', 'Classic SPL Token. Not Token-2022, no extensions.'],
          ['Decimals', String(RESERVE_TOKEN_DECIMALS)],
          ['Mint authority', 'The Reserve’s mint-authority PDA (below). Program-controlled.'],
          ['Freeze authority', 'None.'],
          ['Name, symbol, picture', <>In the Reserve's metadata record, linked from the Reserve account. See <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Identify a Reserve Token</DocLink>.</>],
        ]}
      />
    </>
  )
}

function Accounts() {
  return (
    <>
      <p>
        Every account the protocol creates is a program-derived address (PDA), so anyone can compute it from public
        inputs. Seeds are ASCII strings; <code>reserve</code> and <code>asset_mint</code> are the 32-byte public keys;{' '}
        <code>reserve_id</code> is an unsigned 64-bit little-endian integer.
      </p>
      <Table
        head={['Account', 'Seeds', 'What it is']}
        rows={[
          ['ProtocolConfig', <code key="c117">["protocol_config"]</code>, 'Protocol-wide settings and the running count of Reserves.'],
          ['Reserve', <code key="c118">["reserve", reserve_id]</code>, 'One per Reserve: Manager, mint, status, fees, metadata link.'],
          ['Reserve Token mint', <code key="c119">["reserve_token_mint", reserve]</code>, 'The SPL mint of the Reserve Token.'],
          ['Mint authority', <code key="c120">["mint_authority", reserve]</code>, 'Signer-only PDA that mints and burns Reserve Tokens.'],
          ['Vault authority', <code key="c121">["vault_authority", reserve]</code>, 'Signer-only PDA that owns the Reserve’s vaults.'],
          ['ReserveAsset', <code key="c122">["reserve_asset", reserve, asset_mint]</code>, 'One per reserve asset: target weight and state.'],
          ['Reserve vault', <code key="c123">["reserve_vault", reserve, asset_mint]</code>, 'The token account holding that asset.'],
          [
            'Co-Manager record',
            <code key="c126">["delegate", reserve, wallet]</code>,
            <>
              The on-chain <code>Delegate</code> account: a Co-Manager’s permissions on a Reserve.
            </>,
          ],
        ]}
      />
      <CodeBlock title="TypeScript: derive the addresses of a Reserve" code={DERIVE_CODE} />
      <Callout title="Reserves are numbered.">
        Reserve ids start at 0 and increase by one per launch. The ProtocolConfig account holds the next id, so the
        full set of Reserves can be enumerated by deriving each Reserve address in turn.
      </Callout>
    </>
  )
}

function ReadReserve() {
  return (
    <>
      <p>
        The Reserve account is a Borsh-encoded Anchor account. The first 8 bytes are the account discriminator, then the
        fields below in order. Offsets are from the start of the account data.
      </p>
      <Table
        head={['Offset', 'Size', 'Field', 'Type']}
        rows={[
          ['0', '8', 'discriminator', <>{RESERVE_DISCRIMINATOR_BYTES} (base58 <code>{RESERVE_DISCRIMINATOR_B58}</code>)</>],
          ['8', '1', 'schema_version', 'u8'],
          ['9', '8', 'reserve_id', 'u64 LE'],
          ['17', '32', 'manager', 'Pubkey'],
          ['49', '32', 'reserve_token_mint', 'Pubkey'],
          ['81', '1', 'status', 'u8: 0 Created, 1 AssetsInitializing, 2 Active, 3 Paused, 4 WindDown, 5 Closed'],
          ['82', '1', 'asset_count', 'u8'],
          ['83', '2', 'total_target_weight_bps', 'u16 LE'],
          ['85', '8', 'created_at', 'i64 LE, Unix seconds'],
          ['93', '8', 'configured_at', 'i64 LE, Unix seconds'],
          ['101', '2', 'fee_config.mint_fee_bps', 'u16 LE'],
          ['103', '2', 'fee_config.redemption_fee_bps', 'u16 LE'],
          ['105', '2', 'fee_config.annual_tvl_fee_bps', 'u16 LE'],
          ['107', '4', 'fee_config: last effective split', '2 x u16 LE, informational'],
          ['111', '32', 'fee_config.fee_destination', 'Pubkey'],
          ['143', '8', 'fee_config.last_fee_accrual_ts', 'i64 LE'],
          ['151', '16', 'fee_config: pending fee shares', '2 x u64 LE'],
          ['167', `4 + n`, 'metadata_uri', <>String: u32 LE length, then UTF-8 bytes (max {MAX_METADATA_URI_LEN})</>],
          ['after', '4', 'delegate_count, bump, vault_authority_bump, mint_authority_bump', '4 x u8'],
        ]}
      />
      <CodeBlock title="TypeScript: decode a Reserve account" code={READ_CODE} />
      <p>
        To go the other way, from a Reserve Token mint to its Reserve, filter the program's accounts on the mint at
        offset 49. That call is in{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Reserve Tokens on DEXes</DocLink>.
      </p>
    </>
  )
}

function Fees() {
  return (
    <>
      <p>
        Each Reserve's Manager sets three fees at launch, within limits the program enforces. All three are stored in
        the Reserve account in basis points (1 bp = 0.01%).
      </p>
      <Table
        head={['Fee', 'When it applies', 'How it is charged', 'Maximum']}
        rows={[
          ['Mint fee', 'When Reserve Tokens are minted (a buy on SSR.fun).', 'Reduces the number of Reserve Tokens the buyer receives.', '5%'],
          ['Redemption fee', 'When Reserve Tokens are redeemed (a sell on SSR.fun).', 'Keeps part of the backing in the Reserve for remaining holders.', '5%'],
          [
            'Ongoing fee',
            'Continuously, on the value of the Reserve.',
            'Accrues on full elapsed days by issuing new Reserve Tokens, which dilutes all holders proportionally.',
            '10% per year',
          ],
        ]}
      />
      <p>
        A portion of each fee goes to the protocol and the remainder to the Manager, split by a formula the program
        applies uniformly to every Reserve. The Reserve page on SSR.fun shows the configured fees before any
        transaction. Fees never apply to transfers or to trades on an exchange.
      </p>
    </>
  )
}

export function ProtocolReference() {
  return (
    <DocTabs
      ariaLabel="Protocol reference sections"
      tabs={[
        { id: 'addresses', label: 'Addresses', content: <Addresses /> },
        { id: 'accounts', label: 'Accounts and PDAs', content: <Accounts /> },
        { id: 'read', label: 'Read a Reserve', content: <ReadReserve /> },
        { id: 'fees', label: 'Fees', content: <Fees /> },
      ]}
    />
  )
}
