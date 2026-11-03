import { CodeBlock } from '../components/CodeBlock'
import { DocTabs } from '../components/DocTabs'
import { Addr, Callout, Facts, Table } from '../components/primitives'
import { DocLink, docHref } from '../router'
import {
  MAX_METADATA_URI_LEN,
  MIN_TRADE_TAX_BPS,
  POOL_TRADE_FEE_BPS,
  RESERVE_DISCRIMINATOR_B58,
  RESERVE_DISCRIMINATOR_BYTES,
  RESERVE_TOKEN_DECIMALS,
  SPL_TOKEN_PROGRAM,
  SSR_PROGRAM_DEVNET,
  SSR_PROGRAM_MAINNET,
  TOKEN_2022_PROGRAM,
} from './addresses'
import {
  formatBpsAsPct,
  RESERVE_TOKEN_TRANSFER_FEE_BPS,
  RESERVE_TOKEN_TRANSFER_FEE_MAX_BPS,
} from '../../merge/lib/calculations'

const POOL_TRADE_FEE = formatBpsAsPct(POOL_TRADE_FEE_BPS)
const TRADE_TAX_RANGE = `${formatBpsAsPct(MIN_TRADE_TAX_BPS)} to 2%`
const TRANSFER_FEE = formatBpsAsPct(RESERVE_TOKEN_TRANSFER_FEE_BPS)
const TRANSFER_FEE_MAX = formatBpsAsPct(RESERVE_TOKEN_TRANSFER_FEE_MAX_BPS)

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
          ['Token-2022 program', <Addr key="c89" value={TOKEN_2022_PROGRAM} label="Token-2022 program address" />],
        ]}
      />
      <Facts
        caption="Reserve Token mint facts"
        rows={[
          ['Token standard', 'Token-2022 with the transfer-fee extension (TransferFeeConfig). Earlier Reserves: classic SPL Token, no extensions.'],
          ['Transfer fee', `${TRANSFER_FEE} of every transfer on Token-2022 Reserve Tokens, paid to the SSR Protocol. None on classic SPL Token Reserve Tokens.`],
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
          ['Manager fee recipients', <code key="c127">["manager_fee_recipients", reserve]</code>, 'Up to 10 wallets that share the Manager’s part of the fees.'],
          ['Fee settlement', <code key="c128">["fee_settlement", reserve]</code>, 'Tracks fee shares waiting in the fee vault for USDC settlement.'],
          ['Fee vault authority', <code key="c129">["fee_vault_authority", reserve]</code>, 'Signer-only PDA that owns the Reserve’s fee vault, where accrued fee shares are held.'],
          ['TVL accrual', <code key="c130">["tvl_accrual", reserve]</code>, 'The daily checkpoint of the ongoing fee.'],
          ['Transfer fee authority', <code key="c131">["transfer_fee_authority"]</code>, 'One protocol-wide PDA holding the transfer-fee rate and withdrawal authorities of every Token-2022 Reserve Token.'],
          ['Liquidity revenue', <code key="c132">["liquidity_revenue", reserve]</code>, 'The SSR pool of a Reserve: its creator treasury and how its earnings are routed.'],
          ['Liquidity terms', <code key="c133">["liquidity_terms", liquidity_revenue]</code>, 'The pool’s permanent fee terms, including the holder share and its 24-hour release.'],
          ['Liquidity split', <code key="c134">["liquidity_split", liquidity_terms]</code>, 'Optional: how the holder share divides between backing and locked pool liquidity.'],
          ['Trade tax', <code key="c135">["trade_tax", reserve]</code>, 'Optional: the trade tax rate set at pool launch and its lifetime totals.'],
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
        head={['Fee', 'When it applies', 'How it is charged', 'Range']}
        rows={[
          ['Mint fee', 'When Reserve Tokens are minted on SSR.fun, including the initial seed.', 'Paid in USDC by the minter, on top of the deposit and in the same transaction as the mint, to the Protocol Treasury and the Manager.', '0.5% to 5%'],
          ['Redemption fee', 'When Reserve Tokens are redeemed on SSR.fun.', 'Withheld from the Reserve Tokens redeemed and moved to the Reserve’s fee vault, then settled to the protocol and the Manager in USDC.', '0% to 5%'],
          [
            'Ongoing fee',
            'Continuously, on the value of the Reserve.',
            'Accrues once per full elapsed day as new Reserve Tokens issued to the fee vault, which dilutes all holders proportionally, then settled to the protocol and the Manager in USDC.',
            '0.5% to 10% per year',
          ],
        ]}
      />
      <h3>Protocol and Manager split</h3>
      <p>
        The program splits every fee the same way for every Reserve. For the mint fee and the ongoing fee, the
        protocol receives the larger of 0.5% and half the configured rate, and the Manager receives the rest. A rate
        configured below 0.5%, including 0%, is charged at 0.5%, all of it to the protocol. The redemption fee is
        always exactly the configured rate: the protocol receives the larger of 0.5% and half the rate, capped at the
        rate itself, the Manager the remainder, and a 0% redemption fee charges nothing.
      </p>
      <Table
        head={['Configured rate', 'Charged', 'Protocol', 'Manager']}
        rows={[
          ['0% mint or ongoing', '0.5%', '0.5%', '0%'],
          ['1% mint or ongoing', '1%', '0.5%', '0.5%'],
          ['4% mint or ongoing', '4%', '2%', '2%'],
          ['0.3% redemption', '0.3%', '0.3%', '0%'],
          ['2% redemption', '2%', '1%', '1%'],
        ]}
      />
      <p>
        The Manager's part can be shared among up to 10 fee recipients. Fee shares held in the fee vault are redeemed
        by the protocol's settlement keeper and paid out in USDC. The Reserve page on SSR.fun shows the fees before
        any transaction. These three fees never apply to transfers or to trades on an exchange.
      </p>
      <h3>Transfer fee</h3>
      <p>
        Separately from the Reserve’s own fees, Token-2022 Reserve Tokens carry a protocol transfer fee of{' '}
        {TRANSFER_FEE}, set in the mint’s TransferFeeConfig extension and charged by the Token-2022 program on every
        transfer, including exchange trades and sends between wallets. Minting and redeeming on SSR.fun are not
        transfers and never pay it. The fee goes to the SSR Protocol in full; Managers receive no share. The SSR
        Protocol can adjust the rate within a ceiling of {TRANSFER_FEE_MAX} fixed in the program, and a new rate takes
        effect about two epochs after it is set. Reserve Tokens of earlier Reserves, which use classic SPL Token
        mints, have no transfer fee. See{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'transfer-fee')}>Transfer fee</DocLink>.
      </p>
      <h3>Secondary-market fees</h3>
      <p>
        Pools launched through SSR.fun add fee terms that the Manager chooses once, at pool launch, and that never
        change afterwards. They apply to secondary-market trades only, never to minting or redeeming.
      </p>
      <Table
        head={['Fee', 'Rate', 'Who receives it']}
        rows={[
          ['Pool trading fee', `${POOL_TRADE_FEE} of each swap`, 'The pool’s liquidity providers, kept in the pool.'],
          ['Pool creator fee', '0.75% of each swap, paid in USDC', 'Raydium keeps 5% of it. Of the rest, SSR receives 20% and the creator treasury 80%, less any holder share.'],
          ['Trade tax (optional)', `${TRADE_TAX_RANGE}, added to the token’s transfer fee`, 'SSR receives 20%, the creator treasury 80%, less any holder share. Charged on every transfer, any venue.'],
          ['Holder share (optional)', '1% to 100% of the creator’s 80%', 'Of the pool creator fee: released over 24 hours into the Reserve’s backing, locked pool liquidity, or both. Of the trade tax: burned.'],
        ]}
      />
      <p>
        See <DocLink to={docHref('add-liquidity', 'terms')}>Pool fees and terms</DocLink> for how each part is paid.
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
