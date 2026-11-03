import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/server/portal-settings", () => ({}));
vi.mock("@/server/inbox", () => ({}));

const { CustomDomainSettings } = await import("./custom-domain");
const { EmailDomainSettings } = await import("./inbox/email-domain");

/** Each record's row: its type and its status ("" where it has none). */
const statuses = (html: string) =>
  [...html.matchAll(/<tr[^>]*><td[^>]*>([A-Z]+)<\/td>.*?<\/tr>/g)].map(([row, type]) => `${type} ${/>(Verified|Pending|Failed)</.exec(row)?.[1] ?? ""}`.trim());

const records = [
  { type: "CNAME" as const, name: "help.example.com", value: "customers.tuti.so" },
  { type: "TXT" as const, name: "_tuti.help.example.com", value: "tuti-verify=abc" },
];
const domain = (status: "pending" | "verified", certificate: "pending" | "active" | "failed" | null) =>
  renderToStaticMarkup(
    createElement(CustomDomainSettings, { projectSlug: "acme", domain: { hostname: "help.example.com", status, certificate, records }, portalAddress: "acme.tuti.so", protocol: "https:" }),
  );

test("a custom domain's TXT record is pending until it's verified; its CNAME has a status only once Cloudflare checks it, for its certificate", () => {
  expect(statuses(domain("pending", null))).toEqual(["CNAME", "TXT Pending"]);
  expect(statuses(domain("verified", "pending"))).toEqual(["CNAME Pending", "TXT Verified"]);
  expect(statuses(domain("verified", "active"))).toEqual(["CNAME Verified", "TXT Verified"]);
  expect(statuses(domain("verified", "failed"))).toEqual(["CNAME Failed", "TXT Verified"]);
  // The server's own proxy gets its certificates: nothing checks the CNAME.
  expect(statuses(domain("verified", null))).toEqual(["CNAME", "TXT Verified"]);
});

const own = (verified: boolean, error: string | null) =>
  renderToStaticMarkup(
    createElement(EmailDomainSettings, {
      projectSlug: "acme",
      supportAddress: "e2e-inbox@example.com",
      own: {
        included: true,
        address: "e2e-support@example.com",
        records: [1, 2, 3].map((n) => ({ type: "CNAME" as const, name: `t${n}._domainkey.example.com`, value: `t${n}.dkim.amazonses.com` })),
        verified,
        error,
        receivedAt: new Date(),
      },
    }),
  );

test("the own address's 3 records, checked together: pending, then verified; after a failure (which may not be theirs) they have none", () => {
  expect(statuses(own(false, null))).toEqual(["CNAME Pending", "CNAME Pending", "CNAME Pending"]);
  expect(statuses(own(true, null))).toEqual(["CNAME Verified", "CNAME Verified", "CNAME Verified"]);
  expect(statuses(own(false, "Amazon SES doesn't have this domain for you any more: remove it and add it again"))).toEqual(["CNAME", "CNAME", "CNAME"]);
});

test("each Copy button is named for its record: numbered where a type repeats, as the own address's 3 CNAMEs", () => {
  const names = (html: string) => [...html.matchAll(/aria-label="(Copy [^"]+)"/g)].map(([, name]) => name);
  expect(names(own(false, null))).toEqual(["CNAME 1", "CNAME 2", "CNAME 3"].flatMap((tag) => [`Copy ${tag} name`, `Copy ${tag} content`]).concat(["Copy forwarding from", "Copy forwarding to"]));
  expect(names(domain("pending", null))).toEqual(["Copy CNAME name", "Copy CNAME content", "Copy TXT name", "Copy TXT content"]);
});
