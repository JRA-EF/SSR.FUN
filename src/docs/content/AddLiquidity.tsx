import { DocTabs } from '../components/DocTabs'
import { Callout, Facts, Steps } from '../components/primitives'
import { DocLink, docHref } from '../router'
import { formatBpsAsPct, RESERVE_TOKEN_TRANSFER_FEE_BPS } from '../../merge/lib/calculations'
import { MIN_TRADE_TAX_BPS, POOL_TRADE_FEE_BPS } from './addresses'

const POOL_TRADE_FEE = formatBpsAsPct(POOL_TRADE_FEE_BPS)
const TRADE_TAX_RANGE = `${formatBpsAsPct(MIN_TRADE_TAX_BPS)} to 2%`
const TRANSFER_FEE = formatBpsAsPct(RESERVE_TOKEN_TRANSFER_FEE_BPS)

function OnSsr() {
  return (
    <>
      <p>
        A Reserve's Manager can launch a Raydium pool for the Reserve Token straight from SSR.fun, under{' '}
        <strong>Manage Reserve, Liquidity</strong>. The pool pairs the Reserve Token with USDC on Raydium's Standard
        (CPMM) pool type, under a pool configuration SSR uses for every pool it launches, and the Reserve Token becomes
        tradeable on any venue that routes through Raydium, with a public chart.
      </p>
      <Facts
        rows={[
          ['Pair', 'Reserve Token / USDC on Raydium Standard (CPMM).'],
          ['Funded from', 'The creator treasury: the Reserve’s fee destination wallet. It supplies both the Reserve Tokens and the USDC, and receives the LP position and the pool earnings.'],
          ['Starting price', 'The Reserve Token’s backing value (value per token), so the pool opens where minting and redeeming already price it.'],
          ['Missing Reserve Tokens', 'If the treasury holds too few, the panel offers to mint just the shortfall at backing value first, through the normal Mint flow.'],
          ['Fee terms', <>Chosen once at launch and permanent. See <DocLink key="t" to={docHref('add-liquidity', 'terms')}>Pool fees and terms</DocLink>.</>],
        ]}
      />
      <h3>Launch a pool</h3>
      <Steps>
        {[
          <>Open the Reserve on SSR.fun, go to Manage Reserve, then Liquidity, and connect the Manager wallet.</>,
          <>Enter how much USDC to pair. The panel works out the Reserve Tokens needed at backing value.</>,
          <>Choose the fee terms: an optional trade tax, and whether to share part of your earnings with holders.</>,
          <>
            Review the prepared transaction. It is simulated first, and nothing moves until the Manager wallet and the
            creator treasury (often the same wallet) approve it. Type the confirmation word and approve.
          </>,
        ]}
      </Steps>
      <Facts
        caption="Launch costs that do not come back"
        rows={[
          ['SOL', 'About 0.19 SOL: Raydium’s 0.15 SOL pool-creation fee plus rent for the pool’s accounts.'],
          ['Reserve Tokens', `About 0.30% of the Reserve Tokens added: the ${TRANSFER_FEE} transfer fee is charged once on the way to SSR’s approved pool payer and once into the pool.`],
        ]}
      />
      <h3>After launch</h3>
      <Facts
        rows={[
          ['Add liquidity', 'Adds to the pool at its current price. If the pool is more than 1% away from backing value, the panel shows the gap and asks you to confirm before you continue.'],
          ['Lock', 'Timed locks hold the LP position in SSR’s program for 30, 90, 180, or 365 days and can be extended. Lock forever uses Raydium’s irreversible lock.'],
          ['Collect', 'Collects the pool’s creator fee in USDC and splits it by the pool’s fee terms: SSR, the creator treasury, and any holder share.'],
          ['Withdraw', 'Only unlocked liquidity can be withdrawn, back to the creator treasury. Collected fees always go to the creator treasury, locked or not.'],
        ]}
      />
    </>
  )
}

