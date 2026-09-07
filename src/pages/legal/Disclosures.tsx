import { Link } from '../../lib/router'
import { LegalPage } from './LegalPage'

export function Disclosures() {
  return (
    <LegalPage title="Disclosures" updated="2 September 2026">
      <p className="legal-intro">
        This page describes the material risks of using the SSR.FUN interface and the SSR Protocol. It forms part of
        the <Link to="/legal/terms">Terms of Use</Link>. Read it before committing funds. It is not an exhaustive list:
        risks not described here can also cause loss.
      </p>

      <h2>1. Experimental, unaudited software</h2>
      <p>
        The SSR Protocol and this interface are early-stage, experimental software. The protocol's programs have not
        been independently audited. They have been tested by their developers, but testing does not eliminate defects.
        A bug or vulnerability in the programs, the interface, or the software they depend on could cause the partial
        or total loss of funds.
      </p>

      <h2>2. Administrative authorities and upgrades</h2>
      <p>
        The SSR Protocol's programs are upgradeable; they are not immutable. The Foundation and persons authorized by
        it hold administrative authorities over the protocol, including the ability to upgrade the programs' code and
        to pause the creation of new Reserves and the minting of Reserve Tokens protocol-wide. Under the currently
        deployed programs, redemption remains available while minting is paused. A program upgrade can change any
        behavior described on this site, including how reserve assets are held and the properties described in the
        Terms. Protocol-level parameters, limits, and fee destinations can also change.
      </p>

      <h2>3. Risk of loss</h2>
      <p>
        Reserve Tokens and the reserve assets behind them can lose value quickly and completely. Nothing on this site
        is a guarantee of value, performance, liquidity, or availability. You should not commit funds you cannot
        afford to lose. There is currently no secondary market for Reserve Tokens on this interface: purchases and
        sales execute against the protocol at values derived from the Reserve's own holdings.
      </p>

      <h2>4. Blockchain and wallet risks</h2>
      <p>
        Confirmed Solana transactions are permanent and cannot be reversed. The Solana network can be congested,
        degraded, or unavailable, and submitted transactions can fail; network fees apply either way. You are solely
        responsible for the security of your wallet, private keys, and seed phrase — anyone who obtains them controls
        your funds, and no one can recover them for you.
      </p>

      <h2>5. Liquidity, slippage, and swaps</h2>
      <p>
        Buying and selling Reserve Tokens can involve swapping assets through third-party liquidity. Swap prices move
        between quote and execution (slippage), and thin liquidity can make buying or selling costly or temporarily
        impracticable. A Reserve's assets may become illiquid, frozen, restricted, depegged, or turn out to be
        malicious, which can impair minting, redemption, or valuation. It may not always be possible to mint or redeem
        on the terms you expect, or at all.
      </p>

      <h2>6. Prices and displayed data</h2>
      <p>
        The USD figures shown on this interface — prices, Reserve values, market capitalization, and profit and loss —
        are computed off-chain from third-party market-data sources for display only. They can be stale, unavailable,
        or wrong, and they are never an input to on-chain execution. More generally, what the interface displays can
        lag or differ from on-chain state; the blockchain is authoritative.
      </p>

      <h2>7. Reserve managers and co-managers</h2>
      <p>
        Each Reserve is controlled by its manager, who sets its composition targets, fees, metadata, pause state, and
        wind-down, and may grant limited permissions to delegates. A manager's decisions — changing fees, changing
        composition, pausing, or winding down — can affect the value and usability of that Reserve's tokens. The
        Foundation does not vet, endorse, or supervise managers. A "verified" label is an interface label only, not an
        endorsement or audit. Evaluate a Reserve's manager and configuration before committing funds.
      </p>

      <h2>8. Dependencies and interface risk</h2>
      <p>
        The interface depends on third-party services, including website hosting, blockchain data providers,
        swap-routing and market-data providers, a database for off-chain records, and your wallet software. Any of
        them can fail, change, or be compromised. The interface itself could be attacked or compromised; always verify
        transactions in your own wallet before signing. Reserve names, descriptions, and images are served from
        infrastructure operated for the interface and can become unavailable. The SSR Protocol's programs remain on
        the Solana blockchain and can be used without this website.
      </p>

      <h2>9. Regulatory and tax uncertainty</h2>
      <p>
        The legal and regulatory treatment of digital assets, Reserves, and Reserve Tokens is uncertain and differs
        between jurisdictions, and it may change in ways that adversely affect the protocol, the interface, or your
        ability to use them. You are solely responsible for your own tax obligations. Nothing on this site is
        investment, legal, accounting, or tax advice.
      </p>

      <h2>10. Source code status</h2>
      <p>
        The software behind the interface and the SSR Protocol is not currently open source. The deployed programs'
        bytecode and interface definitions are publicly inspectable on the Solana blockchain.
      </p>
    </LegalPage>
  )
}
