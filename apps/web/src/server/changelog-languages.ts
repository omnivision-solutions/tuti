import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import { aiEnabled, isLanguage, LANGUAGES } from "@tuti/shared";

import type { EntryLanguage } from "@/components/changelog-languages";
import { articleVersionState, type VersionRow, type VersionState, versionState } from "@/lib/changelog-versions";

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
  const versions = () => prisma.changelogTranslation.findMany({ where: { entryId: entry.id }, select: rowSelect });
  return languagesOf(projectId, `/app/${slug}/changelog/${entry.number}`, translationSource({ ...entry, content: entry.content as Doc | null }).hash, versions, versionState);
}

/** An article's languages for its editor's pill (docs/plan.md L11), as an entry's: null for a draft or a sample. */
export async function articleLanguages(
  projectId: string,
  slug: string,
  article: { id: string; slug: string; title: string; description: string; keywords: string[]; body: string; content: unknown; publishedAt: Date | null; sample: boolean },
): Promise<EntryLanguage[] | null> {
  if (!article.publishedAt || article.sample) {
    return null;
  }
  const versions = () => prisma.articleTranslation.findMany({ where: { articleId: article.id }, select: rowSelect });
  return languagesOf(projectId, `/app/${slug}/docs/${article.slug}`, translationSource({ ...article, content: article.content as Doc | null }).hash, versions, articleVersionState);
}

const rowSelect = { language: true, automatic: true, publishedAt: true, sourceHash: true, error: true, behind: true, retranslate: true, retranslated: true } as const;

async function languagesOf(projectId: string, base: string, hash: string, versions: () => Promise<({ language: string } & VersionRow)[]>,
  stateOf: (row: VersionRow | undefined, hash: string, aiOn: boolean) => VersionState,
): Promise<EntryLanguage[] | null> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { language: true, languages: { select: { code: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  if (project.languages.length === 0) {
    return null;
  }
  const rows = await versions();
  const name = (code: string) => (isLanguage(code) ? LANGUAGES[code].native : code);
  return [
    { code: project.language, name: name(project.language), state: "default", href: base },
    ...project.languages.map(({ code }) => ({ code, name: name(code), state: stateOf(rows.find((version) => version.language === code), hash, aiEnabled()), href: `${base}?language=${code}` })),
  ];
}
