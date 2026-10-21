import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/portal-settings", () => ({}));

const { OwnAddressSettings } = await import("./own-address");

const domain = { hostname: "help.example.com", status: "verified" as const, certificate: null, records: [] };
const site = { url: "https://example.com/portal", status: "verified" as const, forward: [] };
const card = (props: { domain: typeof domain | null; site: typeof site | null; domainsOn?: boolean }) =>
  renderToStaticMarkup(
    createElement(OwnAddressSettings, { projectSlug: "acme", domainsOn: true, portalAddress: "acme.tuti.so", protocol: "https:", ...props }),
  );

test("neither: the choice, a domain's form first", () => {
  const html = card({ domain: null, site: null });
  expect(html).toContain("A domain of its own");
  expect(html).toContain("A path of your site");
  expect(html).toContain("Add domain");
});

test("one of them: only that one, and how to switch", () => {
  const withDomain = card({ domain, site: null });
  expect(withDomain).toContain("help.example.com");
  expect(withDomain).not.toContain("A path of your site");
  expect(withDomain).toContain("To put your portal under a path of your site instead, remove this domain first.");

  const withSite = card({ domain: null, site });
  expect(withSite).toContain("https://example.com/portal");
  expect(withSite).not.toContain("A domain of its own");
  expect(withSite).toContain("To give your portal a domain of its own instead, remove it from your site first.");
});

test("both, from before a portal could only have one: both show, so either can be removed", () => {
  const html = card({ domain, site });
  expect(html).toContain("help.example.com");
  expect(html).toContain("https://example.com/portal");
  expect(html).toContain("Your portal has a domain of its own and a path of your site. It can only have one: remove the one you don&#x27;t want.");
  expect(html.match(/>Remove</g)).toHaveLength(2);
});

test("custom domains off on this server: only a path of the site", () => {
  const html = card({ domain: null, site: null, domainsOn: false });
  expect(html).not.toContain("A domain of its own");
  expect(html).toContain("Add address");
});
