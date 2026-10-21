import { domainToASCII } from "node:url";

import { appUrl, portalTemplate } from "./hosts";

/**
 * Portals on their own domains (help.acme.com): which hostnames a project may use, and the DNS
 * records that verify one. Custom domains are on when CUSTOM_DOMAIN_TARGET says where customers
 * point them (a hostname, e.g. customers.tuti.so): whatever sends those requests to Tuti with
 * their own Host (a proxy with TLS for them) is set up outside it.
 */

/** Where customers point their domain (a CNAME), or null when custom domains are off. */
export function customDomainTarget(): string | null {
  return process.env.CUSTOM_DOMAIN_TARGET?.trim().toLowerCase() || null;
}

/** The TXT record that verifies `hostname` for a project with `token`. */
export function verificationRecord(hostname: string, token: string) {
  return { name: `_tuti.${hostname}`, value: `tuti-verify=${token}` };
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** Top-level domains are letters, or punycode (xn--…). */
const TOP_LEVEL = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A hostname as people paste it ("https://Help.Acme.com/docs", "hélp.acme.com") as Tuti stores it
 * ("help.acme.com", punycode), or an error saying what's wrong. Not the app's or the portals' own
 * domain or anything under it, so no portal can take another's (or the app's) address.
 */
export function normalizeHostname(input: string): { hostname: string } | { error: string } {
  const text = input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  if (/:\d*$/.test(text)) {
    return { error: "Enter the domain without a port" };
  }
  const hostname = domainToASCII(text.toLowerCase());
  const labels = hostname.split(".");
  if (!hostname || hostname.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TOP_LEVEL.test(labels.at(-1)!)) {
    return { error: "Enter a domain like help.example.com" };
  }
  for (const own of ownDomains()) {
    if (hostname === own || hostname.endsWith(`.${own}`)) {
      return { error: `Pick a domain of your own, not one under ${own}` };
    }
  }
  return { hostname };
}

/** The app's domain and the one portals are under (tuti.so for {project}.tuti.so), without ports. */
export function ownDomains(): string[] {
  const portalHost = new URL(portalTemplate().replace("{project}", "x")).hostname;
  // The label with the project in it goes: "{project}--dev.tuti.so" is under tuti.so too.
  const portalDomain = portalHost.split(".").slice(1).join(".");
  return [...new Set([appUrl().hostname, portalDomain].filter((domain) => domain.includes(".")))];
}
