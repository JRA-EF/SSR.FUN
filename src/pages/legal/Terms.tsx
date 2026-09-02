import { Link } from '../../lib/router'
import { LegalPage } from './LegalPage'

export function Terms() {
  return (
    <LegalPage title="Terms of Use" updated="2 September 2026">
      <h2>1. Acceptance of these Terms</h2>
      <p>
        These Terms of Use ("Terms") govern your use of the SSR.FUN website and interface (the "Interface"). By using
        the Interface, or by confirming your acceptance when first visiting it, you agree to these Terms. The{' '}
        <Link to="/legal/disclosures">Disclosures</Link> and the <Link to="/legal/privacy">Privacy Policy</Link> form
        part of these Terms and are incorporated by reference. If you do not agree, do not use the Interface.
      </p>

      <h2>2. Who we are</h2>
      <p>
        The Interface is operated by the <strong>Strategic Solana Reserve Foundation</strong> (the "Foundation").
        Registered Office: Intershore Consult (Cayman) Ltd., Suite 303, George Town Financial Center, 90 Fort Street,
        George Town, Grand Cayman, Cayman Islands.
      </p>

      <h2>3. Eligibility and your responsibility</h2>
      <p>
        You may use the Interface only if you are of legal age and have the capacity to enter into these Terms where
        you live. You are solely responsible for making sure that your use of the Interface and the SSR Protocol is
        lawful in your jurisdiction. The Foundation makes no representation that the Interface or the SSR Protocol is
        appropriate or lawful for use in any particular place.
      </p>

      <h2>4. What the Interface is</h2>
      <p>
        The Interface is a website that displays public blockchain data and helps you compose transactions for the SSR
        Protocol, a set of programs deployed on the Solana blockchain. The Interface is one way of reaching the SSR
        Protocol, not the only one: the protocol's programs run on Solana and can be used without this website. The
        Foundation does not execute your transactions — the Solana network does.
      </p>

      <h2>5. Non-custodial operation</h2>
      <p>
        The Foundation does not hold your funds and never has access to your private keys. Reserve assets are held in
        on-chain accounts controlled by the SSR Protocol's programs. No function of the currently deployed programs
        allows the Foundation, a Reserve manager, or a delegate to withdraw reserve assets from a Reserve outside of
        the minting and redemption mechanics described below. The programs are upgradeable, and this description
        applies to the code as deployed — see the <Link to="/legal/disclosures">Disclosures</Link>.
      </p>

      <h2>6. Your transactions</h2>
      <p>
        Every transaction you make through the Interface is signed by your own wallet and submitted to the Solana
        network. Once confirmed, blockchain transactions are permanent and cannot be reversed, refunded, or modified by
        the Foundation or anyone else. Review every transaction in your wallet before approving it.
      </p>

      <h2>7. Reserves and Reserve Tokens</h2>
      <p>
        A "Reserve" is a basket of Solana assets created through the SSR Protocol. A "Reserve Token" is the fungible
        token representing ownership of a Reserve. Reserve Tokens are minted when assets are deposited into a Reserve
        and redeemed for a proportional share of the Reserve's assets, in each case at values determined by the
        protocol's on-chain arithmetic, subject to the fees described in section 10.
      </p>
      <p>
        Reserve assets are not the property of the Foundation, of any company or fund, or of any Reserve manager or
        delegate. They are held on-chain and back the Reserve Tokens of that Reserve's holders. Reserve Tokens are
        created by users through the protocol; they are not issued by the Foundation, do not confer ownership of any
        company, and give you no claim against the Foundation.
      </p>

      <h2>8. Launching a Reserve</h2>
      <p>
        Anyone who launches a Reserve through the Interface acts as that Reserve's manager. As a manager you are
        responsible for your Reserve's configuration, fees, and metadata, including its name, description, and images.
        You represent that any content you submit is lawful, accurate, and does not infringe anyone's rights. The
        Foundation may remove or decline to display content from the Interface.
      </p>

      <h2>9. Managers and delegates</h2>
      <p>
        A Reserve's manager controls that Reserve's settings — its composition targets, fees, metadata, pause state,
        delegates, and wind-down — within the rules enforced by the protocol. A manager may grant delegates specific,
        limited permissions, which the programs enforce on-chain. Neither managers nor delegates can withdraw reserve
        assets outside of redemption. The Foundation does not vet, endorse, or supervise Reserve managers; any
        "verified" label in the Interface is an interface label only, not an endorsement or audit. See the{' '}
        <Link to="/legal/disclosures">Disclosures</Link> for the risks of relying on a manager.
      </p>

      <h2>10. Fees</h2>
      <p>
        Each Reserve's fees are configured by its manager within protocol-enforced bounds and are shown in the
        Interface before you approve a transaction. A mint fee reduces the number of Reserve Tokens you receive when
        minting; an ongoing fee on a Reserve's total value accrues by issuing new Reserve Tokens, which dilutes all
        holders proportionally; a redemption fee retains a portion of backing in the Reserve for remaining holders. A
        portion of fees accrues to the protocol. Solana network fees, and the costs of any asset swaps involved in a
        purchase or sale, are yours.
      </p>

      <h2>11. Third-party services</h2>
      <p>
        The Interface depends on services the Foundation does not control, including your wallet software, the Solana
        network, blockchain data providers, swap-routing and market-data providers, and website hosting. The Foundation
        is not responsible for their availability, accuracy, or conduct. Your use of a third-party wallet or service is
        governed by that provider's own terms. See the <Link to="/legal/disclosures">Disclosures</Link>.
      </p>

      <h2>12. Your wallet and keys</h2>
      <p>
        You are solely responsible for your wallet, private keys, and seed phrase. The Foundation can never recover
        them for you. Anyone with your keys controls your funds.
      </p>

      <h2>13. Prohibited conduct</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the Interface or the SSR Protocol for any unlawful purpose;</li>
        <li>attack, exploit, or attempt to exploit the Interface, its services, or the protocol's programs;</li>
        <li>engage in manipulative or deceptive trading activity;</li>
        <li>submit unlawful, infringing, or deceptive Reserve content;</li>
        <li>interfere with the operation of the Interface or circumvent its technical limits;</li>
        <li>misrepresent your affiliation with the Foundation or any Reserve.</li>
      </ul>

      <h2>14. Intellectual property and source code</h2>
      <p>
        The Interface and its content are owned by the Foundation. You receive a limited, revocable, non-exclusive
        licence to use the Interface as provided. The software behind the Interface and the SSR Protocol is not
        currently open source. The deployed programs' bytecode and interface definitions are publicly inspectable on
        the Solana blockchain.
      </p>

      <h2>15. Disclaimers</h2>
      <p>
        The Interface and the SSR Protocol are provided "as is" and "as available", without warranties of any kind. The
        software is experimental and has not been independently audited. Nothing on the Interface is investment, legal,
        accounting, or tax advice, or a recommendation of any asset or Reserve. Information displayed by the Interface
        may be delayed, incomplete, or differ from on-chain state; the blockchain is authoritative. The risks described
        in the <Link to="/legal/disclosures">Disclosures</Link> apply to everything you do through the Interface.
      </p>

      <h2>16. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, the Foundation and its officers, council members, employees, and agents
        are not liable for any indirect, incidental, special, consequential, or exemplary damages, or for any loss of
        profits, tokens, digital assets, data, or goodwill, arising out of or relating to the Interface or the SSR
        Protocol, however caused. To the maximum extent permitted by law, the Foundation's total aggregate liability
        arising out of or relating to these Terms or the Interface is limited to one hundred United States dollars
        (US$100).
      </p>

      <h2>17. Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless the Foundation and its officers, council members, employees, and
        agents from any claims, damages, and expenses (including reasonable legal fees) arising from your use of the
        Interface, your Reserves and content, or your breach of these Terms.
      </p>

      <h2>18. Availability, changes, and termination</h2>
      <p>
        The Foundation may modify, suspend, restrict, or discontinue the Interface, in whole or in part, at any time
        and without notice. The SSR Protocol's programs remain on the Solana blockchain independently of this website.
        The Foundation may update these Terms by posting a revised version with a new "Last updated" date; continued
        use of the Interface after a change constitutes acceptance of the revised Terms.
      </p>

      <h2>19. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the Cayman Islands. Any dispute arising out of or relating to these
        Terms or the Interface is subject to the exclusive jurisdiction of the courts of the Cayman Islands.
      </p>

      <h2>20. Contact</h2>
      <p>
        Strategic Solana Reserve Foundation, in writing, at: Intershore Consult (Cayman) Ltd., Suite 303, George Town
        Financial Center, 90 Fort Street, George Town, Grand Cayman, Cayman Islands.
      </p>
    </LegalPage>
  )
}
