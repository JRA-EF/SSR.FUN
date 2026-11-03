import { DocTabs } from '../components/DocTabs'
import { Callout, Facts } from '../components/primitives'
import { DocLink, docHref } from '../router'
import { formatBpsAsPct, RESERVE_TOKEN_TRANSFER_FEE_BPS } from '../../merge/lib/calculations'

const TRANSFER_FEE = formatBpsAsPct(RESERVE_TOKEN_TRANSFER_FEE_BPS)

function Overview() {
  return (
    <>
      <p>
        SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves. A <strong>Reserve</strong>{' '}
        is a basket of Solana assets held in on-chain vaults. Each Reserve issues a <strong>Reserve Token</strong>, a
        standard Solana token that represents a share of everything the Reserve holds.
      </p>
      <p>
        The SSR Protocol is a set of programs on the Solana blockchain. SSR.fun is a website that reads public
        blockchain data and helps you build transactions for those programs. Your wallet signs every transaction, and
        the Solana network executes it. Nobody at SSR.fun holds your funds or your keys.
      </p>
      <Facts
        rows={[
          ['Reserve', 'The whole product: a basket of Solana assets plus its settings (targets, fees, manager).'],
          ['reserve assets', 'The individual tokens held inside a Reserve, for example SOL, USDC, or any Jupiter-tradable asset.'],
          ['Reserve Token', 'The token you hold when you mint into a Reserve. One Reserve, one Reserve Token mint.'],
          ['Manager', 'The wallet that launched the Reserve and controls its settings within the rules the protocol enforces.'],
          ['Co-Manager', 'A wallet the Manager has granted specific, revocable permissions on that Reserve.'],
        ]}
      />
      <Callout kind="good" title="Non-custodial.">
        Reserve assets sit in accounts controlled by the protocol's programs. No function of the deployed programs lets
        SSR.fun, a Manager, or a Co-Manager withdraw reserve assets outside of the mint and redemption mechanics.
      </Callout>
    </>
  )
}

