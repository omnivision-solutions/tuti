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
/** The option cards: each one's title, and whether it's picked or locked. */
const options = (html: string) =>
  [...html.matchAll(/role="radio" aria-checked="(true|false)" aria-disabled="(true|false)"[^>]*>.*?<span class="text-sm font-medium">([^<]+)</g)].map(
    ([, checked, disabled, title]) => `${title}${checked === "true" ? " (picked)" : ""}${disabled === "true" ? " (locked)" : ""}`,
  );

test("neither: three ways to go live, the Tuti address picked, with its address to copy", () => {
  const html = card({ domain: null, site: null });
  expect(options(html)).toEqual(["Tuti address (picked)", "Custom domain", "Sub-folder"]);
  expect(html).toContain("https://acme.tuti.so");
  expect(html).toContain("Copy");
});

test("one connected: it's picked, the others locked until it's removed", () => {
  const withDomain = card({ domain, site: null });
  expect(options(withDomain)).toEqual(["Tuti address (locked)", "Custom domain (picked)", "Sub-folder (locked)"]);
  expect(withDomain).toContain("To switch, remove help.example.com first.");
  expect(withDomain).toContain("Remove domain");

  const withSite = card({ domain: null, site });
  expect(options(withSite)).toEqual(["Tuti address (locked)", "Custom domain (locked)", "Sub-folder (picked)"]);
  expect(withSite).toContain("To switch, remove example.com/portal first.");
  expect(withSite).toContain("Remove sub-folder");
});

test("both, from before a portal could only have one: both show, so either can be removed", () => {
  const html = card({ domain, site });
  expect(html).toContain("It can only have one: remove the one you don&#x27;t want.");
  expect(html).toContain("Remove domain");
  expect(html).toContain("Remove sub-folder");
});

test("custom domains off on this server: that option says so and can't be picked", () => {
  const html = card({ domain: null, site: null, domainsOn: false });
  expect(options(html)).toEqual(["Tuti address (picked)", "Custom domain (locked)", "Sub-folder"]);
  expect(html).toContain("Not set up on this server");
});
