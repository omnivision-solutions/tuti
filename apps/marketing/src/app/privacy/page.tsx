import type { Metadata } from "next";
import Link from "next/link";

import { contact, LegalPage } from "../legal";

export const metadata: Metadata = { title: "Privacy Policy · Tuti", description: "What personal data Tuti's hosted service at tuti.so collects, why, and your choices." };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="6 November 2026">
      <p>
        This policy explains what personal data Tuti&apos;s hosted service at tuti.so (the &quot;Service&quot;) handles,
        why, and your choices. It sits alongside our{" "}
        <Link href="/terms" className="font-medium text-primary underline-offset-4 hover:underline">
          Terms of Service
        </Link>
        . It doesn&apos;t cover servers that others run with Tuti&apos;s open-source code.
      </p>

      <h2>Two roles</h2>
      <ul>
        <li>
          <strong>Our customers&apos; accounts.</strong> For the people who sign up and work in the app, we decide how
          their data is used, as described here.
        </li>
        <li>
          <strong>Our customers&apos; portals and widgets.</strong> When you post feedback, vote, read docs or message a
          company through a portal or widget it runs on Tuti, that company decides what&apos;s collected and why. We
          process that data on its behalf and only to run the Service for it. Its own privacy policy applies; please
          contact it with requests about your data, and we&apos;ll help it answer them.
        </li>
      </ul>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address, password (stored only as a hash) and, if you sign in with Google or GitHub, your name, email and picture from them.</li>
        <li><strong>Content:</strong> what you and your teammates, customers and visitors put into the Service: posts, comments, votes, articles, changelog entries, messages, emails to support addresses and uploaded files.</li>
        <li><strong>Connected services:</strong> if you connect a GitHub repository, the pull requests, releases and files the GitHub App can read.</li>
        <li><strong>Billing:</strong> your plan and payment history. Card details go straight to Stripe; we never see or store them.</li>
        <li><strong>Technical data:</strong> IP address, browser and device details, and logs of requests and errors, used to run, secure and debug the Service.</li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>to provide the Service: sign you in, show your projects, send the emails you ask for (sign-in links, invites, notifications, &quot;it shipped&quot; emails);</li>
        <li>to run AI features you use, such as duplicate detection, AI answers and Autopilot;</li>
        <li>to bill paid plans and AI credits;</li>
        <li>to keep the Service secure, prevent abuse and fix problems;</li>
        <li>to tell you about important changes to the Service or these policies.</li>
      </ul>
      <p>
        Our legal bases are performing our contract with you, our legitimate interest in running a secure and reliable
        Service, and legal obligations such as keeping billing records. We don&apos;t sell personal data, show ads, or use
        your content to train AI models.
      </p>

      <h2>Cookies</h2>
      <p>
        We use only the cookies the Service needs to work, such as the one that keeps you signed in. tuti.so sets no
        advertising or analytics cookies. A company may add its own code, such as analytics, to its portal; its policy
        covers that.
      </p>

      <h2>Who we share it with</h2>
      <p>We share personal data only with providers that help run the Service, each bound to use it only for that:</p>
      <ul>
        <li><strong>Hosting and infrastructure</strong> providers that run our servers, database, file storage and background jobs;</li>
        <li><strong>Cloudflare</strong> for DNS, network protection and customers&apos; own domains;</li>
        <li><strong>Amazon Web Services</strong> (Amazon SES) to send and receive email;</li>
        <li><strong>OpenRouter</strong> and the AI model providers it routes to, for AI features, only when they&apos;re used;</li>
        <li><strong>Stripe</strong> for payments;</li>
        <li><strong>Google</strong> and <strong>GitHub</strong> if you choose to sign in or connect with them.</li>
      </ul>
      <p>We may also disclose data when the law requires it, or to a buyer if Tuti is sold, who must keep this policy.</p>

      <h2>Where it&apos;s processed</h2>
      <p>
        Our providers process data in the United States and other countries. Where data leaves the EU, the UK or
        Switzerland, we rely on safeguards such as the European Commission&apos;s standard contractual clauses.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep account data and content while your account or project exists. Closed inbox and AI conversations are
        deleted after a year. When you ask us to delete your account or a project (email {contact}), we delete its data within 30 days, apart from
        backups, which expire on their own schedule, and billing records we must keep by law.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit, passwords are hashed, uploaded files are stored privately and served through signed links,
        and access to production systems is restricted. No system is perfectly secure; if a breach affects your data,
        we&apos;ll tell you as the law requires.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you can ask to access, correct, export or delete your personal data, object to or
        restrict how we use it, and complain to your data protection authority. Email {contact}; we&apos;ll answer within
        30 days. You can change most account details in the app, and get a project&apos;s data through the API, within its plan&apos;s history limits; for anything older, email us.
      </p>

      <h2>Children</h2>
      <p>The Service isn&apos;t meant for children under 16, and we don&apos;t knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>We&apos;ll post changes here and update the date above; for material changes we&apos;ll also email account owners.</p>

      <h2>Contact</h2>
      <p>Questions or requests about your data: {contact}.</p>
    </LegalPage>
  );
}