function ReserveTokens() {
  return (
    <>
      <p>
        A Reserve Token is a regular Solana token that sits in your wallet like USDC or any other token. It has 6
        decimals and no fixed supply:
      </p>
      <ul>
        <li>
          <strong>Minting</strong> deposits assets into the Reserve and creates new Reserve Tokens to you at the Reserve's
          current value per token. The mint fee is paid separately in USDC in the same transaction.
        </li>
        <li>
          <strong>Redeeming</strong> burns your Reserve Tokens and returns your proportional share of the
          reserve assets, minus the redemption fee.
        </li>
        <li>
          <strong>The ongoing fee</strong> accrues once a day on the value of the Reserve. It is issued as new Reserve
          Tokens into the Reserve's fee vault, which dilutes every holder proportionally, and the protocol redeems those
          tokens and pays the protocol and the Manager in USDC.
        </li>
        <li>
          <strong>The transfer fee</strong> of {TRANSFER_FEE} is charged by the token itself whenever a Reserve Token
          moves between wallets, including trades on an exchange, and goes to the SSR Protocol. Minting and redeeming
          on SSR.fun never pay it. Reserve Tokens of earlier Reserves, launched as classic SPL Tokens, have no
          transfer fee.
        </li>
        <li>
          <strong>A trade tax</strong> can be added on top of the transfer fee by the Manager, once, when they launch
          the Reserve's liquidity pool. It is charged on every trade and transfer of that Reserve Token, never on
          minting or redeeming. See <DocLink to={docHref('add-liquidity', 'terms')}>Pool fees and terms</DocLink>.
        </li>
      </ul>
      <p>
        Because a Reserve Token is a normal token, you can also send it, hold it in any wallet, or trade it on a
        decentralized exchange. See{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes')}>Reserve Tokens on DEXes</DocLink> for how exchanges see it,
        and <DocLink to={docHref('add-liquidity')}>Adding liquidity</DocLink> for launching a pool for one.
      </p>
    </>
  )
}

function BuyingSelling() {
  return (
    <>
      <p>
        Open a Reserve from <a href="/#/discover">Discover Reserves</a>, connect your wallet, and use the Mint and Redeem
        panel on the Reserve page. The page shows the Reserve's fees and an estimate of what you will receive before
        you approve anything in your wallet.
      </p>
      <ul>
        <li>
          <strong>Mint.</strong> You pay in USDC. SSR.fun swaps it into the reserve assets at the Reserve's target
          weights, deposits them in the Reserve's vaults, and mints your Reserve Tokens in the same flow. The mint fee
          is added on top in USDC and paid in the same transaction.
        </li>
        <li>
          <strong>Redeem.</strong> Your Reserve Tokens are burned and your share of the reserve assets is swapped back
          into USDC and sent to your wallet. Redemption is open in every Reserve state, including paused and winding
          down.
        </li>
        <li>
          <strong>SOL.</strong> Reserves that hold SOL keep it in their vaults as wrapped SOL. Every mint and
          redemption wraps and unwraps it inside its own transaction, so your wallet only ever sends and receives
          native SOL.
        </li>
        <li>
          <strong>Fees.</strong> Each Reserve sets its own mint fee, redemption fee, and ongoing fee within protocol
          limits (see <DocLink to={docHref('protocol-reference', 'fees')}>Fees</DocLink>). Solana network fees and
          swap costs are yours.
        </li>
      </ul>
      <p>
        Mint and Redeem always happen at the Reserve's value per token, computed from what its vaults hold at that
        moment. Trading a Reserve Token with another holder on an exchange is a separate, secondary-market
        trade at the pool's price.
      </p>
      <Callout kind="warn" title="Transactions are final.">
        Once the Solana network confirms a transaction it cannot be reversed. Review every transaction in your wallet
        before approving it.
      </Callout>
    </>
  )
}

function Launching() {
  return (
    <>
      <p>
        Anyone can launch a Reserve from the <a href="/#/create">Launch Reserve</a> page. You choose up to 10 reserve
        assets and target weights that add up to exactly 100%, set the fees, add a name (up to 32 bytes), a symbol
        (up to 10 characters), a description, and a picture, and optionally invite Co-Managers.
      </p>
      <Facts
        rows={[
          ['Route check', 'Before launch, each asset is quoted from USDC and back. An asset with no tradable route is flagged so you can replace it before anything is created.'],
          ['Seed', 'You fund the first holdings with at least $1 of USDC. SSR.fun swaps it into the reserve assets first, then creates the Reserve and seeds it, and the mint fee on the seed is paid in USDC.'],
          ['On-chain result', 'The Reserve account, its vaults, a Token-2022 Reserve Token mint with the transfer fee, and the token metadata wallets and exchanges read for its name, symbol, and picture.'],
          ['Price lock', 'Quotes are held for 20 minutes from the first attempt, so a retry reuses them instead of repricing.'],
        ]}
      />
      <p>
        As the Manager you can later change targets and rebalance, pause, update the metadata, manage Co-Managers,
        launch and manage the Reserve Token's liquidity pool, and wind the Reserve down, all within the rules the
        protocol enforces.
      </p>
      <Facts
        rows={[
          ['Rebalance', 'Moves the holdings to new targets in one approval. Each swap borrows the asset from the vault, routes it through Jupiter, and must return at least the quoted minimum to the vault in the same transaction, or the whole swap fails. Assets that reach 0% can be removed.'],
          ['Liquidity', <>Launch a Raydium pool for the Reserve Token from Manage Reserve, with permanent fee terms chosen at launch. See <DocLink key="al" to={docHref('add-liquidity')}>Adding liquidity</DocLink>.</>],
          ['Wind-down', 'Stops new mints. Holders can still redeem, and once the Reserve Token supply reaches zero the Reserve can be closed.'],
        ]}
      />
      <p>
        You can never withdraw reserve assets outside of redemption. A rebalance can only exchange one reserve asset
        for another inside the vaults.
      </p>
      <p>
        For the on-chain accounts a launch creates, see the{' '}
        <DocLink to={docHref('protocol-reference')}>Protocol reference</DocLink>.
      </p>
    </>
  )
}

export function GettingStarted() {
  return (
    <DocTabs
      ariaLabel="Getting started sections"
      tabs={[
        { id: 'overview', label: 'Overview', content: <Overview /> },
        { id: 'reserve-tokens', label: 'Reserve Tokens', content: <ReserveTokens /> },
        { id: 'buy-sell', label: 'Minting and redeeming', content: <BuyingSelling /> },
        { id: 'launch', label: 'Launching a Reserve', content: <Launching /> },
      ]}
    />
  )
}
