import { type Doc, toPlainText } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import {
  behindOf,
  docOfSections,
  type Draft,
  editedSections,
  metaOf,
  otherReasons,
  queueVersion,
  versionPublished,
  type Section,
  sourceSections,
  translationSource,
  versionSections,
} from "@tuti/jobs";
import { contentHash, LANGUAGE_CODES, LANGUAGES, MAX_ARTICLE_LENGTH } from "@tuti/shared";
import { z } from "zod";

import { displayDoc, readContent } from "../content";
import { defineOperation, OperationError } from "./define";
import { MAX_ARTICLE_TITLE, teamArticle } from "./docs";

/**
 * An article's version in another language for the team's editor (docs/plan.md, Languages: "Retranslating and unpublished
 * changes"; the editor itself is L11): read it, save a draft, publish the draft (taking the new translation in sections whose
 * source changed since the team edited them, or keeping the edit), and Update those sections.
 */

const articleSlug = z.string().trim().min(1).max(80).describe("The article's slug: the end of its address, /docs/<slug>").meta({ examples: ["billing"] });
const language = z.enum(LANGUAGE_CODES).describe("The language's code").meta({ examples: ["de"] });
const section = z.string().min(1).max(400).describe("A section, as `behind` names it");
const docExample = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mit Karte zahlen." }] }] };

const behindOutput = z
  .array(
    z.object({
      section: section.meta({ examples: ["Billing\u001f0"] }),
      reason: z.string().describe("Why it's behind").meta({ examples: ["English changed in this section since it was edited."] }),
    }),
  )
  .describe("Sections behind the source, and why")
  .meta({ examples: [[{ section: "Billing\u001f0", reason: "English changed in this section since it was edited." }]] });

const translationOutput = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    slug: z.string().nullable().describe("Its slug in that language (null until it's first translated)").meta({ examples: ["abrechnung"] }),
    keepUpToDate: z.boolean().describe("Publishing the source again retranslates it, but in the sections the team kept its edits").meta({ examples: [true] }),
    title: z.string().describe("Its title, as published").meta({ examples: ["Abrechnung"] }),
    content: z.record(z.string(), z.unknown()).describe("Its text as published: the editor's JSON document").meta({ examples: [docExample] }),
    publishedAt: z.iso.datetime().nullable().describe("When it was first published (null: not translated yet)").meta({ examples: ["2026-11-26T09:00:00.000Z"] }),
    version: z.string().describe("What it says now, for articles.saveTranslation's `version`: a save made from an older read is refused").meta({ examples: ["5f2c9a…"] }),
    behind: behindOutput,
    draft: z
      .object({
        title: z.string().describe("The draft's title").meta({ examples: ["Abrechnung"] }),
        content: z.record(z.string(), z.unknown()).describe("The draft's text").meta({ examples: [docExample] }),
        behind: z
          .array(section)
          .describe("Sections the team edited whose source changed since: publishing asks to take the new translation or keep the edit (`keep`)")
          .meta({ examples: [["Billing\u001f0"]] }),
      })
      .nullable()
      .describe("Unpublished changes, or null")
      .meta({ examples: [{ title: "Abrechnung", content: docExample, behind: ["Billing\u001f0"] }] }),
  })
  .describe("An article's version in another language");

const versionSelect = {
  id: true,
  language: true,
  slug: true,
  automatic: true,
  title: true,
  content: true,
  body: true,
  publishedAt: true,
  sections: true,
  removedSections: true,
  draft: true,
  behind: true,
  updateSections: true,
} as const;
type Version = Prisma.ArticleTranslationGetPayload<{ select: typeof versionSelect }>;

