import { CodeBlock } from '../components/CodeBlock'
import { DocTabs } from '../components/DocTabs'
import { Addr, Callout, Facts } from '../components/primitives'
import { DocLink, docHref } from '../router'
import {
  RESERVE_DISCRIMINATOR_B58,
  RESERVE_METADATA_URI_OFFSET,
  RESERVE_MINT_OFFSET,
  RESERVE_TOKEN_DECIMALS,
  SPL_TOKEN_PROGRAM,
  SSR_PROGRAM_MAINNET,
} from './addresses'

const LOOKUP_CODE = `import { Connection, PublicKey } from '@solana/web3.js'

const SSR_PROGRAM = new PublicKey('${SSR_PROGRAM_MAINNET}')
const RESERVE_DISCRIMINATOR = '${RESERVE_DISCRIMINATOR_B58}' // sha256("account:Reserve")[0..8]
const MINT_OFFSET = ${RESERVE_MINT_OFFSET}          // 8 discriminator + 1 schema + 8 reserve_id + 32 manager
const METADATA_URI_OFFSET = ${RESERVE_METADATA_URI_OFFSET} // see the Reserve layout in the Protocol reference

export interface ReserveTokenInfo {
  reserve: string       // the Reserve account this mint belongs to
  name: string          // e.g. "Strategic Solana Reserve"
  symbol: string        // e.g. "SSRSol"
  image: string | null  // HTTPS image URL, when the Manager set one
  metadataUri: string
}

// Returns null when the mint is not a Reserve Token of the SSR Protocol.
export async function lookupReserveToken(
  connection: Connection,
  mint: PublicKey,
): Promise<ReserveTokenInfo | null> {
  const matches = await connection.getProgramAccounts(SSR_PROGRAM, {
    filters: [
      { memcmp: { offset: 0, bytes: RESERVE_DISCRIMINATOR } },
      { memcmp: { offset: MINT_OFFSET, bytes: mint.toBase58() } },
    ],
  })
  if (matches.length === 0) return null

  const { pubkey: reserve, account } = matches[0]
  const data = account.data
  const uriLen = data.readUInt32LE(METADATA_URI_OFFSET)
  const metadataUri = data
    .subarray(METADATA_URI_OFFSET + 4, METADATA_URI_OFFSET + 4 + uriLen)
    .toString('utf8')

  const res = await fetch(metadataUri)
  if (!res.ok) throw new Error('Reserve metadata is not reachable: HTTP ' + res.status)
  const meta = (await res.json()) as {
    name: string
    ticker: string
    description: string
    imageUrl?: string
  }

  return {
    reserve: reserve.toBase58(),
    name: meta.name,
    symbol: meta.ticker,
    image: meta.imageUrl ?? null,
    metadataUri,
  }
}`

const CURL_CODE = `# The URI stored on-chain in the Reserve account. The host is the SSR.fun
# domain the Reserve was launched from; every host serves the same record.
curl "https://ssr.fun/api/mainnet/reserve-metadata?id=<id>"

{
  "name": "Strategic Solana Reserve",
  "ticker": "SSRSol",
  "description": "A basket of Solana ecosystem assets ...",
  "category": "Ecosystem",
  "buyTaxPct": 0,
  "sellTaxPct": 0,
  "imageUrl": "https://ssr.fun/api/mainnet/reserve-image?id=<image id>"
}`

