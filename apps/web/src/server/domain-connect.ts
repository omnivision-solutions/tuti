import { createPrivateKey, sign } from "node:crypto";

import { fetchSiteCheck } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { txtRecords } from "./custom-domains";

/**
 * One-click DNS setup (Domain Connect, what "Add with Cloudflare" buttons use; GoDaddy, IONOS and
 * others have it too): a link to the domain's DNS provider that adds a template's records once the
 * team approves them there. Tuti's templates are in infra/domain-connect; a provider offers them only
 * once it has taken them, and its apply links must be signed with DOMAIN_CONNECT_KEY, whose public
 * half is in DNS at `_dck1.tuti.so`. So it's tuti.so's alone: elsewhere there's no link.
 */

const PROVIDER_ID = "tuti.so";
/** The public key's TXT record, under the templates' syncPubKeyDomain (tuti.so). */
const KEY_HOST = "_dck1";

/** Tuti's templates (infra/domain-connect/tuti.so.<service>.json), with the variables each takes. */
type Templates = {
  "email-domain": { dkim1: string; dkim2: string; dkim3: string };
  "custom-domain": { target: string; token: string };
};

export type OneClickDns = { provider: string; url: string };

/**
 * A link that adds `service`'s records for `fqdn` (a domain or a subdomain) at its DNS provider and
 * comes back to `returnTo`, or null: off on this server, a provider without Domain Connect, or one
 * that hasn't taken the template. Never throws: the records are there to copy either way.
 */
export async function oneClickDns<S extends keyof Templates>(fqdn: string, service: S, variables: Templates[S], returnTo: string): Promise<OneClickDns | null> {
  const der = process.env.DOMAIN_CONNECT_KEY?.trim();
  if (!der) {
    return null;
  }
  try {
    // The zone is the longest name with a `_domainconnect` record (help.acme.com, then acme.com); not the top-level domain.
    const labels = fqdn.split(".");
    const names = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
    const answers = await Promise.all(names.map((name) => txtRecords(`_domainconnect.${name}`)));
    const found = answers.findIndex((answer) => answer.length > 0);
    if (found < 0) {
      return null;
    }
    const domain = names[found]!;
    // The team's DNS names these addresses, so they're fetched as their site is: public addresses only.
    const settings = JSON.parse((await fetchSiteCheck(`https://${answers[found]![0]}/v2/${domain}/settings`)) ?? "null") as {
      providerName?: string;
      providerDisplayName?: string;
      urlSyncUX?: string;
      urlAPI?: string;
    } | null;
    if (!settings?.urlSyncUX?.startsWith("https://") || !settings.urlAPI?.startsWith("https://")) {
      return null;
    }
    const template = `v2/domainTemplates/providers/${PROVIDER_ID}/services/${service}`;
    if ((await fetchSiteCheck(`${settings.urlAPI}/${template}`)) === null) {
      return null;
    }
    const host = fqdn === domain ? "" : fqdn.slice(0, -domain.length - 1);
    // A custom domain's CNAME needs a host (its template's hostRequired): none at a zone's apex.
    if (!host && service === "custom-domain") {
      return null;
    }
    const query = new URLSearchParams({ domain, ...(host && { host }), ...variables, redirect_uri: returnTo }).toString();
    // Signed: the query string without key and sig, which comes last.
    const signature = sign("sha256", Buffer.from(query), createPrivateKey({ key: Buffer.from(der, "base64"), format: "der", type: "pkcs8" }));
    return {
      provider: settings.providerDisplayName || settings.providerName || domain,
      url: `${settings.urlSyncUX}/${template}/apply?${query}&key=${KEY_HOST}&sig=${encodeURIComponent(signature.toString("base64"))}`,
    };
  } catch (error) {
    log.warn("A Domain Connect lookup failed", { fqdn, error });
    return null;
  }
}
