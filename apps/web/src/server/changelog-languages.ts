import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import { aiEnabled, isLanguage, type LANGUAGE_CODES, LANGUAGES } from "@tuti/shared";

import type { EntryLanguage } from "@/components/changelog-languages";
import { type VersionState, versionState } from "@/lib/changelog-versions";
import { readArticleVersion } from "@/server/operations/translations";

/**
 * An entry's languages for its editor (docs/plan.md L16): the project's default, then its others in the order added, each
 * with where its version stands and its address (`?language=`). Null with no other languages, and for a draft (its
 * versions are made from what's published) or a sample entry (never translated).
 */
export async function entryLanguages(
  projectId: string,
  slug: string,
  entry: { id: string; number: number; title: string; body: string; content: unknown; publishedAt: Date | null; sample: boolean },
): Promise<EntryLanguage[] | null> {
  if (!entry.publishedAt || entry.sample) {
    return null;
  }
  const { hash } = translationSource({ ...entry, content: entry.content as Doc | null });
  return languagesOf(projectId, `/app/${slug}/changelog/${entry.number}`, async () => {
    const rows = await prisma.changelogTranslation.findMany({
      where: { entryId: entry.id },
      select: { language: true, automatic: true, publishedAt: true, sourceHash: true, error: true, behind: true, retranslate: true, retranslated: true },
    });
    return (code) => versionState(rows.find((version) => version.language === code), hash, aiEnabled());
  });
}

/**
 * An article's languages for its editor's pill (docs/plan.md L11), as an entry's (null for a draft or a sample): each read
 * as its own page reads it, so the pill says what opening it says (behind is worked out by section).
 */
export async function articleLanguages(projectId: string, slug: string, article: { slug: string; publishedAt: Date | null; sample: boolean }): Promise<EntryLanguage[] | null> {
  if (!article.publishedAt || article.sample) {
    return null;
  }
  return languagesOf(projectId, `/app/${slug}/docs/${article.slug}`, async (codes) => {
    // ponytail: one read per language (a project has a few); a batched read if projects get many.
    const states = await Promise.all(codes.map(async (code) => [code, (await readArticleVersion(projectId, article.slug, code as (typeof LANGUAGE_CODES)[number])).state] as const));
    return (code) => states.find(([each]) => each === code)![1];
  });
}

async function languagesOf(projectId: string, base: string, statesOf: (codes: string[]) => Promise<(code: string) => VersionState>): Promise<EntryLanguage[] | null> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { language: true, languages: { select: { code: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  if (project.languages.length === 0) {
    return null;
  }
  const stateOf = await statesOf(project.languages.map(({ code }) => code));
  const name = (code: string) => (isLanguage(code) ? LANGUAGES[code].native : code);
  return [
    { code: project.language, name: name(project.language), state: "default", href: base },
    ...project.languages.map(({ code }) => ({ code, name: name(code), state: stateOf(code), href: `${base}?language=${code}` })),
  ];
}