function HowItWorks() {
  return (
    <>
      <p>
        Every Reserve issues a Reserve Token. It is a standard SPL token, the same kind as USDC or any other token in
        your Solana wallet, so it can be held anywhere, sent to anyone, and traded or pooled on any decentralized
        exchange.
      </p>
      <p>There are two places a Reserve Token changes hands, and they work differently:</p>
      <Facts
        rows={[
          [
            'On SSR.fun',
            "Buying mints new Reserve Tokens against a deposit, and selling redeems them for a share of the reserve assets. Both happen at the Reserve's current value per token, minus the Reserve's fees.",
          ],
          [
            'On an exchange',
            'Reserve Tokens trade against a quote asset such as SOL or USDC at whatever price the pool sets. No Reserve Tokens are created or destroyed, and the Reserve’s fees do not apply. Only the exchange’s pool fee does.',
          ],
        ]}
      />
      <p>
        Because anyone can mint or redeem on SSR.fun at value per token, an exchange price that drifts away from that
        value creates an arbitrage, and the pool is pulled back toward it. The Reserve page on SSR.fun always shows the
        current Token Price, which is the reference for any pool.
      </p>
      <p>
        On-chain, an exchange sees a Reserve Token exactly as it sees any other SPL token. The{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'on-chain')}>On-chain properties</DocLink> tab lists what it
        finds, and the <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Identify a Reserve Token</DocLink>{' '}
        tab shows how any mint resolves to its Reserve, its name, symbol, and picture.
      </p>
      <Callout kind="good" title="Backed the same way everywhere.">
        A Reserve Token bought on an exchange is the same token as one minted on SSR.fun. It represents the same share
        of the Reserve, it can be redeemed on SSR.fun by whoever holds it, and it is subject to the same on-chain rules.
      </Callout>
    </>
  )
}

function OnChain() {
  return (
    <>
      <p>
        A Reserve Token mint is created by the SSR Protocol program when a Reserve is launched. Everything about it can
        be read from the chain.
      </p>
      <Facts
        rows={[
          ['Token standard', <>Classic SPL Token program (<Addr key="tp" value={SPL_TOKEN_PROGRAM} label="SPL Token program address" />). Not Token-2022, no extensions.</>],
          ['Decimals', String(RESERVE_TOKEN_DECIMALS)],
          [
            'Mint address',
            <>
              Program-derived from the Reserve: <code key="ma">["reserve_token_mint", reserve]</code> under the SSR Protocol
              program. One Reserve, one mint.
            </>,
          ],
          [
            'Mint authority',
            <>
              A program-derived address owned by the SSR Protocol (<code key="mia">["mint_authority", reserve]</code>). Only
              the program can sign for it. It mints when someone deposits into the Reserve and burns on redemption.
            </>,
          ],
          ['Freeze authority', 'None. Reserve Tokens can never be frozen.'],
          [
            'Supply',
            'Uncapped and floating. It rises with deposits, falls with redemptions, and rises slightly over time as the Reserve’s ongoing fee is paid in newly issued tokens.',
          ],
          [
            'Name, symbol, picture',
            <>
              Held in the Reserve’s metadata record, which the Reserve account links to on-chain. Managers edit it on
              SSR.fun. See{' '}
              <DocLink key="l" to={docHref('reserve-tokens-on-dexes', 'lookup')}>Identify a Reserve Token</DocLink>.
            </>,
          ],
        ]}
      />
      <Callout title="Why the mint authority stays with the program.">
        Some token checkers highlight any token whose mint authority is still set. For a Reserve Token that authority
        is a program address, not a person’s wallet. The program needs it to mint Reserve Tokens against deposits
        and to burn them on redemption, which is what keeps every token backed. The on-chain rules bound what can be
        minted: every mint corresponds to a deposit or to the Reserve’s configured fee.
      </Callout>
      <p>
        Program addresses, seeds, and the account layout are in the{' '}
        <DocLink to={docHref('protocol-reference')}>Protocol reference</DocLink>.
      </p>
    </>
  )
}

