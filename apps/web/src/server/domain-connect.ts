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

/** A `_domainconnect` record's value: the provider's API, a host and maybe a path. */
const PROVIDER_HOST = /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i;

type ProviderSettings = { providerName?: string; providerDisplayName?: string; urlSyncUX: string; urlAPI: string };

/**
 * What the provider at `api` says about `domain`, or null: it doesn't host it, or its answer isn't
 * usable (https only, for the link the team follows). The team's DNS names this address, so it's
 * fetched as their site is: public addresses only.
 */
async function providerSettings(api: string, domain: string): Promise<ProviderSettings | null> {
  try {
    const settings = JSON.parse((await fetchSiteCheck(`https://${api}/v2/${domain}/settings`)) ?? "null") as Partial<ProviderSettings> | null;
    return settings?.urlSyncUX?.startsWith("https://") && settings.urlAPI?.startsWith("https://") ? (settings as ProviderSettings) : null;
  } catch {
    return null;
  }
}

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
    // The zone is the longest name whose `_domainconnect` record names a provider that knows it
    // (help.acme.com, then acme.com); not the top-level domain. A wildcard can answer for a name
    // with the zone's own TXT records (SPF and the like), so only hosts count.
    const labels = fqdn.split(".");
    const names = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
    const answers = await Promise.all(names.map((name) => txtRecords(`_domainconnect.${name}`)));
    let found: { domain: string; settings: ProviderSettings } | undefined;
    for (const [i, domain] of names.entries()) {
      const api = answers[i]!.find((answer) => PROVIDER_HOST.test(answer));
      const settings = api && (await providerSettings(api, domain));
      if (settings) {
        found = { domain, settings };
        break;
      }
    }
    if (!found) {
      return null;
    }
    const { domain, settings } = found;
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
