import type { Metadata } from "next";
import Link from "next/link";

import { contact, LegalPage } from "../legal";

export const metadata: Metadata = { title: "Terms of Service · Tuti", description: "The terms for using Tuti's hosted service at tuti.so." };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="6 November 2026">
      <p>
        These terms cover your use of Tuti&apos;s hosted service at tuti.so, including the app, the portals, the widget and the
        API, and licences bought at tuti.so/app/license (the &quot;Service&quot;). By creating an account or using the Service you agree to them. If you use it for an
        organisation, you agree for that organisation and confirm you may do so. Our{" "}
        <Link href="/privacy" className="font-medium text-primary underline-offset-4 hover:underline">
          Privacy Policy
        </Link>{" "}
        explains how we handle personal data.
      </p>
      <p>
        Tuti&apos;s source code is open source under the GNU AGPL and its additional terms. Those licences govern the code,
        including running it on your own server; these terms govern the hosted Service and buying licences from us.
      </p>

      <h2>Your account</h2>
      <p>
        You need to be at least 16 to create an account. Keep your sign-in details safe and tell us at {contact} if you
        think someone else has used your account. You&apos;re responsible for what happens in your account and in the
        projects you own, including what your teammates do there.
      </p>

      <h2>Your content</h2>
      <p>
        Your content stays yours: the posts, comments, articles, changelog entries, messages, files and other data you or
        the people using your portals and widget put into the Service. You give us the permission we need to host, copy,
        process and display it in order to run the Service for you, and nothing more. You confirm you have the right to
        put it there. You can get your project&apos;s data out through the API at any time, within your plan&apos;s history limits.
      </p>
      <p>
        When you collect feedback or support messages from your own customers through Tuti, you decide what is collected
        and why, and you&apos;re responsible for having a lawful basis for it and telling them about it.
      </p>

      <h2>Acceptable use</h2>
      <p>Don&apos;t use the Service to:</p>
      <ul>
        <li>break the law or infringe anyone&apos;s rights, including their privacy or intellectual property;</li>
        <li>send spam or unsolicited email, or host malware, phishing or deceptive content;</li>
        <li>harass, threaten or abuse anyone, or publish content that sexualises minors or promotes violence;</li>
        <li>probe, attack or overload the Service, or get around its limits, security or billing;</li>
        <li>access other customers&apos; data, or resell the Service without our written agreement.</li>
      </ul>
      <p>We may remove content or suspend a project or account that breaks these rules, and will tell you why where we can.</p>

      <h2>AI features</h2>
      <p>
        Some features use AI models to suggest, draft, answer or decide, such as duplicate detection, AI answers on your
        docs and Autopilot. AI output can be wrong. Review it before relying on it; you&apos;re responsible for what you
        publish or send. We don&apos;t use your content to train AI models, and our AI providers may not either.
      </p>

      <h2>Plans, licences, payments and AI credits</h2>
      <ul>
        <li>
          Paid plans, add-ons and licences are billed in advance, monthly or yearly, through Stripe, and renew until you cancel. When
          you cancel, the plan runs to the end of the period you&apos;ve paid for.
        </li>
        <li>Prices are shown before you buy and exclude taxes unless stated. We&apos;ll give you at least 30 days&apos; notice of a price change, which applies from your next renewal.</li>
        <li>
          AI credits are prepaid units for AI features. Bought credits expire after the period shown when you buy them;
          credits that come with a plan last until the end of the billing period they come with. Credits have no cash value and aren&apos;t refundable
          or transferable.
        </li>
        <li>Payments aren&apos;t refundable for partial periods, except where the law requires it.</li>
        <li>If a payment fails, we may pause paid features until it&apos;s paid.</li>
      </ul>

      <h2>Licences for self-hosted Tuti</h2>
      <p>
        A licence bought at tuti.so/app/license lets one project on one installation hide &quot;Powered by tuti&quot;, as
        the additional terms to Tuti&apos;s licence allow. It&apos;s billed and renews like a plan (above): monthly or
        yearly through Stripe, until you cancel, running to the end of the paid period. Your installation fetches and
        renews its licence key from tuti.so; when the licence ends, its key isn&apos;t renewed, and once it expires the badge returns.
        You run your installation yourself: we don&apos;t host it and aren&apos;t responsible for it.
      </p>

      <h2>The Service</h2>
      <p>
        We work to keep the Service available and secure, but don&apos;t promise it will be uninterrupted or error-free.
        We may change, add or remove features. If we remove something material from a paid plan, we&apos;ll tell you in
        advance. Plans and free trials have limits, which we may change.
      </p>

      <h2>Ending</h2>
      <p>
        You can stop using the Service at any time; to delete your account or a project, email {contact}. We may suspend
        or end your access if you seriously or repeatedly break these terms, or if we have to by law. If we stop offering
        the Service, we&apos;ll give you at least 30 days&apos; notice to export your data.
      </p>

      <h2>Disclaimer and liability</h2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, to the
        extent the law allows. To the extent the law allows, we aren&apos;t liable for indirect or consequential losses, or
        for lost profits, revenue or data, and our total liability for any claim is limited to what you paid us in the 12
        months before it arose. Nothing in these terms limits liability that can&apos;t be limited by law.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. For material changes we&apos;ll email account owners or show a notice in the app at
        least 14 days before they take effect. Continuing to use the Service after that means you accept them.
      </p>

      <h2>Contact</h2>
      <p>Questions about these terms: {contact}.</p>
    </LegalPage>
  );
}
