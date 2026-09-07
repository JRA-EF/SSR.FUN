import { Link } from '../../lib/router'
import { LegalPage } from './LegalPage'

export function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="2 September 2026">
      <h2>1. Who is responsible</h2>
      <p>
        This Privacy Policy describes how the Strategic Solana Reserve Foundation (the "Foundation") handles
        information when you use the SSR.FUN interface. Registered Office: Intershore Consult (Cayman) Ltd., Suite
        303, George Town Financial Center, 90 Fort Street, George Town, Grand Cayman, Cayman Islands.
      </p>

      <h2>2. What we process</h2>
      <ul>
        <li>
          <strong>Wallet addresses and transaction data.</strong> When you connect a wallet or transact, your wallet
          address and transaction details become part of the public Solana blockchain. We read and store this public
          data — including wallet addresses, transaction identifiers, amounts, and estimated USD values at the time of
          recording — in our own database to power the interface, its statistics, and internal record-keeping.
        </li>
        <li>
          <strong>Technical data.</strong> Our hosting provider processes your IP address, browser and device
          information, and request logs to serve the site, and we use request information for rate limiting. We do not
          run analytics or advertising trackers.
        </li>
        <li>
          <strong>Content you submit.</strong> If you launch or manage a Reserve, its name, description, category, and
          any image you upload are stored in our database and served publicly as part of that Reserve's information.
          Do not include personal information you do not want published.
        </li>
      </ul>

      <h2>3. What we do not do</h2>
      <p>
        We do not use analytics or tracking scripts, do not serve advertising, do not sell your information, and do
        not attempt to link wallet addresses to real-world identities.
      </p>

      <h2>4. Public blockchain data</h2>
      <p>
        Transactions you sign are recorded on the public Solana blockchain, which the Foundation does not control.
        They are visible to anyone and permanent: the Foundation cannot edit or delete blockchain records, and copies
        of our database records derived from them may be retained for record-keeping.
      </p>

      <h2>5. Service providers</h2>
      <p>
        We use third-party providers to run the interface: website hosting and serverless infrastructure (including
        its request logs), a managed database for the records described above, a blockchain data provider that our
        servers query on your behalf, and market-data and swap-routing services that our servers query server-side.
        Your IP address is visible to our hosting provider; our servers, not your browser, communicate with the
        market-data and swap-routing services.
      </p>

      <h2>6. Cookies and local storage</h2>
      <p>
        The interface sets no advertising or analytics cookies. The only cookies used are strictly functional session
        cookies for password-protected areas of the site. Your browser's local storage is used for functional
        preferences only — for example your theme choice, interface state, in-progress transaction recovery data, and
        a flag recording that you accepted the <Link to="/legal/terms">Terms of Use</Link>. This data stays in your
        browser and is not transmitted to us. Because no non-essential cookies are used, the interface does not show a
        cookie-consent banner.
      </p>

      <h2>7. Retention</h2>
      <p>
        Database records described above are retained while the interface operates. Infrastructure logs are retained
        according to our hosting provider's schedules. Public blockchain data is permanent by nature.
      </p>

      <h2>8. Your rights and contact</h2>
      <p>
        Depending on where you live, you may have rights over personal information we hold about you, such as access
        or correction. To exercise them, or for any privacy question, write to: Strategic Solana Reserve Foundation,
        Intershore Consult (Cayman) Ltd., Suite 303, George Town Financial Center, 90 Fort Street, George Town, Grand
        Cayman, Cayman Islands. Note that we cannot alter public blockchain data.
      </p>

      <h2>9. Changes</h2>
      <p>
        We may update this Privacy Policy by posting a revised version with a new "Last updated" date.
      </p>
    </LegalPage>
  )
}
