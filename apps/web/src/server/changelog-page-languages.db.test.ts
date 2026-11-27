import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import ChangelogEntryPage, { generateMetadata } from "@/app/portal/[project]/(site)/changelog/[number]/page";
import { GET as shareImage } from "@/app/portal/[project]/(site)/og/[[...path]]/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { changelogContents, publishedEntries } from "./changelog-queries";
import { portalAddress } from "./custom-domains";
import { shareCard } from "./share-card";
import { createChangelogEntry, publishChangelogEntry } from "./operations/changelog";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

// The share card's drawing is watched (what it's asked to draw), as article-page-languages.db.test.ts does.
vi.mock("@/server/share-card", async (original) => {
  const actual = await original<typeof import("@/server/share-card")>();
  return { ...actual, shareCard: vi.fn(actual.shareCard) };
});

/** The portal's changelog pages in the reader's language (docs/plan.md L17), with the article pages' fallback rules. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let entryId: string;
let number: number;
let portal: string;
const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

const german: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wechsle das Design im Profilmenü." }] }] };

/** "Dark mode", published; German (live) has a version the team wrote, French (live) none. */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.headers = {};
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] });
  ({ number } = await call(createChangelogEntry, as(), { title: "Dark mode", body: "Switch themes from your profile menu." }));
  await call(publishChangelogEntry, as(), { number });
  ({ id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } }));
  await prisma.changelogTranslation.create({
    data: { entryId, projectId: project.id, language: "de", automatic: false, title: "Dunkler Modus", content: german, body: "Wechsle das Design im Profilmenü.", publishedAt: new Date() },
  });
  portal = await portalAddress(project.slug);
});

/** A page's request at `language`'s address, as proxy.ts sends it on (null: the default language's). */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });
const params = () => ({ params: Promise.resolve({ project: project.slug, number: String(number) }), searchParams: Promise.resolve({}) }) as never;

/** Every element of the entry's page (as returned, components not rendered) with its props. */
async function page() {
  const all: { type: unknown; props: Record<string, unknown> }[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object" && "props" in node) {
      const { props } = node as ReactElement<Record<string, unknown>>;
      all.push({ type: (node as ReactElement).type, props });
      walk(props.children as ReactNode);
    }
  };
  walk((await ChangelogEntryPage(params())) as ReactNode);
  return all;
}
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as ReactElement<{ children?: unknown }>).props.children) : "");
const shownEntry = (elements: Awaited<ReturnType<typeof page>>) => elements.find(({ props }) => "entry" in props && "react" in props)?.props.entry as { title: string; doc: Doc; lang?: string; untranslated?: true };

test("at a language's address an entry translated there reads in its version, in that language, its search data there", async () => {
  at("de");
  const elements = await page();
  const entry = shownEntry(elements);
  expect(entry).toMatchObject({ title: "Dunkler Modus", lang: "de" });
  expect(toPlainText(entry.doc)).toContain("Wechsle das Design");
  expect(entry.untranslated).toBeUndefined();
  // No "not translated" line.
  expect(elements.some(({ type, props }) => type === "p" && props.lang === "de")).toBe(false);
  const jsonLd = elements.find(({ props }) => typeof (props.dangerouslySetInnerHTML as { __html?: string } | undefined)?.__html === "string");
  const data = JSON.parse((jsonLd!.props.dangerouslySetInnerHTML as { __html: string }).__html) as { headline?: string; url?: string } | { headline?: string; url?: string }[];
  expect(Array.isArray(data) ? data[0] : data).toMatchObject({ headline: "Dunkler Modus", url: `${portal}/de/changelog/${number}` });
});

test("not translated: the default language's version, and a line in the page's language saying so", async () => {
  at("fr");
  const elements = await page();
  expect(shownEntry(elements)).toMatchObject({ title: "Dark mode", untranslated: true });
  expect(shownEntry(elements).lang).toBeUndefined();
  const line = elements.find(({ type, props }) => type === "p" && props.lang === "fr");
  expect(text(line?.props.children)).toContain("Cette page n'est pas encore disponible en français");
});

