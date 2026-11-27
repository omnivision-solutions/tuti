import { type Doc, mediaIdsIn } from "@tuti/content";
import { prisma, type ChangelogTag, type Prisma } from "@tuti/db";
import { translationSource } from "@tuti/jobs";
import { languageLimit, liveLanguages } from "@tuti/shared";

import type { PublishedEntry } from "@/components/changelog-entry";
import type { Reader } from "@/lib/read-access";
import { REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";
import { visibleEntry } from "@/lib/reader-groups";

import { displayDoc } from "./content";
import { lastingImage } from "./media-urls";
import { portalLanguage } from "./portal-base";

/** Reads for the changelog pages: the team's editor and the portal. */

/**
 * The language a portal page asks entries in (docs/plan.md L17), where it isn't the default's: its address's ("/de/…").
 * Null at the default language's addresses, or off the portal.
 */
export async function entryLanguageAsked(): Promise<string | null> {
  const { language, defaultLanguage } = await portalLanguage().catch(() => ({ language: null, defaultLanguage: null }));
  return language && defaultLanguage && language !== defaultLanguage ? language : null;
}

type EntryText = { id: string; title: string; body: string; content: Prisma.JsonValue };
const versionShown = { entryId: true, language: true, title: true, body: true, content: true } as const;
export type ShownEntryVersion = Prisma.ChangelogTranslationGetPayload<{ select: typeof versionShown }>;

/**
 * The current versions of `entries` in `languages`, by entry (docs/plan.md, "A page not yet translated", as articles'
 * isCurrent): published, and, kept up to date, made from the entry as it is now. One whose entry changed but couldn't be
 * translated again yet is as good as none, never its old text; one the team writes counts once it's published.
 */
export async function currentEntryVersions(entries: EntryText[], languages: string[]): Promise<Map<string, ShownEntryVersion[]>> {
  const out = new Map<string, ShownEntryVersion[]>();
  if (entries.length === 0 || languages.length === 0) {
    return out;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const versions = await prisma.changelogTranslation.findMany({
    where: { entryId: { in: [...byId.keys()] }, language: { in: languages }, publishedAt: { not: null } },
    select: { ...versionShown, automatic: true, sourceHash: true },
  });
  for (const { automatic, sourceHash, ...version } of versions.sort((a, b) => languages.indexOf(a.language) - languages.indexOf(b.language))) {
    const entry = byId.get(version.entryId)!;
    if (!automatic || sourceHash === translationSource({ ...entry, content: entry.content as Doc | null }).hash) {
      out.set(version.entryId, [...(out.get(version.entryId) ?? []), version]);
    }
  }
  return out;
}

/** A project's live languages besides its default: the ones an entry's page can be in. */
async function liveOthers(projectSlug: string) {
  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: { plan: true, language: true, languages: { select: { code: true, live: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  return project ? liveLanguages(project.languages, languageLimit(project.plan)).filter((code) => code !== project.language) : [];
}

/**
 * Where entry `number` reads in each language it's in (portalPageMetadata's `addresses`): the default language's, and each
 * live language it has a current version in (its canonical and `hreflang` follow them). Empty for none.
 */
export async function entryAddresses(projectSlug: string, entry: EntryText & { number: number; projectLanguage: string }): Promise<Record<string, string>> {
  const path = `/changelog/${entry.number}`;
  const versions = (await currentEntryVersions([entry], await liveOthers(projectSlug))).get(entry.id) ?? [];
  return Object.fromEntries([[entry.projectLanguage, path], ...versions.map((version) => [version.language, path])]);
}

/** Each of `entries` in `language` where it has a current version there; `lang`: the language its text is in then. */
async function inLanguage<T extends EntryText>(entries: T[], language: string | null | undefined): Promise<(T & { lang?: string; untranslated?: true })[]> {
  if (!language) {
    return entries;
  }
  const versions = await currentEntryVersions(entries, [language]);
  return entries.map((entry) => {
    const version = versions.get(entry.id)?.[0];
    return version ? { ...entry, title: version.title, body: version.body, content: version.content, lang: version.language } : { ...entry, untranslated: true };
  });
}

/** How many of each reaction these entries have, by entry id (`db`: a transaction's client, inside one). */
export async function reactionCounts(
  entryIds: string[],
  db: Pick<typeof prisma, "changelogReaction"> = prisma,
): Promise<(entryId: string) => ReactionCounts> {
  const groups = await db.changelogReaction.groupBy({
    by: ["entryId", "kind"],
    where: { entryId: { in: entryIds } },
    _count: { _all: true },
  });
  return (entryId) =>
    Object.fromEntries(
      REACTIONS.map((reaction) => [
        reaction,
        groups.find((g) => g.entryId === entryId && g.kind.toLowerCase() === reaction)?._count._all ?? 0,
      ]),
    ) as ReactionCounts;
}

/** The posts an entry lists, for its editor: not merged ones (saving can't list them; their votes moved to the post they were merged into). */
export function entryPosts(projectId: string, listed: number[]) {
  return prisma.post.findMany({
    where: { projectId, number: { in: listed }, duplicateOfId: null },
    select: { id: true, number: true, title: true, status: true, voteCount: true },
  });
}

/**
 * How many people publishing an entry told: those who asked (its posts' shipped emails reached), and the other
 * subscribers it was emailed to (each address once, counted as one who asked if both), or null when publishing
 * completed none of its posts (sample ones don't count, or did before that was recorded) and didn't email subscribers.
 */
export async function entryTold(entryId: string): Promise<{ asked: number; subscribers: number } | null> {
  const [events, entry] = await Promise.all([
    prisma.postEvent.count({ where: { changelogEntryId: entryId, post: { sample: false } } }),
    prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId }, select: { projectId: true, subscribersEmailedAt: true } }),
  ]);
  if (events === 0 && !entry.subscribersEmailedAt) {
    return null;
  }
  const [people, subscribers] = await Promise.all([
    prisma.shippedEmail.findMany({
      where: { sentAt: { not: null }, event: { changelogEntryId: entryId } },
      distinct: ["userId"],
      select: { user: { select: { email: true, ssoIdentity: { select: { projectId: true, email: true } } } } },
    }),
    prisma.changelogEmail.findMany({ where: { entryId, sentAt: { not: null } }, select: { subscriber: { select: { email: true } } } }),
  ]);
  // A shipped email went where postAudience sends it: the address the project's SSO gives them, else their account's.
  const shippedTo = people.map(({ user }) =>
    (user.ssoIdentity?.projectId === entry.projectId && user.ssoIdentity.email ? user.ssoIdentity.email : user.email).toLowerCase(),
  );
  const asked = new Set(shippedTo);
  const others = new Set(subscribers.map((s) => s.subscriber.email).filter((email) => !asked.has(email)));
  return { asked: asked.size, subscribers: others.size };
}

/**
 * The draft whose release notes wait to be written: the one the newest GitHub release closed, while it's
 * unpublished ("Next release is ready to write"); else the running draft, once merged pull requests are in it
 * (`collecting`: still gathering them). Null for none.
 */
export async function draftToWrite(projectId: string) {
  const select = { number: true, title: true, collecting: true, _count: { select: { pullRequests: true } } } as const;
  return (
    (await prisma.changelogEntry.findFirst({
      where: { projectId, publishedAt: null, releasedAt: { not: null }, pullRequests: { some: {} } },
      orderBy: [{ releasedAt: "desc" }, { number: "desc" }],
      select,
    })) ?? (await prisma.changelogEntry.findFirst({ where: { projectId, collecting: true, pullRequests: { some: {} } }, select }))
  );
}

/** The newest published changelog entries `reader` may read, by date (the header's menu on phones lists them): just enough to name and link them. */
export async function changelogContents(projectSlug: string, reader: Reader, { take = 30, language }: { take?: number; language?: string | null } = {}) {
  const entries = await prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null }, ...visibleEntry(reader) },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    take,
    select: { id: true, number: true, title: true, body: true, content: true, publishedAt: true },
  });
  // In `language` where translated there (docs/plan.md L17).
  return (await inLanguage(entries, language)).map(({ number, title, publishedAt, lang }) => ({ number, title, publishedAt, lang }));
}

