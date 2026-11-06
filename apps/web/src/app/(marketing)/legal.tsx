import { plansEnabled } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { licensePrivateKey } from "@/server/license-server";

/** The address for anything about tuti.so's terms and privacy. */
export const CONTACT_EMAIL = "hello@tuti.so";

export const contact = (
  <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-primary underline-offset-4 hover:underline">
    {CONTACT_EMAIL}
  </a>
);

/**
 * tuti.so's terms and privacy policy: only on Tuti's own server, where plans or licences are sold, since a
 * self-hosted server's operator writes their own.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  if (!plansEnabled() && !licensePrivateKey()) {
    notFound();
  }
  return (
    <article className="flex flex-col gap-4 leading-relaxed [&_h2]:mt-6 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-bold [&_li]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">Last updated {updated}</p>
      </header>
      {children}
    </article>
  );
}

/**
 * "By signing up, you agree to …" where someone signs up or buys on tuti.so: sign-up, sign-in when it offers
 * Continue with Google or GitHub (which signs up someone new), and buying a licence. Callers show it only there.
 */
export function TermsAgreement({ by }: { by: string }) {
  const link = "underline underline-offset-4 hover:text-foreground";
  return (
    <p className="text-center text-sm text-muted-foreground">
      By {by}, you agree to the{" "}
      <Link href="/terms" className={link}>
        Terms of Service
      </Link>{" "}
      and{" "}
      <Link href="/privacy" className={link}>
        Privacy Policy
      </Link>
      .
    </p>
  );
}
