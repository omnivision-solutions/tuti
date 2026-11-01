import { generateKeyPairSync, verify } from "node:crypto";

import { beforeEach, expect, test, vi } from "vitest";

import { oneClickDns } from "./domain-connect";

// The team's DNS and its provider's API, as Cloudflare answers them.
const dns = new Map<string, string[]>();
const web = new Map<string, string>();
vi.mock("./custom-domains", () => ({ txtRecords: async (name: string) => dns.get(name) ?? [] }));
vi.mock("@tuti/jobs", () => ({ fetchSiteCheck: async (url: string) => web.get(url) ?? null }));

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const variables = { target: "customers.tuti.so", token: "abc" };
const returnTo = "https://tuti.so/app/acme/settings/domain";

beforeEach(() => {
  vi.stubEnv("DOMAIN_CONNECT_KEY", privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  dns.clear();
  web.clear();
  dns.set("_domainconnect.acme.co.uk", ["api.cloudflare.com/client/v4/dns/domainconnect"]);
  web.set(
    "https://api.cloudflare.com/client/v4/dns/domainconnect/v2/acme.co.uk/settings",
    JSON.stringify({ providerName: "cloudflare", providerDisplayName: "Cloudflare", urlSyncUX: "https://dash.cloudflare.com/domainconnect", urlAPI: "https://api.cloudflare.com/client/v4/dns/domainconnect" }),
  );
  web.set("https://api.cloudflare.com/client/v4/dns/domainconnect/v2/domainTemplates/providers/tuti.so/services/custom-domain", '{"version":1}');
});

test("a domain at a provider with Tuti's template gets a signed link to add its records there", async () => {
  const link = await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo);
  expect(link?.provider).toBe("Cloudflare");
  const url = new URL(link!.url);
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/tuti.so/services/custom-domain/apply");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ domain: "acme.co.uk", host: "help", target: "customers.tuti.so", token: "abc", redirect_uri: `${returnTo}?dns=added`, key: "_dck1" });

  // The signature covers the query before key, and comes last.
  const [signed, sig] = link!.url.split("?")[1]!.split("&key=_dck1&sig=");
  expect(verify("sha256", Buffer.from(signed!), publicKey, Buffer.from(decodeURIComponent(sig!), "base64"))).toBe(true);
});

test("a wildcard's answers on the subdomain (acme.co.uk's own TXT records, through *.acme.co.uk) don't hide the zone's provider", async () => {
  dns.set("_domainconnect.help.acme.co.uk", ["v=spf1 include:_spf.google.com ~all", "google-site-verification=abc"]);
  expect((await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo))?.provider).toBe("Cloudflare");

  // A host-like answer whose provider doesn't know the name: on to the next one.
  dns.set("_domainconnect.help.acme.co.uk", ["example.com"]);
  expect(new URL((await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo))!.url).searchParams.get("domain")).toBe("acme.co.uk");
});

test("an address at its zone's apex has no host; a custom domain there has no link (its CNAME needs one)", async () => {
  web.set("https://api.cloudflare.com/client/v4/dns/domainconnect/v2/domainTemplates/providers/tuti.so/services/email-domain", '{"version":1}');
  const link = await oneClickDns("acme.co.uk", "email-domain", { dkim1: "a", dkim2: "b", dkim3: "c" }, returnTo);
  expect(new URL(link!.url).searchParams.has("host")).toBe(false);
  expect(await oneClickDns("acme.co.uk", "custom-domain", variables, returnTo)).toBeNull();
});

test("no link without the key, Domain Connect, the template, or an https provider", async () => {
  expect(await oneClickDns("help.acme.co.uk", "email-domain", { dkim1: "a", dkim2: "b", dkim3: "c" }, returnTo)).toBeNull();

  web.set(
    "https://api.cloudflare.com/client/v4/dns/domainconnect/v2/acme.co.uk/settings",
    JSON.stringify({ providerName: "evil", urlSyncUX: "javascript:alert(1)//", urlAPI: "https://api.cloudflare.com/client/v4/dns/domainconnect" }),
  );
  expect(await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo)).toBeNull();

  dns.clear();
  expect(await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo)).toBeNull();
});

test("no link on a server without the key", async () => {
  vi.stubEnv("DOMAIN_CONNECT_KEY", "");
  expect(await oneClickDns("help.acme.co.uk", "custom-domain", variables, returnTo)).toBeNull();
});
