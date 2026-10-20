import { prisma } from "@tuti/db";
import { type DnsFake, startDnsFake } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import { proxy } from "@/proxy";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { requestTarget } from "./custom-domains";
import { getDomain, removeDomain, setDomain, verifyDomain } from "./operations/domain";
import { updatePortal } from "./operations/portal";
import { call } from "./operations/run";

/**
 * A portal on its own domain: the team adds it and a TXT record that proves it's theirs; once
 * verified the portal answers there (pages, sign-in), and until then, or once removed, it doesn't.
 */

let dns: DnsFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  dns = await startDnsFake();
});
afterAll(() => dns.close());

beforeEach(async () => {
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (p = project) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: p.id });
/** A hostname nobody else in this file uses. */
const hostname = () => `help.${crypto.randomUUID().slice(0, 8)}.example.com`;

/** Adds `host` to the project and its TXT record to DNS: what the team does, then verifies. */
async function addAndPublish(host: string, p = project) {
  const { domain } = await call(setDomain, as(p), { hostname: host });
  const txt = domain.records.find((record) => record.type === "TXT")!;
  dns.txt(txt.name, [txt.value]);
  return domain;
}

test("adding a domain: as pasted, with the records to add; it only serves the portal once the TXT record is there", async () => {
  const host = hostname();
  const { domain } = await call(setDomain, as(), { hostname: ` https://${host.toUpperCase()}/docs ` });
  expect(domain).toMatchObject({
    hostname: host,
    status: "pending",
    verifiedAt: null,
    records: [
      { type: "CNAME", name: host, value: "customers.example.net" },
      { type: "TXT", name: `_tuti.${host}`, value: expect.stringMatching(/^tuti-verify=[0-9a-f]{32}$/) },
    ],
  });
  expect(await call(getDomain, as(), {})).toEqual({ domain });
  expect(await requestTarget(host)).toEqual({ kind: "unknown" });

  // Not there yet, or another record: nothing changes.
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({
    status: 400,
    message: `We couldn't find the TXT record _tuti.${host} with ${domain.records[1]!.value} yet. DNS changes can take a few minutes to show`,
  });
  dns.txt(`_tuti.${host}`, ["tuti-verify=someone-elses", "v=spf1 -all"]);
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 400 });
  dns.fail(true);
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 502, message: "We couldn't look up the domain's DNS records. Try again in a minute" });
  dns.fail(false);

  // Among others, as DNS providers allow.
  dns.txt(`_tuti.${host}`, ["v=spf1 -all", domain.records[1]!.value]);
  expect((await call(verifyDomain, as(), {})).domain).toMatchObject({ status: "verified", verifiedAt: expect.any(String) });
  expect(await requestTarget(host)).toEqual({ kind: "portal", slug: project.slug, customDomain: host });
  expect(await requestTarget(`${host.toUpperCase()}:443`)).toMatchObject({ kind: "portal", slug: project.slug });
  // Again: still verified.
  expect((await call(verifyDomain, as(), {})).domain.status).toBe("verified");
});

test("the portal answers on it: its pages, and a private portal's sign-in stays on that domain", async () => {
  const host = hostname();
  await addAndPublish(host);
  await call(verifyDomain, as(), {});
  const visit = (path: string) => proxy(new NextRequest(`http://${host}${path}`, { headers: { host } }));
  expect((await visit("/b/feature-requests")).headers.get("x-middleware-rewrite")).toBe(`http://${host}/portal/${project.slug}/b/feature-requests`);
  expect((await visit("/help/getting-started.md")).headers.get("x-middleware-rewrite")).toBe(`http://${host}/portal/${project.slug}/help/getting-started/md`);
  // The app's own pages aren't there.
  expect((await visit("/app")).headers.get("x-middleware-rewrite")).toBe(`http://${host}/portal/${project.slug}/app`);

  await call(updatePortal, as(), { access: "private" });
  const response = await visit("/changelog");
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`http://${host}/sign-in?next=%2Fchangelog`);
});