test("hreflang, the canonical and the share card: the languages it's translated into; not translated, the default address", async () => {
  at("de");
  const translated = await generateMetadata(params());
  expect(translated.title).toBe("Dunkler Modus");
  expect(translated.alternates).toMatchObject({
    canonical: `${portal}/de/changelog/${number}`,
    languages: { en: `${portal}/changelog/${number}`, de: `${portal}/de/changelog/${number}`, "x-default": `${portal}/changelog/${number}` },
  });
  expect(translated.alternates?.languages).not.toHaveProperty("fr");
  // Its share card is made at its German address, and drawn there with the German title.
  expect(translated.openGraph?.images).toMatchObject([{ url: `${portal}/de/og/changelog/${number}` }]);
  vi.mocked(shareCard).mockClear();
  expect((await shareImage(new Request("http://x"), { params: Promise.resolve({ project: project.slug, path: ["changelog", String(number)] }) })).status).toBe(200);
  expect(vi.mocked(shareCard).mock.calls[0]?.[1]).toMatchObject({ title: "Dunkler Modus" });
  at("fr");
  const fallback = await generateMetadata(params());
  expect(fallback.title).toBe("Dark mode");
  expect(fallback.alternates?.canonical).toBe(`${portal}/changelog/${number}`);
  expect(fallback.openGraph?.images).toMatchObject([{ url: `${portal}/og/changelog/${number}` }]);
});

test("a version kept up to date whose entry changed but wasn't translated again reads as not translated, never its old text, and hreflang and the sitemap leave it out", async () => {
  const entry = await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId } });
  await prisma.changelogTranslation.updateMany({ where: { entryId }, data: { automatic: true, sourceHash: "old" } });
  at("de");
  expect(shownEntry(await page())).toMatchObject({ title: "Dark mode", untranslated: true });
  const sitemapXml = async () => (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  at(null);
  expect((await generateMetadata(params())).alternates?.languages?.de).toBeUndefined();
  expect(await sitemapXml()).not.toContain(`${portal}/de/changelog/${number}`);
  // Made from the entry as it is: shown again, and pointed at.
  await prisma.changelogTranslation.updateMany({ where: { entryId }, data: { sourceHash: translationSource({ ...entry, content: entry.content as Doc | null }).hash } });
  expect((await generateMetadata(params())).alternates?.languages).toMatchObject({ de: `${portal}/de/changelog/${number}` });
  const xml = await sitemapXml();
  expect(xml).toContain(`<loc>${portal}/de/changelog/${number}</loc>`);
  expect(xml).toContain(`hreflang="de" href="${portal}/de/changelog/${number}"`);
  expect(xml).not.toContain(`${portal}/fr/changelog/${number}`);
  at("de");
  expect(shownEntry(await page())).toMatchObject({ title: "Dunkler Modus" });
});

test("the changelog's list and its menu: each entry in the page's language where it's translated there", async () => {
  const { number: other } = await call(createChangelogEntry, as(), { title: "Faster search", body: "Results come quicker." });
  await call(publishChangelogEntry, as(), { number: other });
  const reader = null;
  const listed = await publishedEntries(project.slug, reader, { language: "de" });
  expect(listed.map(({ title, lang, untranslated }) => ({ title, lang, untranslated }))).toEqual([
    { title: "Faster search", lang: undefined, untranslated: true },
    { title: "Dunkler Modus", lang: "de", untranslated: undefined },
  ]);
  expect((await changelogContents(project.slug, reader, { language: "de" })).map(({ title, lang }) => ({ title, lang }))).toEqual([
    { title: "Faster search", lang: undefined },
    { title: "Dunkler Modus", lang: "de" },
  ]);
  // The default language's: as written.
  expect((await publishedEntries(project.slug, reader)).map(({ title }) => title)).toEqual(["Faster search", "Dark mode"]);
});
