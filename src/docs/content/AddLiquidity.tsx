import { DocTabs } from '../components/DocTabs'
import { Callout, Facts, Steps } from '../components/primitives'
import { DocLink, docHref } from '../router'

function BeforeYouStart() {
  return (
    <>
      <p>
        Adding liquidity means depositing a Reserve Token together with a second asset (usually SOL or USDC) into a pool
        on a decentralized exchange, so other people can trade the Reserve Token there. SSR.fun is not involved in the
        pool: the exchange's own program holds the deposit, and the exchange's terms apply.
      </p>
      <h3>You will need</h3>
      <ul>
        <li>
          <strong>The Reserve Token mint address.</strong> Open the Reserve on SSR.fun and use the{' '}
          <strong>Reserve Token Mint</strong> link near the bottom of the Reserve page, then copy the address from the
          explorer.
        </li>
        <li>
          <strong>Reserve Tokens</strong> in your wallet. Buy them on the Reserve page on SSR.fun.
        </li>
        <li>
          <strong>The quote asset</strong> you want to pair with, and a little SOL for network fees and account rent.
        </li>
        <li>
          <strong>The Reserve Token's current price.</strong> The Reserve page shows Token Price, the value of the
          reserve assets per Reserve Token. Your starting pool price should match it.
        </li>
      </ul>
      <Callout title="Check the mint address.">
        An exchange identifies a token by its mint address alone. Confirm the address you paste matches the one on the
        Reserve page before you deposit. How exchanges see a Reserve Token is described in{' '}
        <DocLink to={docHref('reserve-tokens-on-dexes')}>Reserve Tokens on DEXes</DocLink>.
      </Callout>
      <h3>Why the starting price matters</h3>
      <p>
        Anyone can mint or redeem Reserve Tokens on SSR.fun at the Reserve's value per token. If your pool prices the
        Reserve Token far above or below that value, traders can buy on one side and sell on the other until the pool
        moves back. The difference comes out of your liquidity. Start the pool at the Reserve's Token Price and you avoid
        giving that away.
      </p>
    </>
  )
}

function Raydium() {
  return (
    <>
      <p>
        Raydium lets you create a new pool for any mint address or add to an existing one. The steps follow Raydium's
        current interface and may differ slightly as their app changes.
      </p>
      <h3>Create a pool</h3>
      <Steps>
        {[
          <>Open Raydium, connect the wallet that holds your Reserve Tokens, and go to Liquidity, then Create Pool.</>,
          <>Choose the standard constant-product pool type unless you specifically want a concentrated pool.</>,
          <>
            For the base token, paste the Reserve Token mint address and confirm it matches the Reserve page, then
            accept the import.
          </>,
          <>Choose the quote token, typically SOL or USDC.</>,
          <>
            Enter the initial amounts. The ratio sets the starting price. To match the Reserve's Token Price, deposit
            an amount of quote asset equal to the Reserve Tokens you deposit multiplied by that price.
          </>,
          <>Review the fee tier and the start time, then approve the transactions in your wallet.</>,
        ]}
      </Steps>
      <h3>Add to an existing pool</h3>
      <Steps>
        {[
          <>Go to Liquidity and search by pasting the Reserve Token mint address.</>,
          <>Select the pool, enter the amount of one side, and let Raydium fill the other side at the pool's price.</>,
          <>Approve in your wallet. You receive LP tokens that represent your share of the pool.</>,
        ]}
      </Steps>
      <Callout title="Starting price.">
        A new pool opens at the ratio of your two deposits. Match the Reserve's Token Price shown on SSR.fun so the pool
        starts where minting and redemption already value the token.
      </Callout>
    </>
  )
}

function PumpSwap() {
  return (
    <>
      <p>
        PumpSwap is the exchange operated by pump.fun. Any SPL token can be pooled there, not only tokens launched on
        pump.fun. The steps follow the current interface and may differ slightly as it changes.
      </p>
      <Steps>
        {[
          <>Open PumpSwap, connect your wallet, and choose to create a pool or add liquidity.</>,
          <>Paste the Reserve Token mint address and check it against the Reserve page before continuing.</>,
          <>Pick the quote asset, usually SOL.</>,
          <>
            Enter the amounts. As on Raydium, the ratio of the two deposits sets the starting price, so match the
            Reserve's Token Price.
          </>,
          <>Approve the transactions in your wallet and keep the LP position visible in your portfolio.</>,
        ]}
      </Steps>
      <Callout title="Same token, any venue.">
        A Reserve Token pooled on PumpSwap is the same token that SSR.fun mints and redeems. Holders who buy it there can
        redeem it on SSR.fun at value per token like any other holder.
      </Callout>
    </>
  )
}

function FeesAndRisks() {
  return (
    <>
      <p>
        Providing liquidity has its own risks on top of holding a Reserve Token. The points below are specific to
        Reserve Tokens; the exchange's own documentation covers pool mechanics in general.
      </p>
      <Facts
        rows={[
          [
            'Reserve fees do not apply to pool trades',
            'The mint and redemption fees are charged only when Reserve Tokens are minted or redeemed on SSR.fun. Trading in a pool pays the pool fee instead.',
          ],
          [
            'The ongoing fee dilutes pool holdings too',
            "A Reserve's ongoing fee is paid by issuing new Reserve Tokens to the Manager and the protocol over time. Every holder is diluted proportionally, including the Reserve Tokens sitting in a pool. Over time the pool's price will drift below the value per token unless traders rebalance it.",
          ],
          [
            'Value per token moves with the reserve assets',
            'The Reserve holds real assets whose prices change. The Reserve page shows the current Token Price. Pools track it only through arbitrage.',
          ],
          [
            'Impermanent loss',
            'As in any pool, if the Reserve Token price moves relative to the quote asset, your position ends up holding more of the cheaper side than if you had simply held both.',
          ],
          [
            'Pause and wind-down',
            'A Manager can pause new deposits or wind a Reserve down. Redemption stays available in both states. A pool keeps trading regardless, so check the Reserve status on SSR.fun before adding liquidity.',
          ],
        ]}
      />
      <Callout kind="warn" title="Only deposit what you understand.">
        SSR.fun does not operate, endorse, or control any exchange pool and cannot recover funds sent to one. Read the{' '}
        <a href="/#/legal/disclosures">Disclosures</a> before you add liquidity.
      </Callout>
    </>
  )
}

export function AddLiquidity() {
  return (
    <DocTabs
      ariaLabel="Adding liquidity sections"
      tabs={[
        { id: 'before', label: 'Before you start', content: <BeforeYouStart /> },
        { id: 'raydium', label: 'On Raydium', content: <Raydium /> },
        { id: 'pumpswap', label: 'On PumpSwap', content: <PumpSwap /> },
        { id: 'risks', label: 'Fees and risks', content: <FeesAndRisks /> },
      ]}
    />
  )
}
