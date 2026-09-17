import { CodeBlock } from '../components/CodeBlock'
import { DocTabs } from '../components/DocTabs'
import { Addr, Callout, Facts, Table } from '../components/primitives'
import { DocLink, docHref } from '../router'
import {
  RESERVE_DISCRIMINATOR_B58,
  RESERVE_METADATA_URI_OFFSET,
  RESERVE_MINT_OFFSET,
  RESERVE_TOKEN_DECIMALS,
  SPL_TOKEN_PROGRAM,
  SSR_PROGRAM_MAINNET,
  TOKEN_METADATA_PROGRAM,
} from './addresses'

const METADATA_PDA_CODE = `import { Connection, PublicKey } from '@solana/web3.js'

const TOKEN_METADATA_PROGRAM = new PublicKey('${TOKEN_METADATA_PROGRAM}')

// The account wallets and DEXes read for a token's name, symbol and image.
export function metadataAddress(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM,
  )
  return pda
}

const connection = new Connection('https://api.mainnet-beta.solana.com')
const info = await connection.getAccountInfo(metadataAddress(reserveTokenMint))
// info === null for a Reserve Token today. That null is what a DEX
// turns into "Unknown token".`

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

function Overview() {
  return (
    <>
      <p>
        Every Reserve issues a Reserve Token. It is a standard SPL token, so it works in any Solana wallet and can be
        traded or pooled on any decentralized exchange. When you add one to Raydium or PumpSwap today, though, you will
        notice two things:
      </p>
      <ul>
        <li>
          <strong>The name, symbol, and image do not appear.</strong> The exchange shows "Unknown", a shortened mint
          address, or a blank avatar instead of "Strategic Solana Reserve" and "SSRSol".
        </li>
        <li>
          <strong>The token is flagged as unverified.</strong> It is not on the token list exchanges use for the
          verified badge, so it is treated like any newly created token.
        </li>
      </ul>
      <p>These are two separate mechanisms, and both have a clear cause:</p>
      <Facts
        rows={[
          [
            'Name, symbol, image',
            'Exchanges and wallets read these from a Metaplex Token Metadata account attached to the mint. Reserve Token mints do not carry that account yet. SSR.fun keeps the name, symbol, and image in an off-chain record that only SSR.fun reads today.',
          ],
          [
            'Verified badge',
            "Comes from Jupiter's verified token list, which Raydium and others use. No Reserve Token is on it yet, and verification needs the on-chain metadata to exist first.",
          ],
        ]}
      />
      <Callout title="Being fixed now.">
        On-chain metadata for every Reserve Token, existing and new, is in progress. Once it ships, exchanges pick up
        the name, symbol, and image automatically, and Reserve Tokens can go through Jupiter's verification. See the{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'roadmap')}>What is changing</DocLink> tab.
      </Callout>
      <p>
        Nothing about this affects what the token is. A Reserve Token with no on-chain metadata is still fully backed by
        its Reserve, still redeemable on SSR.fun, and still identifiable on-chain. The{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Look up a Reserve Token</DocLink> tab shows how
        anyone can resolve a mint to its Reserve and its name today.
      </p>
    </>
  )
}

function WhatDexesRead() {
  return (
    <>
      <p>
        A decentralized exchange does not know anything about SSR.fun. When you paste a mint address, it reads a few
        well-known on-chain accounts and one off-chain list. This is what each of them says for a Reserve Token today.
      </p>
      <Table
        head={['What the exchange shows', 'Where it looks', 'Reserve Token today']}
        rows={[
          [
            'Name and symbol',
            <>
              The Metaplex Token Metadata account derived from the mint (<code>["metadata", program, mint]</code>).
            </>,
            <span key="c161" className="doc-bad">Not present. Shown as "Unknown".</span>,
          ],
          [
            'Image',
            <>
              The <code>image</code> field of the JSON at that metadata account's <code>uri</code>.
            </>,
            <span key="c168" className="doc-bad">Not present. Blank avatar.</span>,
          ],
          ['Verified badge', "Jupiter's verified token list.", <span key="c170" className="doc-bad">Not listed yet.</span>],
          ['Decimals', 'The mint account.', <span key="c171" className="doc-ok">{RESERVE_TOKEN_DECIMALS}</span>],
          [
            'Token program',
            'The owner of the mint account.',
            <span key="c175" className="doc-ok">Classic SPL Token program (not Token-2022).</span>,
          ],
          [
            'Mint authority',
            'The mint account.',
            <span key="c180" className="doc-ok">A protocol-owned program address. Required: the protocol mints on deposit and burns on redemption.</span>,
          ],
          ['Freeze authority', 'The mint account.', <span key="c182" className="doc-ok">None. Reserve Tokens can never be frozen.</span>],
          ['Supply', 'The mint account.', <span key="c183" className="doc-ok">Floats with deposits, redemptions, and fee accrual.</span>],
        ]}
      />
      <p>
        Everything in the table except the first three rows is already correct. The three missing rows all trace back
        to one thing: the Metaplex metadata account. This is how an exchange derives it, and what it finds:
      </p>
      <CodeBlock title="TypeScript: the account a DEX reads" code={METADATA_PDA_CODE} />
      <Callout kind="warn" title="Why the mint authority is not renounced.">
        Some token checkers flag any token whose mint authority is still set. For a Reserve Token that authority is a
        program-derived address owned by the SSR Protocol, not a person's wallet. The program uses it to mint Reserve
        Tokens when someone deposits into the Reserve and to burn them on redemption. Renouncing it would make the
        Reserve unusable. The Reserve's on-chain rules bound what can be minted: every mint corresponds to a deposit or
        to the Reserve's configured fee.
      </Callout>
    </>
  )
}

function Lookup() {
  return (
    <>
      <p>
        Until the on-chain metadata ships, a Reserve Token can still be resolved to its Reserve and its name with one
        RPC call. The mint is a program-derived address of its Reserve, and the Reserve account stores a link to the
        Reserve's metadata record.
      </p>
      <h3>1. Find the mint address</h3>
      <p>
        Open the Reserve on SSR.fun and use the <strong>Reserve Token Mint</strong> link near the bottom of the Reserve
        page. It opens the mint in a block explorer, where you can copy the address.
      </p>
      <h3>2. Resolve the mint to its Reserve</h3>
      <p>
        Every Reserve account stores its Reserve Token mint at a fixed byte offset, so a filtered account scan against
        the SSR Protocol program returns the Reserve for any mint, and from there the metadata link.
      </p>
      <CodeBlock title="TypeScript: mint to Reserve name, symbol and image" code={LOOKUP_CODE} />
      <h3>3. Read the metadata record</h3>
      <p>
        The link stored on-chain points at a JSON record served by SSR.fun. The record is content-addressed, so the
        same content always has the same id, and it is publicly readable without an account.
      </p>
      <CodeBlock title="Shell: fetch the metadata record" code={CURL_CODE} />
      <Facts
        caption="Fields in the metadata record"
        rows={[
          ['name', 'The Reserve name, for example Strategic Solana Reserve.'],
          ['ticker', 'The Reserve Token symbol, for example SSRSol. Exchanges call this field symbol.'],
          ['description', "The Manager's description of the Reserve."],
          ['category', 'A free-text category chosen by the Manager.'],
          ['imageUrl', 'Optional. A permanent HTTPS link to the Reserve picture. Exchanges call this field image.'],
          ['buyTaxPct, sellTaxPct', 'Informational copies of the mint and redemption fee percentages. Not applied to DEX trades.'],
        ]}
      />
      <p>
        Program address and byte layout are in the{' '}
        <DocLink to={docHref('protocol-reference', 'read')}>Protocol reference</DocLink>.
      </p>
    </>
  )
}

function Roadmap() {
  return (
    <>
      <p>
        SSR.fun is attaching standard on-chain metadata to every Reserve Token so that wallets, explorers, and exchanges
        show Reserve Tokens the same way they show any established token. The work is in progress. This page is updated
        as each step ships.
      </p>
      <Table
        head={['Step', 'What changes', 'Status']}
        rows={[
          [
            '1. Metaplex metadata on every Reserve Token',
            <>
              Each mint gets a Token Metadata account: <code>name</code> = the Reserve name, <code>symbol</code> = the
              Reserve Token symbol, <code>uri</code> = a metadata record in the standard format. Created by the protocol
              for new Reserves and backfilled for existing ones. Holders do nothing.
            </>,
            <span key="c264" className="doc-pending">In progress</span>,
          ],
          [
            '2. Standard metadata record',
            <>
              The record at <code>uri</code> uses the field names exchanges expect (<code>symbol</code>,{' '}
              <code>image</code>) alongside the current ones, so the image resolves without any custom integration.
            </>,
            <span key="c272" className="doc-pending">In progress</span>,
          ],
          [
            '3. Metadata updates flow through',
            'When a Manager updates the Reserve name, description, or picture on SSR.fun, the on-chain metadata is updated in the same action.',
            <span key="c277" className="doc-pending">In progress</span>,
          ],
          [
            '4. Jupiter verification',
            "Reserve Tokens are submitted through Jupiter's verification process once steps 1 and 2 are live, which is what drives the verified badge on Raydium and other interfaces.",
            <span key="c282" className="doc-pending">After 1 and 2</span>,
          ],
          [
            '5. Add liquidity from SSR.fun',
            'Reserve Token holders and Managers will be able to seed a Raydium or PumpSwap pool from inside SSR.fun instead of doing it by hand.',
            <span key="c287" className="doc-pending">Planned</span>,
          ],
        ]}
      />
      <Callout title="What you can do now.">
        You can already add liquidity for any Reserve Token by pasting its mint address into the exchange. Expect the
        "unknown token" warning until step 1 ships. The{' '}
        <DocLink to={docHref('add-liquidity')}>Adding liquidity</DocLink> guide walks through it.
      </Callout>
    </>
  )
}

function ForDexTeams() {
  return (
    <>
      <p>
        This tab is a short brief for exchange, wallet, and token-list teams who see a Reserve Token and want to know
        what it is. Everything below can be verified on-chain.
      </p>
      <h3>What a Reserve Token is</h3>
      <Facts
        rows={[
          ['Issuer', 'The SSR Protocol, an Anchor program on Solana Mainnet. One Reserve Token mint per Reserve.'],
          ['Program (Mainnet)', <Addr key="c311" value={SSR_PROGRAM_MAINNET} label="SSR Protocol program address" />],
          ['Token standard', <>Classic SPL Token (<Addr value={SPL_TOKEN_PROGRAM} label="SPL Token program address" />)</>],
          ['Decimals', String(RESERVE_TOKEN_DECIMALS)],
          ['Mint address', <>Program-derived: <code>["reserve_token_mint", reserve]</code> under the program above.</>],
          ['Mint authority', <>Program-derived: <code>["mint_authority", reserve]</code>. Only the program can sign for it.</>],
          ['Freeze authority', 'None.'],
          ['Backing', 'Reserve assets held in program-controlled vaults, one per asset, redeemable pro rata by any holder.'],
          ['Supply', 'Uncapped. Minted on deposit at value per token, burned on redemption, plus a bounded fee accrual.'],
        ]}
      />
      <h3>Why the metadata is missing today</h3>
      <p>
        Reserve Token mints were created without a Metaplex Token Metadata account. The Reserve's name, symbol,
        description, and image live in a record linked from the Reserve account instead (the{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'lookup')}>Look up a Reserve Token</DocLink> tab shows how to
        read it). On-chain metadata is being added for all Reserve Tokens; see{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes', 'roadmap')}>What is changing</DocLink>.
      </p>
      <h3>Identifying a Reserve Token</h3>
      <ul>
        <li>The mint account's owner is the SPL Token program and its mint authority is a PDA of the SSR Protocol program.</li>
        <li>
          A <code>getProgramAccounts</code> call on the program with a memcmp on the mint at offset {RESERVE_MINT_OFFSET}{' '}
          returns exactly one Reserve account.
        </li>
        <li>The Reserve account links to a metadata record with the token's name and symbol.</li>
      </ul>
      <h3>Example</h3>
      <Facts
        rows={[
          ['Reserve name', 'Strategic Solana Reserve'],
          ['Symbol', 'SSRSol'],
          ['Expected display on an exchange', 'Strategic Solana Reserve (SSRSol) with the Reserve picture'],
          ['Displayed today', 'Unknown token, blank avatar, unverified'],
        ]}
      />
      <Callout kind="good" title="Legal and product context.">
        Reserve Tokens are created by users through the protocol. They represent a share of a Reserve's on-chain
        holdings and give no claim on any company. See the <a href="/#/legal/disclosures">Disclosures</a> and{' '}
        <a href="/#/legal/terms">Terms of Use</a>.
      </Callout>
    </>
  )
}

export function ReserveTokensOnDexes() {
  return (
    <DocTabs
      ariaLabel="Reserve Tokens on DEXes sections"
      tabs={[
        { id: 'overview', label: 'Overview', content: <Overview /> },
        { id: 'what-dexes-read', label: 'What DEXes read', content: <WhatDexesRead /> },
        { id: 'lookup', label: 'Look up a Reserve Token', content: <Lookup /> },
        { id: 'roadmap', label: 'What is changing', content: <Roadmap /> },
        { id: 'for-dex-teams', label: 'For DEX teams', content: <ForDexTeams /> },
      ]}
    />
  )
}