/**
 * Every published entry's date and tags that `reader` may read, newest first: the portal's changelog makes its tag chips and month index from them.
 * ponytail: the whole history, a few bytes an entry; count by month in SQL if one ever has many thousands.
 */
export function changelogDates(projectSlug: string, reader: Reader) {
  return prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null }, ...visibleEntry(reader) },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    select: { number: true, tags: true, publishedAt: true },
  });
}

/**
 * A project's published changelog entries that `reader` may read (visibleEntry), newest first (or one of them, with `number`, or some, with `numbers`; or those with `tag`), `take`
 * from `skip`, with their reactions (and which ones `userId` left).
 */
export async function publishedEntries(
  projectSlug: string,
  reader: Reader,
  // `withSample: false` leaves out sample content (server/sample-content.ts) before `take`: the RSS feed.
  {
    number,
    numbers,
    tag,
    take = 50,
    skip = 0,
    userId,
    withSample = true,
    language,
  }: {
    number?: number;
    numbers?: number[];
    tag?: ChangelogTag;
    take?: number;
    skip?: number;
    userId?: string;
    withSample?: boolean;
    /** In this language where an entry has a current version there (docs/plan.md L17); else the default language's, `untranslated`. */
    language?: string | null;
  } = {},
) {
  const read = await prisma.changelogEntry.findMany({
    where: {
      project: { slug: projectSlug },
      publishedAt: { not: null },
      // Both, if both are given.
      AND: [...(number !== undefined ? [{ number }] : []), ...(numbers ? [{ number: { in: numbers } }] : [])],
      ...(tag && { tags: { has: tag } }),
      ...(!withSample && { sample: false }),
      ...visibleEntry(reader),
    },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    skip,
    take,
    select: {
      id: true,
      number: true,
      title: true,
      tags: true,
      publishedAt: true,
      sample: true,
      body: true,
      content: true,
      cover: { select: { id: true, status: true, width: true, height: true } },
      // Public posts only, whoever reads it (post-visibility.ts): an announcement is for everyone.
      posts: {
        where: { post: { duplicateOfId: null, visibility: "PUBLIC", board: { off: false } } },
        select: { post: { select: { number: true, title: true, voteCount: true, sample: true, board: { select: { slug: true } } } } },
      },
    },
  });
  const entries = await inLanguage(read, language);
  const ids = entries.map((e) => e.id);
  const [counts, mine] = await Promise.all([
    reactionCounts(ids),
    userId ? prisma.changelogReaction.findMany({ where: { entryId: { in: ids }, userId }, select: { entryId: true, kind: true } }) : [],
  ]);
  return entries.map(
    (e): PublishedEntry => ({
      id: e.id,
      number: e.number,
      title: e.title,
      tags: e.tags,
      publishedAt: e.publishedAt!,
      doc: displayDoc(e),
      cover:
        e.cover?.status === "READY" && e.cover.width && e.cover.height
          ? { type: "doc", content: [{ type: "image", attrs: { mediaId: e.cover.id, w: e.cover.width, h: e.cover.height, alt: e.title } }] }
          : null,
      // A real entry's real posts only (and a sample entry's sample ones): sample content never mixes with the team's.
      posts: e.posts.filter(({ post }) => post.sample === e.sample).map(({ post }) => ({ number: post.number, title: post.title, voteCount: post.voteCount, board: post.board })),
      reactions: counts(e.id),
      reacted: mine.filter((r) => r.entryId === e.id).map((r) => r.kind.toLowerCase() as Reaction),
      sample: e.sample,
      ...(e.lang && { lang: e.lang }),
      ...(e.untranslated && { untranslated: true }),
    }),
  );
}

/** The images Generate offers to work from: the entry's text's (in its order) and the project's brand logo. */
export async function generatorSources(projectId: string, content: Doc) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { brandLogoId: true } });
  const ids = mediaIdsIn(content);
  const found = await prisma.media.findMany({
    where: { id: { in: [...ids, ...(project.brandLogoId ? [project.brandLogoId] : [])] }, projectId, status: "READY", filename: null, width: { not: null } },
    select: { id: true, status: true, width: true, height: true },
  });
  const image = (id: string | null) => {
    const shown = lastingImage(found.find((media) => media.id === id) ?? null);
    return shown && { id: shown.id, url: shown.url };
  };
  return { bodyImages: ids.map(image).filter((each) => each !== null), logo: image(project.brandLogoId) };
}