function Terms() {
  return (
    <>
      <p>
        A pool launched on SSR.fun earns its creator the pool's creator fee and, optionally, a trade tax. The terms
        are written on-chain when the pool launches and can never be changed afterwards. They apply to
        secondary-market trades only, never to minting or redeeming.
      </p>
      <Facts
        rows={[
          ['Transfer fee', `${TRANSFER_FEE} of every transfer of the Reserve Token, on every venue, to the SSR Protocol. Unchanged by the pool.`],
          ['Pool trading fee', `${POOL_TRADE_FEE} of each swap, kept in the pool for liquidity providers.`],
          ['Pool creator fee', '0.75% of each swap, accrued in USDC. Raydium keeps 5% of it. SSR receives 20% of the rest and the creator treasury 80%.'],
          [
            'Trade tax',
            `Optional, ${TRADE_TAX_RANGE}, one rate for trades in both directions. It is added to the Reserve Token’s own transfer fee, so it applies to every trade and transfer on any venue. SSR receives 20%, the creator treasury 80%, paid in Reserve Tokens. It starts about two epochs (two to five days) after launch.`,
          ],
        ]}
      />
      <h3>Sharing earnings with holders</h3>
      <p>
        At launch the creator can choose to share 1% to 100% of their 80% with the Reserve's holders. The choice is
        off by default and permanent once made.
      </p>
      <Facts
        rows={[
          [
            'Creator fee share',
            'Released a little every hour over 24 hours. The creator chooses how it divides between backing and pool.',
          ],
          [
            'Backing',
            "Swapped into the Reserve's assets at their target weights and deposited in the vaults. No Reserve Tokens are created, so the backing behind every token grows.",
          ],
          [
            'Pool',
            'Added to the Reserve Token’s pool as liquidity that is locked for good. Added only while the pool price is within 1% of backing value; otherwise that part goes to backing.',
          ],
          [
            'Trade tax share',
            'Burned. Supply falls while the vaults stay the same, so the backing per token rises.',
          ],
        ]}
      />
      <Callout title="Example: a $1,000 trade, no trade tax, no holder share.">
        The pool creator fee is $7.50. Raydium keeps $0.375, SSR receives $1.425, and the creator treasury $5.70. The
        transfer fee sends $1.50 in Reserve Tokens to the SSR Protocol, and
        $2.50 stays in the pool for liquidity providers.
      </Callout>
    </>
  )
}

function BeforeYouStart() {
  return (
    <>
      <p>
        You can also pool a Reserve Token yourself on any decentralized exchange, as with any other token. That means
        depositing the Reserve Token together with a second asset (usually SOL or USDC) into a pool, so other people
        can trade the Reserve Token there. SSR.fun is not involved in such a pool: the exchange's own program holds the
        deposit, the exchange's terms apply, and the SSR pool fee terms above do not.
      </p>
      <h3>You will need</h3>
      <ul>
        <li>
          <strong>The Reserve Token mint address.</strong> Open the Reserve on SSR.fun and use the{' '}
          <strong>Reserve Token Mint</strong> link near the bottom of the Reserve page, then copy the address from the
          explorer.
        </li>
        <li>
          <strong>Reserve Tokens</strong> in your wallet. Mint them on the Reserve page on SSR.fun.
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
          <>
            Choose the Standard (CPMM) constant-product pool type unless you specifically want a concentrated (CLMM)
            pool. Both handle Token-2022 Reserve Tokens and their transfer fee.
          </>,
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
        PumpSwap is the exchange operated by pump.fun, and it pools tokens that were not launched on pump.fun too.
        Reserve Tokens on the classic SPL Token standard pool there directly. Token-2022 Reserve Tokens, which carry
        the transfer fee, are pooled on a Raydium Standard (CPMM) pool. The steps follow the current interface and may
        differ slightly as it changes.
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
            'Mint and redemption fees do not apply to pool trades',
            'The mint and redemption fees are charged only when Reserve Tokens are minted or redeemed on SSR.fun. Trading in a pool pays the pool fee instead.',
          ],
          [
            'The transfer fee applies to pool activity',
            `Token-2022 Reserve Tokens carry a ${TRANSFER_FEE} protocol transfer fee, charged by the token itself on every transfer and paid to the SSR Protocol. Depositing Reserve Tokens into a pool, withdrawing them, and every trade through the pool are transfers, so each pays it, together with the trade tax on Reserve Tokens whose Manager set one. Reserve Tokens of earlier Reserves, which use classic SPL Token mints, have no transfer fee.`,
          ],
          [
            'The ongoing fee dilutes pool holdings too',
            "A Reserve's ongoing fee accrues as new Reserve Tokens issued to the Reserve's fee vault. Every holder is diluted proportionally, including the Reserve Tokens sitting in a pool. Over time the pool's price will drift below the value per token unless traders rebalance it.",
          ],
          [
            'Value per token moves with the reserve assets',
            'The Reserve holds real assets whose prices change. The Reserve page shows the current Token Price. Pools track it only through arbitrage.',
          ],
          [
            'A new pool can trade far from backing value',
            'A small, new pool moves a long way on each trade. Its price can sit well above or below the value per token until traders mint at backing value and trade into the pool, or take tokens out of it and redeem them. Compare the pool price with the Token Price on SSR.fun before you trade or add liquidity.',
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
        SSR.fun does not operate Raydium, PumpSwap, or any other exchange, and cannot reverse trades or recover funds sent to a pool. Read the{' '}
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
        { id: 'on-ssr', label: 'Launch on SSR.fun', content: <OnSsr /> },
        { id: 'terms', label: 'Pool fees and terms', content: <Terms /> },
        { id: 'before', label: 'Pooling it yourself', content: <BeforeYouStart /> },
        { id: 'raydium', label: 'On Raydium', content: <Raydium /> },
        { id: 'pumpswap', label: 'On PumpSwap', content: <PumpSwap /> },
        { id: 'risks', label: 'Fees and risks', content: <FeesAndRisks /> },
      ]}
    />
  )
}