test("signing in on it: its forms are trusted while it's verified (the browser journey signs in there)", async () => {
  const host = hostname();
  await addAndPublish(host);
  // Better Auth checks a form's origin against these (it skips the check in tests, so it's asked here).
  const trusted = (requestHost: string) => (auth.options.trustedOrigins as (request?: Request) => Promise<string[]>)(new Request(`http://${requestHost}/api/auth/sign-in/email`, { headers: { host: requestHost } }));
  expect(await trusted(host)).toEqual([]);
  await call(verifyDomain, as(), {});
  expect(await trusted(host)).toEqual([`http://${host}`]);
  expect(await trusted("evil.example.com")).toEqual([]);
  // At startup there's no request.
  expect(await (auth.options.trustedOrigins as (request?: Request) => Promise<string[]>)(undefined)).toEqual([]);
});

test("a domain someone else added but didn't verify doesn't stop its owner; once it's verified, it's theirs", async () => {
  const host = hostname();
  const squatter = await createProject(owner);
  await call(setDomain, as(squatter), { hostname: host });
  await addAndPublish(host);
  await call(verifyDomain, as(), {});
  // Now nobody else can add or verify it, even with a TXT record of their own there.
  await expect(call(setDomain, as(squatter), { hostname: host })).rejects.toMatchObject({ status: 409, message: `${host} is already another portal's domain` });
  const { domain } = await call(getDomain, as(squatter), {});
  dns.txt(`_tuti.${host}`, [domain!.records[1]!.value]);
  await expect(call(verifyDomain, as(squatter), {})).rejects.toMatchObject({ status: 409 });
  expect(await requestTarget(host)).toMatchObject({ slug: project.slug });
});

test("changing or removing the domain: the old one stops answering at once", async () => {
  const [first, second] = [hostname(), hostname()];
  await addAndPublish(first);
  await call(verifyDomain, as(), {});
  expect(await requestTarget(first)).toMatchObject({ kind: "portal" });

  // A new domain starts over, with a new token: the old record doesn't verify it.
  const old = (await call(getDomain, as(), {})).domain!.records[1]!.value;
  const { domain } = await call(setDomain, as(), { hostname: second });
  expect(domain).toMatchObject({ hostname: second, status: "pending" });
  expect(domain.records[1]!.value).not.toBe(old);
  expect(await requestTarget(first)).toEqual({ kind: "unknown" });
  // The same one again changes nothing.
  expect((await call(setDomain, as(), { hostname: second })).domain).toEqual(domain);

  dns.txt(domain.records[1]!.name, [domain.records[1]!.value]);
  await call(verifyDomain, as(), {});
  expect(await call(removeDomain, as(), {})).toEqual({ removed: second });
  expect(await requestTarget(second)).toEqual({ kind: "unknown" });
  expect(await call(getDomain, as(), {})).toEqual({ domain: null });
  await expect(call(removeDomain, as(), {})).rejects.toMatchObject({ status: 404 });
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 404, message: "Add a domain first" });
  // Deleting the project deletes its domain.
  await addAndPublish(first);
  await prisma.project.delete({ where: { id: project.id } });
  expect(await prisma.customDomain.count({ where: { hostname: first } })).toBe(0);
});

test("only hostnames that can be a domain of the team's own", async () => {
  for (const [input, message] of [
    ["not a domain", "Enter a domain like help.example.com"],
    ["localhost", "Enter a domain like help.example.com"],
    ["help.example.com:8080", "Enter the domain without a port"],
    ["192.168.0.1", "Enter a domain like help.example.com"],
    ["-help.example.com", "Enter a domain like help.example.com"],
  ]) {
    await expect(call(setDomain, as(), { hostname: input! })).rejects.toMatchObject({ status: 400, message });
  }
  // International names are stored as punycode.
  expect((await call(setDomain, as(), { hostname: "hilfe.bücher.example" })).domain.hostname).toBe("hilfe.xn--bcher-kva.example");
});

test("off unless the server says where domains point; one added before keeps showing so it can be removed", async () => {
  await addAndPublish(hostname());
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "");
  await expect(call(setDomain, as(), { hostname: hostname() })).rejects.toMatchObject({
    status: 400,
    message: "Custom domains aren't set up on this server (see CUSTOM_DOMAIN_TARGET in .env.example)",
  });
  expect((await call(getDomain, as(), {})).domain).toMatchObject({ records: [{ type: "TXT" }] });
  await call(removeDomain, as(), {});
});
