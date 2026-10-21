import { prisma } from "@tuti/db";
import { type CloudflareFake, type DnsFake, startCloudflareFake, startDnsFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { getDomain, removeDomain, setDomain, verifyDomain } from "./operations/domain";
import { call } from "./operations/run";

/**
 * Custom domains with Cloudflare for SaaS: a verified domain gets a custom hostname there (for its
 * certificate), and only then, so adding domains can't use up the zone's. Changing or removing the
 * domain deletes it; the certificate's status shows until it's active.
 */

let dns: DnsFake;
let cloudflare: CloudflareFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [dns, cloudflare] = await Promise.all([startDnsFake(), startCloudflareFake()]);
});
afterAll(() => Promise.all([dns.close(), cloudflare.close()]));

beforeEach(async () => {
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  for (const [name, value] of Object.entries(cloudflare.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (p = project) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: p.id });
const hostname = () => `help.${crypto.randomUUID().slice(0, 8)}.example.com`;
const atCloudflare = (host: string) => cloudflare.hostnames().filter((entry) => entry.hostname === host);

/** Adds `host` to the project and publishes its TXT record. */
async function add(host: string, p = project) {
  const { domain } = await call(setDomain, as(p), { hostname: host });
  dns.txt(domain.records[1]!.name, [domain.records[1]!.value]);
  return domain;
}

test("a domain gets its custom hostname once it's verified, and its certificate shows until it's active", async () => {
  const host = hostname();
  expect((await add(host)).certificate).toBeNull();
  expect(atCloudflare(host)).toEqual([]);

  const { domain } = await call(verifyDomain, as(), {});
  expect(domain).toMatchObject({ status: "verified", certificate: "pending" });
  expect(atCloudflare(host)).toHaveLength(1);
  // Each look asks again while it's on its way.
  expect((await call(getDomain, as(), {})).domain?.certificate).toBe("pending");
  cloudflare.certificate(host, "active");
  expect((await call(getDomain, as(), {})).domain?.certificate).toBe("active");
  expect(await prisma.customDomain.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({ certificate: "ACTIVE" });
});

test("a certificate Cloudflare gave up on shows as failed", async () => {
  const host = hostname();
  await add(host);
  await call(verifyDomain, as(), {});
  cloudflare.certificate(host, "validation_timed_out");
  expect((await call(getDomain, as(), {})).domain?.certificate).toBe("failed");
});

test("changing or removing the domain deletes its custom hostname", async () => {
  const [first, second] = [hostname(), hostname()];
  await add(first);
  await call(verifyDomain, as(), {});
  await add(second);
  expect(atCloudflare(first)).toEqual([]);
  await call(verifyDomain, as(), {});
  expect(atCloudflare(second)).toHaveLength(1);
  await call(removeDomain, as(), {});
  expect(atCloudflare(second)).toEqual([]);
});

test("when Cloudflare fails the domain isn't verified, and checking again works", async () => {
  const host = hostname();
  await add(host);
  cloudflare.failNext(500);
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 502, message: "We couldn't set up the domain's certificate. Try again in a minute" });
  expect((await call(getDomain, as(), {})).domain?.status).toBe("pending");
  expect((await call(verifyDomain, as(), {})).domain.status).toBe("verified");
  expect(atCloudflare(host)).toHaveLength(1);
});

test("a custom hostname left at Cloudflare (a delete that failed) is used again", async () => {
  const host = hostname();
  await add(host);
  await call(verifyDomain, as(), {});
  // The delete fails: removing still works, and the hostname stays at Cloudflare.
  cloudflare.failNext(500);
  await call(removeDomain, as(), {});
  const [left] = atCloudflare(host);
  expect(left).toBeDefined();
  await add(host);
  await call(verifyDomain, as(), {});
  expect(await prisma.customDomain.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({ cloudflareId: left!.id });
  expect(atCloudflare(host)).toHaveLength(1);
});

test("two checks at once share one custom hostname; a check that lost a race deletes the one it made", async () => {
  const host = hostname();
  await add(host);
  await Promise.all([call(verifyDomain, as(), {}), call(verifyDomain, as(), {})]);
  expect(atCloudflare(host)).toHaveLength(1);
  expect((await prisma.customDomain.findUniqueOrThrow({ where: { projectId: project.id } })).cloudflareId).toBe(atCloudflare(host)[0]!.id);

  // Another domain swapped in while the TXT record was looked up.
  const [mine, theirs] = [hostname(), hostname()];
  await add(mine);
  dns.during(() => call(setDomain, as(), { hostname: theirs }));
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 409 });
  expect(atCloudflare(mine)).toEqual([]);
});

test("another portal's verified domain keeps its custom hostname", async () => {
  const host = hostname();
  await add(host);
  await call(verifyDomain, as(), {});
  const other = await createProject(owner);
  // A pending claim from before, with a TXT record of its own: verifying it is refused.
  await prisma.customDomain.create({ data: { projectId: other.id, hostname: host, verificationToken: "other" } });
  dns.txt(`_tuti.${host}`, ["tuti-verify=other"]);
  await expect(call(verifyDomain, as(other), {})).rejects.toMatchObject({ status: 409, message: `${host} is already another portal's domain` });
  expect(atCloudflare(host)).toHaveLength(1);
  expect((await call(getDomain, as(), {})).domain?.status).toBe("verified");
});

test("a portal that verifies the domain first, while another's check is at Cloudflare, keeps it and its custom hostname", async () => {
  const host = hostname();
  const other = await createProject(owner);
  const theirs = await add(host, other);
  const mine = await add(host);
  dns.txt(`_tuti.${host}`, [theirs.records[1]!.value, mine.records[1]!.value]);
  // While this project's check is at Cloudflare, the other project's check verifies it (and makes the custom hostname).
  cloudflare.during(() => call(verifyDomain, as(other), {}));
  await expect(call(verifyDomain, as(), {})).rejects.toMatchObject({ status: 409, message: `${host} is already another portal's domain` });
  const [hostnameAtCloudflare] = atCloudflare(host);
  expect(await prisma.customDomain.findUniqueOrThrow({ where: { projectId: other.id } })).toMatchObject({ cloudflareId: hostnameAtCloudflare!.id });
});

test("without Cloudflare set up, a verified domain has no certificate status (the server's proxy gets certificates)", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const host = hostname();
  await add(host);
  expect((await call(verifyDomain, as(), {})).domain).toMatchObject({ status: "verified", certificate: null });
  expect(atCloudflare(host)).toEqual([]);
});
