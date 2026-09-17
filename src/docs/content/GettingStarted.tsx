import { DocTabs } from '../components/DocTabs'
import { Callout, Facts } from '../components/primitives'
import { DocLink, docHref } from '../router'

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
          ['Reserve Token', 'The token you hold when you buy into a Reserve. One Reserve, one Reserve Token mint.'],
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
        A Reserve Token is a regular SPL token, the same standard as USDC or any other token in your Solana wallet. It
        has 6 decimals and no fixed supply:
      </p>
      <ul>
        <li>
          <strong>Buying</strong> deposits assets into the Reserve and mints new Reserve Tokens to you at the Reserve's
          current value per token, minus the mint fee.
        </li>
        <li>
          <strong>Selling</strong> (redeeming) burns your Reserve Tokens and returns your proportional share of the
          reserve assets, minus the redemption fee.
        </li>
        <li>
          <strong>The ongoing fee</strong> is paid by issuing a small number of new Reserve Tokens to the Manager and the
          protocol over time, which dilutes every holder proportionally.
        </li>
      </ul>
      <p>
        Because a Reserve Token is a normal token, you can also send it, hold it in any wallet, or trade it on a
        decentralized exchange. See{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes')}>Reserve Tokens on DEXes</DocLink> for how exchanges show it
        today, and <DocLink to={docHref('add-liquidity')}>Adding liquidity</DocLink> if you want to make a market for
        one.
      </p>
      <Callout title="Where the name and symbol live.">
        Right now a Reserve's name, symbol, and image are stored in an off-chain record that SSR.fun reads. Wallets and
        exchanges look for that information on-chain instead, so they may show a Reserve Token as "Unknown" until the
        on-chain metadata ships. This is being fixed. Details are in{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes')}>Reserve Tokens on DEXes</DocLink>.
      </Callout>
    </>
  )
}

function BuyingSelling() {
  return (
    <>
      <p>
        Open a Reserve from <a href="/#/discover">Discover Reserves</a>, connect your wallet, and use the Buy and Sell
        panel on the Reserve page. The page shows the Reserve's fees and an estimate of what you will receive before
        you approve anything in your wallet.
      </p>
      <ul>
        <li>
          <strong>Buy.</strong> You pay in the Reserve's settlement asset (USDC on Mainnet). SSR.fun swaps it into the
          reserve assets the Reserve targets, deposits them, and mints your Reserve Tokens in the same flow.
        </li>
        <li>
          <strong>Sell.</strong> Your Reserve Tokens are burned and your share of the reserve assets is swapped back into
          the settlement asset and sent to your wallet.
        </li>
        <li>
          <strong>Fees.</strong> Each Reserve sets its own mint fee, redemption fee, and ongoing fee within protocol
          limits. Solana network fees and swap costs are yours.
        </li>
      </ul>
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
        Anyone can launch a Reserve from the <a href="/#/create">Launch Reserve</a> page. You choose the reserve assets
        and their target weights, set the fees, add a name, symbol, description, and picture, and optionally invite
        Co-Managers. Launching creates the Reserve on-chain, creates its Reserve Token mint, and seeds the first
        holdings from your wallet.
      </p>
      <p>
        As the Manager you can later adjust targets, rebalance, pause, update the metadata, manage Co-Managers, and
        wind the Reserve down, all within the rules the protocol enforces. You can never withdraw reserve assets outside
        of redemption.
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
        { id: 'buy-sell', label: 'Buying and selling', content: <BuyingSelling /> },
        { id: 'launch', label: 'Launching a Reserve', content: <Launching /> },
      ]}
    />
  )
}
