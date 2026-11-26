import { prisma } from "@tuti/db";
import { billingFile } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterEach, expect, test, vi } from "vitest";

import { generateMetadata as articleMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { generateMetadata as feedbackMetadata } from "@/app/portal/[project]/(site)/feedback/page";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { previewToken } from "@/lib/preview-session";
import { proxy } from "@/proxy";
import { createProject, signUp } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { portalLanguages } from "./language-addresses";
import { getLanguages, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { PREVIEW_READER_COOKIE } from "./portal-access";
import { portalHref, portalLinkBase, portalLinks } from "./portal-base";

/** Language addresses (docs/plan.md, Languages: L3): /de/… on a portal with German live, read from the database. */

afterEach(() => {
  vi.unstubAllEnvs();
  request.headers = {};
});

async function setUp() {
  const owner = await signUp();
  const project = await createProject(owner);
  const context = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  // German live, French offline.
  await call(updateLanguages, context, { languages: [{ code: "de", live: true }, { code: "fr" }] });
  await prisma.article.create({ data: { projectId: project.id, slug: "billing", title: "Billing", publishedAt: new Date() } });
  const host = `${project.slug}.localhost:3100`;
  const visit = (path: string, cookie?: string) => proxy(new NextRequest(`http://${host}${path}`, { headers: { host, ...(cookie && { cookie }) } }));
  return { owner, project, context, host, visit };
}

/** A page's request under a language's address, as proxy.ts sends it. */
const inLanguage = (language: string, prefix = "") => (request.headers = { "x-tuti-language": language, "x-tuti-language-prefix": prefix });

test("the proxy reads which languages are live as languages.get does, and a change at once", async () => {
  const { project, context, visit } = await setUp();
  expect(await portalLanguages(project.slug)).toEqual({ default: "en", live: ["de"], stored: ["de", "fr"] });
  expect((await visit("/de/docs/billing")).headers.get("x-middleware-rewrite")).toMatch(/\/portal\/[^/]+\/docs\/billing$/);
  expect((await visit("/fr/docs/billing")).headers.get("location")).toMatch(/\/docs\/billing$/);

  await call(updateLanguages, context, { languages: [{ code: "de", live: false }, { code: "fr", live: true }] });
  expect((await visit("/de/docs/billing")).status).toBe(307);
  expect((await visit("/fr/docs/billing")).headers.get("x-middleware-request-x-tuti-language")).toBe("fr");

  // Past the plan's limit (Free: the default alone) none is live, as languages.get says.
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await call(updateLanguages, context, { languages: [{ code: "de" }, { code: "fr" }] });
  expect((await call(getLanguages, context, {})).languages.map(({ live }) => live)).toEqual([false, false]);
  expect((await portalLanguages(project.slug))?.live).toEqual([]);
});

test("the team's preview of an offline language: a team member's preview token, not someone else's", async () => {
  const { owner, project, visit } = await setUp();
  const team = `${PREVIEW_READER_COOKIE}=${previewToken(project.id, owner.id)}`;
  expect((await visit("/fr/docs/billing", team)).headers.get("x-middleware-request-x-tuti-language")).toBe("fr");
  const stranger = await signUp("Stranger");
  expect((await visit("/fr/docs/billing", `${PREVIEW_READER_COOKIE}=${previewToken(project.id, stranger.id)}`)).status).toBe(307);
  expect((await visit("/fr/docs/billing")).status).toBe(307);
});

test("hreflang: the portal's own pages in every live language, x-default the default's; an article in the default language alone until it's translated", async () => {
  const { project } = await setUp();
  const address = `http://${project.slug}.localhost:3100`;
  const params = { params: Promise.resolve({ project: project.slug }) } as never;

  inLanguage("de", "/de");
  expect((await feedbackMetadata(params)).alternates).toEqual({
    canonical: `${address}/de/feedback`,
    languages: { en: `${address}/feedback`, de: `${address}/de/feedback`, "x-default": `${address}/feedback` },
  });
  // Before L8 an article is in the default language: its other addresses' canonical is the default's, with no alternates.
  const article = await articleMetadata({ params: Promise.resolve({ project: project.slug, slug: "billing" }) } as never);
  expect(article.alternates).toEqual({ canonical: `${address}/docs/billing`, types: { "text/markdown": `${address}/docs/billing.md` } });

  inLanguage("en");
  expect((await feedbackMetadata(params)).alternates?.canonical).toBe(`${address}/feedback`);

  // The team's preview of an offline one: kept from search engines, no hreflang.
  inLanguage("fr", "/fr");
  const preview = await feedbackMetadata(params);
  expect(preview.robots).toEqual({ index: false, follow: false });
  expect(preview.alternates).toEqual({ canonical: `${address}/feedback` });
});

test("the server's links add the language's prefix: under a site's path, and not twice", async () => {
  inLanguage("de", "/de");
  request.headers["x-tuti-base"] = "/help";
  expect([await portalHref("/docs/billing"), await portalHref("/"), await portalLinkBase(), (await portalLinks())("/de/feedback")]).toEqual([
    "/help/de/docs/billing",
    "/help/de",
    "/help/de",
    "/help/de/feedback",
  ]);
  inLanguage("en");
  expect(await portalHref("/docs/billing")).toBe("/docs/billing");
});

test("the sitemap lists the portal's own pages in each live language with alternates, articles in the default language alone; /de/llms.txt links German addresses", async () => {
  const { project } = await setUp();
  const address = `http://${project.slug}.localhost:3100`;
  const params = { params: Promise.resolve({ project: project.slug }) } as never;
  const xml = await (await sitemap(new Request("http://x"), params)).text();
  const alternates = `<xhtml:link rel="alternate" hreflang="en" href="${address}/roadmap"/><xhtml:link rel="alternate" hreflang="de" href="${address}/de/roadmap"/><xhtml:link rel="alternate" hreflang="x-default" href="${address}/roadmap"/>`;
  expect(xml).toContain(`<url><loc>${address}/roadmap</loc>${alternates}`);
  expect(xml).toContain(`<url><loc>${address}/de/roadmap</loc>${alternates}`);
  expect(xml).toMatch(new RegExp(`<url><loc>${address}/docs/billing</loc><lastmod>`));
  expect(xml).not.toContain("/de/docs/billing");
  expect(xml).not.toContain("/fr/");
  expect(xml).toContain(`<url><loc>${address}/de/docs</loc>`);

  // A docs tab showing an article in its place (here the home tab, /docs) is the article's page: the default language's alone.
  const billing = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } });
  await prisma.docsTab.create({ data: { projectId: project.id, slug: "guides", name: "Guides", landing: "PAGE", landingArticleId: billing.id } });
  const withLanding = await (await sitemap(new Request("http://x"), params)).text();
  expect(withLanding).toMatch(new RegExp(`<url><loc>${address}/docs</loc><lastmod>`));
  expect(withLanding).not.toContain(`${address}/de/docs`);

  inLanguage("de", "/de");
  expect(await (await llms(new Request("http://x"), params)).text()).toContain(`(${address}/de/docs/billing.md)`);
  inLanguage("en");
  expect(await (await llms(new Request("http://x"), params)).text()).toContain(`(${address}/docs/billing.md)`);
});