function Lookup() {
  return (
    <>
      <p>
        Any Reserve Token mint resolves to its Reserve and the Reserve’s name, symbol, and picture with one RPC
        call. This is how SSR.fun itself identifies Reserve Tokens, and any wallet, exchange, or explorer can do the
        same.
      </p>
      <h3>1. Find the mint address</h3>
      <p>
        Open the Reserve on SSR.fun and use the <strong>Reserve Token Mint</strong> link near the bottom of the Reserve
        page. It opens the mint in a block explorer, where you can copy the address.
      </p>
      <h3>2. Resolve the mint to its Reserve</h3>
      <p>
        Every Reserve account stores its Reserve Token mint at a fixed byte offset, so a filtered account scan against
        the SSR Protocol program returns the Reserve for any mint, and from there the link to its metadata record.
      </p>
      <CodeBlock title="TypeScript: mint to Reserve name, symbol and image" code={LOOKUP_CODE} />
      <h3>3. Read the metadata record</h3>
      <p>
        The link stored on-chain points at a JSON record served by SSR.fun. The record is content-addressed, so the
        same content always has the same id, and it is publicly readable.
      </p>
      <CodeBlock title="Shell: fetch the metadata record" code={CURL_CODE} />
      <Facts
        caption="Fields in the metadata record"
        rows={[
          ['name', 'The Reserve name, for example Strategic Solana Reserve.'],
          ['ticker', 'The Reserve Token symbol, for example SSRSol.'],
          ['description', "The Manager's description of the Reserve."],
          ['category', 'A free-text category chosen by the Manager.'],
          ['imageUrl', 'Optional. A permanent HTTPS link to the Reserve picture.'],
          ['buyTaxPct, sellTaxPct', 'Informational copies of the mint and redemption fee percentages. They apply on SSR.fun, not to exchange trades.'],
        ]}
      />
      <p>
        Byte offsets and the full account layout are in the{' '}
        <DocLink to={docHref('protocol-reference', 'read')}>Protocol reference</DocLink>.
      </p>
    </>
  )
}

function ForIntegrators() {
  return (
    <>
      <p>
        A short brief for exchange, wallet, explorer, and token-list teams who want to recognise a Reserve Token.
        Everything below can be verified on-chain.
      </p>
      <h3>What a Reserve Token is</h3>
      <Facts
        rows={[
          ['Issuer', 'The SSR Protocol, an Anchor program on Solana Mainnet. One Reserve Token mint per Reserve.'],
          ['Program (Mainnet)', <Addr key="p" value={SSR_PROGRAM_MAINNET} label="SSR Protocol program address" />],
          ['Token standard', <>Classic SPL Token (<Addr key="t" value={SPL_TOKEN_PROGRAM} label="SPL Token program address" />)</>],
          ['Decimals', String(RESERVE_TOKEN_DECIMALS)],
          ['Mint address', <>Program-derived: <code key="m">["reserve_token_mint", reserve]</code> under the program above.</>],
          ['Mint authority', <>Program-derived: <code key="a">["mint_authority", reserve]</code>. Only the program can sign for it.</>],
          ['Freeze authority', 'None.'],
          ['Backing', 'Reserve assets held in program-controlled vaults, one per asset, redeemable pro rata by any holder on SSR.fun.'],
          ['Supply', 'Uncapped. Minted on deposit at value per token, burned on redemption, plus a bounded fee accrual.'],
        ]}
      />
      <h3>Recognising a Reserve Token</h3>
      <ul>
        <li>The mint account is owned by the SPL Token program and its mint authority is a PDA of the SSR Protocol program.</li>
        <li>
          A <code>getProgramAccounts</code> call on the program with a memcmp on the mint at offset {RESERVE_MINT_OFFSET}{' '}
          returns exactly one Reserve account.
        </li>
        <li>
          That Reserve account links to a metadata record with the token’s name, symbol, description, and picture
          (see <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Identify a Reserve Token</DocLink>).
        </li>
      </ul>
      <h3>Example</h3>
      <Facts
        rows={[
          ['Reserve name', 'Strategic Solana Reserve'],
          ['Symbol', 'SSRSol'],
          ['Decimals', '6'],
          ['Display', 'Strategic Solana Reserve (SSRSol) with the Reserve picture'],
        ]}
      />
      <Callout kind="good" title="Legal and product context.">
        Reserve Tokens are created by users through the protocol. They represent a share of a Reserve’s on-chain
        holdings and give no claim on any company. See the <a href="/#/legal/disclosures">Disclosures</a> and{' '}
        <a href="/#/legal/terms">Terms of Use</a>.
      </Callout>
    </>
  )
}

export function ReserveTokensOnDexes() {
  return (
    <DocTabs
      ariaLabel="Reserve Tokens on exchanges sections"
      tabs={[
        { id: 'overview', label: 'How it works', content: <HowItWorks /> },
        { id: 'on-chain', label: 'On-chain properties', content: <OnChain /> },
        { id: 'lookup', label: 'Identify a Reserve Token', content: <Lookup /> },
        { id: 'integrators', label: 'For integrators', content: <ForIntegrators /> },
      ]}
    />
  )
}