/** The published source's sections and its language, for lining a version up with it. */
async function sourceOf(db: Prisma.TransactionClient, articleId: string) {
  const article = await db.article.findUniqueOrThrow({
    where: { id: articleId },
    select: { title: true, description: true, keywords: true, body: true, content: true, publishedAt: true, project: { select: { language: true } } },
  });
  if (!article.publishedAt) {
    throw new OperationError(409, "not_published", "Publish the article first: its other languages are made from what's published");
  }
  const source = translationSource(article);
  return { parts: sourceSections(source.text), sourceLanguage: article.project.language, titleHash: contentHash(article.title), sourceHash: source.hash };
}

/** A version's sections: published, and in the draft. The team's own on a version not kept up to date (for what's behind). */
function versionParts(version: Version, parts: ReturnType<typeof sourceSections>) {
  const published = versionSections(version.content as Doc | null, version.sections, parts);
  const draft = version.draft as Draft | null;
  const drafted = draft && versionSections(draft.content, draft.sections, parts);
  return { published, draft, drafted };
}

/**
 * `behind` worked out again for the published text and the draft (`draft`: its sections, and the ones the team took out of
 * it): the source changing for sections the team owns, the source's sections a version the team writes lacks, the other
 * reasons as they were.
 */
function behindNow(version: Version, parts: ReturnType<typeof sourceSections>, sourceLanguage: string, published: Section[], draft?: { list: Section[]; removed?: string[] } | null) {
  const teamWrites = !version.automatic;
  // A version the team writes and never published has no text yet to lack any section: only its draft counts (as in the job).
  const draftOnly = teamWrites && !version.publishedAt;
  const lists = [...(draftOnly ? [] : [{ list: published, teamWrites, removed: version.removedSections as string[] }]), ...(draft ? [{ ...draft, teamWrites }] : [])];
  return behindOf(sourceLanguage, parts, lists, otherReasons(version.behind, sourceLanguage));
}

/**
 * What a version says now (title, text and draft) and the source it's compared with (`sourceHash`): a save is made against
 * both, so one from a read taken before the source changed is refused (it would mark a section up to date with source text
 * its editor never saw).
 */
const versionToken = (version: Version, sourceHash: string) => contentHash(JSON.stringify([version.title, version.content, version.draft, sourceHash]));

function output(version: Version, { parts, sourceLanguage, sourceHash }: { parts: ReturnType<typeof sourceSections>; sourceLanguage: string; sourceHash: string }): z.output<typeof translationOutput> {
  const { published, draft, drafted } = versionParts(version, parts);
  // Never published, a version the team writes is its draft: what's behind is the draft's.
  const behind = behindNow(version, parts, sourceLanguage, published, !version.automatic && !version.publishedAt && drafted ? { list: drafted, removed: draft?.removed } : null);
  const draftBehind = drafted ? Object.keys(behindOf(sourceLanguage, parts, [{ list: drafted, teamWrites: !version.automatic, removed: draft?.removed }])) : [];
  return {
    language: version.language,
    slug: version.slug,
    keepUpToDate: version.automatic,
    title: version.title,
    content: displayDoc(version) as Record<string, unknown>,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    version: versionToken(version, sourceHash),
    behind: Object.entries(behind).map(([key, reason]) => ({ section: key, reason })),
    draft: draft && { title: draft.title, content: draft.content as Record<string, unknown>, behind: draftBehind },
  };
}

/**
 * Runs `change` on an article's version in `language`, both locked in that order (as the translate job locks them), so a
 * translation written meanwhile is never lost and never loses the team's change. `read`: only reading, nothing locked (a
 * save made from it is checked by its `version`).
 */
