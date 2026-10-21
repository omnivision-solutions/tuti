import { prisma } from "@tuti/db";
import { type CloudflareFake, type DnsFake, startCloudflareFake, startDnsFake } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { randomSecret } from "@/lib/portal-handoff";
import { proxy } from "@/proxy";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { forgetCustomDomain, portalAddress } from "./custom-domains";
import { getDomain, removeDomain, setDomain, verifyDomain } from "./operations/domain";
import { createChangelogEntry } from "./operations/changelog";
import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { escalateDocs } from "./operations/docs-escalate";
import { addPortalReaders, updatePortal } from "./operations/portal";
import { createArticle, getArticle, publishArticle } from "./operations/docs";
import { call } from "./operations/run";
import { continueToPortal } from "./portal-handoff";
import { emailSignInLink } from "./sign-in-link";

/**
 * A portal's address: its custom domain once that's live (verified, with its certificate where
 * Cloudflare gets one), else its Tuti address. Every link Tuti makes uses it, and the Tuti
 * address sends pages on to it.
 */

let dns: DnsFake;
let cloudflare: CloudflareFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let host: string;

beforeAll(async () => {
  [dns, cloudflare] = await Promise.all([startDnsFake(), startCloudflareFake()]);
});
afterAll(() => Promise.all([dns.close(), cloudflare.close()]));

beforeEach(async () => {
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  // Cloudflare only where a test sets it up.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  owner = await signUp("Owner");
  project = await createProject(owner);
  host = `help.${crypto.randomUUID().slice(0, 8)}.example.com`;
  actAs(null);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const tutiAddress = () => `http://${project.slug}.localhost:3100`;

/** Adds the domain, publishes its TXT record and verifies it. */
async function verified() {
  const { domain } = await call(setDomain, as(), { hostname: host });
  dns.txt(domain.records[1]!.name, [domain.records[1]!.value]);
  return (await call(verifyDomain, as(), {})).domain;
}

const visit = (path: string, method = "GET") => {
  const tuti = `${project.slug}.localhost:3100`;
  return proxy(new NextRequest(`http://${tuti}${path}`, { method, headers: { host: tuti } }));
};

test("the Tuti address until the domain is verified, the domain from then until it's removed", async () => {
  await call(setDomain, as(), { hostname: host });
  expect(await portalAddress(project.slug)).toBe(tutiAddress());
  await verified();
  expect(await portalAddress(project.slug)).toBe(`http://${host}:3100`);
  await call(removeDomain, as(), {});
  expect(await portalAddress(project.slug)).toBe(tutiAddress());
});

test("with Cloudflare, only once its certificate is active: links never go where HTTPS doesn't work yet", async () => {
  for (const [name, value] of Object.entries(cloudflare.env)) {
    vi.stubEnv(name, value);
  }
  expect(await verified()).toMatchObject({ certificate: "pending" });
  expect(await portalAddress(project.slug)).toBe(tutiAddress());
  expect((await visit("/docs")).status).not.toBe(308);
  cloudflare.certificate(host, "active");
  // Settings (or domain.get) learns it's active.
  await call(getDomain, as(), {});
  expect(await portalAddress(project.slug)).toBe(`http://${host}:3100`);
});

test("the Tuti address sends pages on to the domain, with their path and query; not the auth API, the widget's panel or forms", async () => {
  await verified();
  const response = await visit("/docs/getting-started?q=x");
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe(`http://${host}:3100/docs/getting-started?q=x`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await visit("/api/auth/get-session")).status).not.toBe(308);
  expect((await visit("/widget")).status).not.toBe(308);
  expect((await visit("/feedback/feature-requests", "POST")).status).not.toBe(308);
});

test("with custom domains off on the server, everything stays at the Tuti address", async () => {
  await verified();
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "");
  expect(await portalAddress(project.slug)).toBe(tutiAddress());
  expect((await visit("/docs")).status).not.toBe(308);
});

test("links Tuti makes use the domain: sign-in emails, the sitemap, the API, and the way back from the app", async () => {
  await verified();
  const email = owner.email;
  const form = new FormData();
  form.set("email", email);
  await emailSignInLink(project.slug, "/", form);
  expect((await mailbox.latestTo(email)).text).toContain(`http://${host}:3100/sign-in/link?token=`);

  const map = await (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  expect(map).toContain(`<loc>http://${host}:3100/feedback/feature-requests</loc>`);
  expect(map).not.toContain(tutiAddress());

  await call(createArticle, as(), { title: "Getting started", body: "Hello" });
  await call(publishArticle, as(), { slug: "getting-started" });
  expect(await call(getArticle, as(), { slug: "getting-started" })).toMatchObject({ url: `http://${host}:3100/docs/getting-started` });
  expect(await call(createPost, as(), { board: "feature-requests", title: "Dark mode" })).toMatchObject({ url: `http://${host}:3100/feedback/feature-requests/dark-mode-1` });

  // "Continue as" signs them in on the domain, where they started.
  actAs(owner);
  const back = await redirectTarget(continueToPortal(project.slug, randomSecret(), "/roadmap"));
  expect(back.startsWith(`http://${host}:3100/api/auth/continue/callback?code=`)).toBe(true);
  expect(await prisma.portalHandoff.count({ where: { projectId: project.id } })).toBe(1);
});

test("a failing address lookup fails a request before it writes anything, so a retry does it all", async () => {
  await verified();
  const board = project.boards[0]!;
  await call(updatePortal, as(), { access: "private" });
  await prisma.project.update({ where: { id: project.id }, data: { supportEmail: "e2e-support@example.com" } });
  const question = await prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: owner.id, question: "Can I pay with crypto?", source: "PORTAL", status: "NO_ANSWER" },
  });
  await call(createPost, as(), { board: board.slug, title: "Night mode" });
  forgetCustomDomain(host);
  // Its lookups fail from now on (none kept: that forgot them).
  const spy = vi.spyOn(prisma.customDomain, "findFirst").mockRejectedValue(new Error("database down"));
  try {
    await expect(call(createPost, as(), { board: board.slug, title: "Dark mode" })).rejects.toThrow("database down");
    await expect(call(updatePost, as(), { number: 1, status: "planned" })).rejects.toThrow("database down");
    await expect(call(createArticle, as(), { title: "Billing", body: "Hi" })).rejects.toThrow("database down");
    await expect(call(createChangelogEntry, as(), { title: "Dark mode", body: "Shipped" })).rejects.toThrow("database down");
    await expect(call(addPortalReaders, as(), { emails: ["e2e-reader@example.com"] })).rejects.toThrow("database down");
    await expect(call(escalateDocs, as(), { questionId: question.id, email: owner.email, note: "" })).rejects.toThrow("database down");
  } finally {
    spy.mockRestore();
  }
  // Only the post from before; its status unchanged, so a retry changes it (and tells the webhooks).
  expect(await prisma.post.findMany({ where: { projectId: project.id }, select: { title: true, status: true } })).toEqual([{ title: "Night mode", status: "OPEN" }]);
  expect(await prisma.portalReader.count({ where: { projectId: project.id } })).toBe(0);
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(0);
  expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(0);
  // Not claimed: asking a person again works.
  expect(await prisma.docsQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ escalatedAt: null });
});