async function withVersion<T>(
  projectId: string,
  slug: string,
  lang: (typeof LANGUAGE_CODES)[number],
  change: (tx: Prisma.TransactionClient, version: Version, articleId: string) => Promise<T>,
  { read = false } = {},
) {
  const article = await teamArticle(projectId, slug);
  if (read) {
    const version = await prisma.articleTranslation.findUnique({ where: { articleId_language: { articleId: article.id, language: lang } }, select: versionSelect });
    if (!version) {
      throw new OperationError(404, "not_found", `The article has no version in ${LANGUAGES[lang].name}`);
    }
    return change(prisma, version, article.id);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${article.id} FOR UPDATE`;
    const found = await tx.articleTranslation.findUnique({ where: { articleId_language: { articleId: article.id, language: lang } }, select: { id: true } });
    if (!found) {
      throw new OperationError(404, "not_found", `The article has no version in ${LANGUAGES[lang].name}`);
    }
    await tx.$queryRaw`SELECT 1 FROM article_translation WHERE id = ${found.id} FOR UPDATE`;
    const version = await tx.articleTranslation.findUniqueOrThrow({ where: { id: found.id }, select: versionSelect });
    return change(tx, version, article.id);
  });
}

export const getTranslation = defineOperation({
  name: "articles.getTranslation",
  title: "Get an article's translation",
  summary: "An article's version in one of the project's other languages, for its editor: as published, its unpublished changes, and the sections behind the source.",
  method: "GET",
  path: "/articles/{slug}/languages/{language}",
  scope: "read",
  access: "team",
  // The English article unpublished since (not_published, from sourceOf).
  errors: [409],
  input: z.object({ slug: articleSlug, language }),
  output: translationOutput,
  run: async ({ projectId }, input) =>
    withVersion(projectId, input.slug, input.language, async (db, version, articleId) => output(version, await sourceOf(db, articleId)), { read: true }),
});

export const saveTranslation = defineOperation({
  name: "articles.saveTranslation",
  title: "Save a translation's draft",
  summary:
    "Save unpublished changes to an article's version in another language. The sections you change are yours: retranslating writes the rest, and marks yours behind when the source changes there.",
  method: "PATCH",
  path: "/articles/{slug}/languages/{language}/draft",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: articleSlug,
    language,
    title: z.string().trim().min(1).max(MAX_ARTICLE_TITLE).optional().describe("Its title (left out: as it is)").meta({ examples: ["Abrechnung"] }),
    version: z
      .string()
      .min(1)
      .max(200)
      .describe("The `version` of the read this edit was made from: refused (409 `changed`) if it has changed since (retranslated, or saved by someone else)")
      .meta({ examples: ["5f2c9a…"] }),
    content: z.unknown().describe("Its text: the editor's JSON document (the article profile)").meta({ examples: [docExample] }),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    const text = await readContent("article", { content: input.content }, { projectId, maxLength: MAX_ARTICLE_LENGTH });
    if (text.error !== undefined) {
      throw new OperationError(400, "invalid_content", text.error);
    }
    return withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage } = source;
      // Compared with what it was made from, not with what's there now: an older copy would undo a newer translation.
      if (versionToken(version, source.sourceHash) !== input.version) {
        throw new OperationError(409, "changed", "It changed since you opened it (translated again, or saved by someone else). Reload it to see the changes.");
      }
      const { published, draft, drafted } = versionParts(version, parts);
      const { sections: edited, removed } = editedSections(drafted ?? published, text.doc, parts, { automatic: version.automatic });
      // The source's sections the team took out, this time and before (but one it has again).
      const has = new Set(edited.map(({ meta }) => meta.key));
      const out = [...new Set([...(draft?.removed ?? (version.removedSections as string[])), ...removed])].filter((key) => !has.has(key));
      const title = input.title ?? draft?.title ?? version.title;
      const next: Draft = { title, titleEdited: (draft?.titleEdited ?? false) || title !== (draft?.title ?? version.title), content: docOfSections(edited), sections: metaOf(edited), removed: out };
      // A section edited now is the team's again: an update asked for it earlier no longer overrides it.
      const base = new Set(drafted ?? published);
      const editedNow = new Set(edited.filter((section) => !base.has(section) && section.meta.key !== null).map((section) => section.meta.key!));
      const saved = await tx.articleTranslation.update({
        where: { id: version.id },
        data: {
          draft: next as Prisma.InputJsonValue,
          behind: behindNow(version, parts, sourceLanguage, published, { list: edited, removed: out }),
          // (Taken out now too: an update asked for it would put it back.)
          updateSections: (version.updateSections as string[]).filter((key) => !editedNow.has(key) && !removed.includes(key)),
        },
        select: versionSelect,
      });
      return output(saved, source);
    });
  },
});

export const publishTranslation = defineOperation({
  name: "articles.publishTranslation",
  title: "Publish a translation",
  summary:
    "Publish the unpublished changes to an article's version in another language. Sections you edited whose source changed since take the new translation, unless listed in `keep`: kept, they stay yours and stay behind the source.",
  method: "POST",
  path: "/articles/{slug}/languages/{language}/publish",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: articleSlug,
    language,
    keep: z.array(section).max(500).optional().describe("Sections behind the source (the draft's `behind`) whose edit to keep; the rest take the new translation"),
    version: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional: the `version` of the read you reviewed. It publishes only if it's still that (else 409 `changed`), so `keep` applies to the sections you saw. Left out, there's no check")
      .meta({ examples: ["5f2c9a…"] }),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    let retranslate: { articleId: string; language: string } | null = null;
    let wentLive: { id: string; first: boolean } | null = null;
    const result = await withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage, titleHash } = source;
      // Only the draft that was reviewed: one saved or retranslated since would go live unseen, `keep` meant for other sections.
      if (input.version !== undefined && versionToken(version, source.sourceHash) !== input.version) {
        throw new OperationError(409, "changed", "It changed since you opened it (translated again, or saved by someone else). Reload it to see the changes.");
      }
      const { published, draft, drafted } = versionParts(version, parts);
      if (!draft || !drafted) {
        throw new OperationError(409, "no_changes", "There are no unpublished changes to publish");
      }
      // A version never translated has no title yet: published, it would have none.
      if (!draft.title.trim()) {
        throw new OperationError(409, "no_title", "Give it a title first");
      }
      const keep = new Set(input.keep);
      const hashes = new Map(parts.map((part) => [part.key, part.hash]));
      const fresh = new Map(published.filter(({ meta }) => meta.key !== null && !meta.own && meta.hash === hashes.get(meta.key)).map((part) => [part.meta.key!, part]));
      // Sections the team edited whose source changed since: the new translation (the published one, if it's current;
      // else translated again after this), or, kept, the team's, behind the source until it's updated.
      const update: string[] = [];
      const out = drafted.map((part): Section => {
        const { key } = part.meta;
        // On a version the team writes, every section is theirs: each behind is theirs to update or keep.
        // Kept: the team's, even where an update asked earlier had made it no longer theirs.
        const own = part.meta.own || !version.automatic || keep.has(key ?? "");
        if (!own || key === null) return part;
        const stale = hashes.get(key) !== part.meta.hash;
        if (stale && !keep.has(key)) {
          const translated = fresh.get(key);
          if (translated) return translated;
          update.push(key);
          return { blocks: part.blocks, meta: { key, hash: part.meta.hash } };
        }
        // Kept: the team's for good, behind until Update those sections. Otherwise the team's until its source changes (on a
        // version kept up to date, publishing the source again replaces edits only in the sections it touches).
        return stale ? { blocks: part.blocks, meta: { ...part.meta, own: true, kept: true } } : part;
      });
      const content = docOfSections(out);
      const saved = await tx.articleTranslation.update({
        where: { id: version.id },
        data: {
          title: draft.title,
          // The team's own title stays theirs until the source's title changes.
          ...(draft.titleEdited && { titleSource: titleHash }),
          content: content as Prisma.InputJsonValue,
          body: toPlainText(content),
          sections: metaOf(out) as Prisma.InputJsonValue,
          draft: Prisma.DbNull,
          publishedAt: version.publishedAt ?? new Date(),
          // Both counted on: a translate job running now writes nothing (its write checks `retranslate`), so none of the
          // previous release's, which doesn't know the team's sections, writes over them during a deploy; the gap that marks
          // a Retranslate is as it was. (A run of this release that misses is queued again below.)
          retranslate: { increment: 1 },
          retranslated: { increment: 1 },
          // The sections the team took out of the draft, out of the published text now too.
          removedSections: draft.removed ?? [],
          behind: behindOf(sourceLanguage, parts, [{ list: out, teamWrites: !version.automatic, removed: draft.removed }], otherReasons(version.behind, sourceLanguage)),
          // Kept now: an update asked for those earlier no longer overrides them. Those taking the new translation join it.
          updateSections: [...new Set([...(version.updateSections as string[]).filter((key) => !keep.has(key)), ...update])],
        },
        select: versionSelect,
      });
      // Its old search sections go with its old text: the new one's are embedded after (versionPublished).
      await tx.articleTranslationChunk.deleteMany({ where: { translationId: version.id } });
      wentLive = { id: version.id, first: version.publishedAt === null };
      // A run on its way now writes nothing (above): queued again wherever one may be (kept up to date, or sections asked for).
      // One with nothing to do ends at once.
      if (update.length > 0 || version.automatic || (version.updateSections as string[]).length > 0) retranslate = { articleId, language: input.language };
      return output(saved, { parts, sourceLanguage, sourceHash: source.sourceHash });
    });
    // Named on its first publish (its address there), then searchable in its language.
    // (Set in the transaction's callback, which TypeScript doesn't follow.)
    const live = wentLive as { id: string; first: boolean } | null;
    if (live) await versionPublished(projectId, live.id, live.first);
    if (retranslate) await queueTranslation(retranslate);
    return result;
  },
});

export const updateTranslationSections = defineOperation({
  name: "articles.updateTranslation",
  title: "Update translated sections",
  summary:
    "Update those sections: translate the sections of an article's version in another language again from the source (by default, every one behind it), in the background, replacing the team's edits there. Costs AI credits where they're on.",
  method: "POST",
  path: "/articles/{slug}/languages/{language}/update",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: articleSlug,
    language,
    sections: z.array(section).max(500).optional().describe("The sections to translate again (left out: every one behind the source, in the published text and the draft)"),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    let queued: { articleId: string; language: string } | null = null;
    const result = await withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage } = source;
      const { published, draft, drafted } = versionParts(version, parts);
      const behind = Object.keys(behindNow(version, parts, sourceLanguage, published, drafted && { list: drafted, removed: draft?.removed }));
      // Those still in the source, and those behind because theirs went (the job takes them out).
      const asked = (input.sections ?? behind).filter((key) => behind.includes(key) || parts.some((part) => part.key === key));
      if (asked.length === 0) {
        throw new OperationError(409, "nothing_behind", "No section is behind the source");
      }
      // No longer the team's: the job writes them.
      const unowned = (list: Section[]) => list.map((part) => (part.meta.key !== null && asked.includes(part.meta.key) ? { blocks: part.blocks, meta: { key: part.meta.key, hash: part.meta.hash } } : part));
      const saved = await tx.articleTranslation.update({
        where: { id: version.id },
        data: {
          sections: metaOf(unowned(published)) as Prisma.InputJsonValue,
          // Asked for, a section the team took out comes back.
          removedSections: (version.removedSections as string[]).filter((key) => !asked.includes(key)),
          ...(draft && drafted && { draft: { ...draft, sections: metaOf(unowned(drafted)), removed: (draft.removed ?? []).filter((key) => !asked.includes(key)) } as Prisma.InputJsonValue }),
          updateSections: [...new Set([...(version.updateSections as string[]), ...asked])],
        },
        select: versionSelect,
      });
      queued = { articleId, language: input.language };
      return output(saved, { parts, sourceLanguage, sourceHash: source.sourceHash });
    });
    if (queued) await queueTranslation(queued);
    return result;
  },
});

/** Queues the translate job for a version (with its safety net: queuing that fails is tried again by the retry job). */
const queueTranslation = ({ articleId, language }: { articleId: string; language: string }) => queueVersion(articleId, language);
