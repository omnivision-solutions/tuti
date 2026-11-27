import { type Doc, toPlainText } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import {
  behindOf,
  docOfSections,
  type Draft,
  editedSections,
  metaOf,
  ownedByTeam,
  lostAfterMs,
  otherReasons,
  PRODUCT_SETTING_CHANGED,
  queueVersion,
  removedChanged,
  standingIn,
  versionPublished,
  type Section,
  sourceSections,
  translationSource,
  versionSections,
} from "@tuti/jobs";
import { aiEnabled, contentHash, LANGUAGE_CODES, LANGUAGES, MAX_ARTICLE_LENGTH } from "@tuti/shared";
import { z } from "zod";

import { articleVersionState } from "@/lib/changelog-versions";

import { displayDoc, readContent } from "../content";
import { defineOperation, OperationError } from "./define";
import { MAX_ARTICLE_TITLE, teamArticle } from "./docs";

/**
 * An article's version in another language for the team's editor (docs/plan.md, Languages: "Retranslating and unpublished
 * changes"; the editor itself is L11): read it, save a draft, publish the draft (taking the new translation in sections whose
 * source changed since the team edited them, or keeping the edit), and Update those sections.
 */

/** A change made from an older read of a version is refused with this (409 `changed`). */
export const VERSION_CHANGED = "It changed since you opened it (translated again, or saved by someone else). Reload it to see the changes.";

const articleSlug = z.string().trim().min(1).max(80).describe("The article's slug: the end of its address, /docs/<slug>").meta({ examples: ["billing"] });
const language = z.enum(LANGUAGE_CODES).describe("The language's code").meta({ examples: ["de"] });
/**
 * A section, as `behind` names it: its heading, a separator and which one of that heading it is. A heading can be as long as
 * the text (only the article is capped), so the cap is the article's own, with room for the separator and the count: every
 * key `behind` gives is one `keep` and `sections` take.
 */
const section = z
  .string()
  .min(1)
  .max(MAX_ARTICLE_LENGTH + 16)
  .describe("A section, as `behind` names it");
/**
 * A list of sections (`keep`, `sections`): as many as an article can have, and no longer together than an article's text
 * (each key is its heading, which is part of that text), with room for each key's suffix.
 */
const sectionList = z
  .array(section)
  .max(500)
  .refine((list) => list.reduce((total, key) => total + key.length, 0) <= MAX_ARTICLE_LENGTH + 16 * list.length, "Those sections together are longer than an article can be");

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
  removedHashes: true,
  draft: true,
  behind: true,
  updateSections: true,
  tries: true,
  error: true,
  sourceHash: true,
  retranslate: true,
  retranslated: true,
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
function behindNow(
  version: Version,
  parts: ReturnType<typeof sourceSections>,
  sourceLanguage: string,
  published: Section[],
  draft?: { list: Section[]; removed?: string[]; removedHashes?: Record<string, string> } | null,
) {
  const teamWrites = !version.automatic;
  // A version the team writes and never published has no text yet to lack any section: only its draft counts (as in the job).
  const draftOnly = teamWrites && !version.publishedAt;
  // Kept up to date: a section the draft takes out whose English changed since is behind (the job puts it back published).
  const changed = draft && version.automatic ? removedChanged(draft.removed, draft.removedHashes, parts) : [];
  const lists = [...(draftOnly ? [] : [{ list: published, teamWrites, removed: version.removedSections as string[] }]), ...(draft ? [{ list: draft.list, removed: draft.removed, teamWrites, changed }] : [])];
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
  const draftBehind = drafted
    ? Object.keys(
        behindOf(sourceLanguage, parts, [
          { list: drafted, teamWrites: !version.automatic, removed: draft?.removed, changed: version.automatic ? removedChanged(draft?.removed, draft?.removedHashes, parts) : [] },
        ]),
      )
    : [];
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

/** A version not started yet, as its row starts (the database's defaults), so a read of it gives the token a save of it matches. */
const blankVersion = (language: string, automatic: boolean): Version => ({
  id: "",
  language,
  slug: null,
  automatic,
  title: "",
  content: null,
  body: "",
  publishedAt: null,
  sections: [],
  removedSections: [],
  removedHashes: {},
  draft: null,
  behind: {},
  updateSections: [],
  tries: 0,
  error: null,
  sourceHash: null,
  retranslate: 0,
  retranslated: 0,
});

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
  const where = { articleId_language: { articleId: article.id, language: lang } };
  // None yet (a Manual language's, until the team writes it): the project's language's, so it can be written.
  const setting = async (db: Prisma.TransactionClient) => {
    const found = await db.projectLanguage.findUnique({ where: { projectId_code: { projectId, code: lang } }, select: { automatic: true } });
    if (!found) {
      throw new OperationError(404, "not_found", `${LANGUAGES[lang].name} isn't one of the project's languages`);
    }
    return found;
  };
  if (read) {
    const version = await prisma.articleTranslation.findUnique({ where, select: versionSelect });
    return change(prisma, version ?? blankVersion(lang, (await setting(prisma)).automatic), article.id);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${article.id} FOR UPDATE`;
    let found = await tx.articleTranslation.findUnique({ where, select: { id: true } });
    // Started as the blank one a read answers (its token the same), and gone again if the change is refused or stores
    // nothing: an empty row would keep the language, once Automatic, from ever starting the article's version.
    let started: { automatic: boolean } | null = null;
    if (!found) {
      started = await setting(tx);
      await tx.articleTranslation.createMany({ data: [{ articleId: article.id, projectId, language: lang, automatic: started.automatic }], skipDuplicates: true });
      found = await tx.articleTranslation.findUniqueOrThrow({ where, select: { id: true } });
    }
    await tx.$queryRaw`SELECT 1 FROM article_translation WHERE id = ${found.id} FOR UPDATE`;
    const version = await tx.articleTranslation.findUniqueOrThrow({ where: { id: found.id }, select: versionSelect });
    const result = await change(tx, version, article.id);
    if (started) {
      const after = await tx.articleTranslation.findUniqueOrThrow({ where: { id: found.id }, select: { automatic: true, publishedAt: true, draft: true, updateSections: true } });
      if (!after.publishedAt && after.draft === null && (after.updateSections as string[]).length === 0 && after.automatic === started.automatic) {
        await tx.articleTranslation.delete({ where: { id: found.id } });
      }
    }
    return result;
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
  run: async ({ projectId }, input) => (await readArticleVersion(projectId, input.slug, input.language)).read,
});

/**
 * articles.getTranslation's read, and where the version stands from the same row (the editor's pill and its confirm
 * before Keep up to date replaces the team's text), so state, text and token never come from two reads.
 */
export async function readArticleVersion(projectId: string, slug: string, language: (typeof LANGUAGE_CODES)[number]) {
  return withVersion(
    projectId,
    slug,
    language,
    async (db, version, articleId) => {
      const source = await sourceOf(db, articleId);
      const read = output(version, source);
      // The published text's sections behind, and the draft's (a draft's edit English changed in since: the job keeps it,
      // as drafts never give way, and it stays behind until published or updated).
      const reasons = [...read.behind.map(({ reason }) => reason), ...(read.draft?.behind ?? []).map(() => "source")];
      const behind = reasons.length === 0 ? null : reasons.every((reason) => reason === PRODUCT_SETTING_CHANGED) ? "setting" : "source";
      // `waiting`: why it can't be translated (it's tried again), not in the operation's answer.
      return { read, state: articleVersionState(version.id ? version : undefined, source.sourceHash, aiEnabled(), behind), waiting: version.error };
    },
    { read: true },
  );
}

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
        throw new OperationError(409, "changed", VERSION_CHANGED);
      }
      const { published, draft, drafted } = versionParts(version, parts);
      const { sections: edited, removed } = editedSections(drafted ?? published, text.doc, parts, { automatic: version.automatic });
      // The source's sections the team took out, this time and before (but one it has again).
      const has = new Set(edited.map(({ meta }) => meta.key));
      const out = [...new Set([...(draft?.removed ?? (version.removedSections as string[])), ...removed])].filter((key) => !has.has(key));
      const title = input.title ?? draft?.title ?? version.title;
      // When each was taken out: its English then (one taken out before keeps its time), so it's known when that changes.
      const then = (draft?.removedHashes ?? (version.removedHashes as Record<string, string>)) as Record<string, string>;
      const nowHashes = new Map(parts.map((part) => [part.key, part.hash]));
      const removedHashes = Object.fromEntries(out.flatMap((key) => (then[key] ?? nowHashes.get(key)) !== undefined ? [[key, then[key] ?? nowHashes.get(key)!]] : []));
      const next: Draft = { title, titleEdited: (draft?.titleEdited ?? false) || title !== (draft?.title ?? version.title), content: docOfSections(edited), sections: metaOf(edited), removed: out, removedHashes };
      // A section edited now is the team's again: an update asked for it earlier no longer overrides it.
      const base = new Set(drafted ?? published);
      const editedNow = new Set(edited.filter((section) => !base.has(section) && section.meta.key !== null).map((section) => section.meta.key!));
      const saved = await tx.articleTranslation.update({
        where: { id: version.id },
        data: {
          draft: next as Prisma.InputJsonValue,
          behind: behindNow(version, parts, sourceLanguage, published, { list: edited, removed: out, removedHashes }),
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
    keep: sectionList.optional().describe("Sections behind the source (the draft's `behind`) whose edit to keep; the rest take the new translation"),
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
    let wentLive: { id: string; first: boolean; marker: Date; tries: number } | null = null;
    // Its search data to write, recorded with the publish itself: a retry time, and a try (the retry job takes a version the team
    // writes only with one), cleared once it's embedded (versionPublished). Lost before that, the retry job embeds it.
    const marker = new Date(Date.now() + lostAfterMs());
    const result = await withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage, titleHash } = source;
      // Only the draft that was reviewed: one saved or retranslated since would go live unseen, `keep` meant for other sections.
      if (input.version !== undefined && versionToken(version, source.sourceHash) !== input.version) {
        throw new OperationError(409, "changed", VERSION_CHANGED);
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
          // (The team's paragraph standing in for the source's intro stays after its translation: standingIn.)
          if (translated) return standingIn(part, translated.blocks, translated.meta as { key: string; hash: string | null });
          update.push(key);
          return { blocks: part.blocks, meta: { key, hash: part.meta.hash, ...(part.meta.standIn !== undefined && { standIn: part.meta.standIn }) } };
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
          // Kept out (in `keep`) though English changed since: kept out against English as it is now, so the job leaves it out.
          removedHashes: Object.fromEntries(
            Object.entries(draft.removedHashes ?? {}).map(([key, hash]) => [key, keep.has(key) ? (hashes.get(key) ?? hash) : hash]),
          ) as Prisma.InputJsonValue,
          behind: behindOf(sourceLanguage, parts, [{ list: out, teamWrites: !version.automatic, removed: draft.removed }], otherReasons(version.behind, sourceLanguage)),
          retryAt: marker,
          tries: Math.max(version.tries, 1),
          // Kept now: an update asked for those earlier no longer overrides them. Those taking the new translation join it.
          updateSections: [...new Set([...(version.updateSections as string[]).filter((key) => !keep.has(key)), ...update])],
        },
        select: versionSelect,
      });
      // Its old search sections go with its old text: the new one's are embedded after (versionPublished).
      await tx.articleTranslationChunk.deleteMany({ where: { translationId: version.id } });
      wentLive = { id: version.id, first: version.publishedAt === null, marker, tries: version.tries };
      // A run on its way now writes nothing (above): queued again wherever one may be (kept up to date, or sections asked for).
      // One with nothing to do ends at once.
      if (update.length > 0 || version.automatic || (version.updateSections as string[]).length > 0) retranslate = { articleId, language: input.language };
      return output(saved, { parts, sourceLanguage, sourceHash: source.sourceHash });
    });
    // Named on its first publish (its address there), then searchable in its language.
    // (Set in the transaction's callback, which TypeScript doesn't follow.)
    const live = wentLive as { id: string; first: boolean; marker: Date; tries: number } | null;
    if (live) await versionPublished(projectId, live.id, live.first, live.marker, live.tries);
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
    sections: sectionList.optional().describe("The sections to translate again (left out: every one behind the source, in the published text and the draft)"),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    let queued: { articleId: string; language: string } | null = null;
    const result = await withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage } = source;
      const { published, draft, drafted } = versionParts(version, parts);
      // No text yet (never written or translated): no section to place a translation in.
      if (!version.publishedAt && !draft) {
        throw new OperationError(409, "nothing_behind", "No section is behind the source");
      }
      const behind = Object.keys(behindNow(version, parts, sourceLanguage, published, drafted && { list: drafted, removed: draft?.removed, removedHashes: draft?.removedHashes }));
      // Those still in the source, and those behind because theirs went (the job takes them out).
      const asked = (input.sections ?? behind).filter((key) => behind.includes(key) || parts.some((part) => part.key === key));
      if (asked.length === 0) {
        throw new OperationError(409, "nothing_behind", "No section is behind the source");
      }
      // No longer the team's: the job writes them.
      const unowned = (list: Section[]) =>
        list.map((part) =>
          part.meta.key !== null && asked.includes(part.meta.key)
            ? // Still standing in for the source's intro: the update puts the intro's translation before the team's paragraph.
              { blocks: part.blocks, meta: { key: part.meta.key, hash: part.meta.hash, ...(part.meta.standIn !== undefined && { standIn: part.meta.standIn }) } }
            : part,
        );
      const saved = await tx.articleTranslation.update({
        where: { id: version.id },
        data: {
          sections: metaOf(unowned(published)) as Prisma.InputJsonValue,
          // Asked for, a section the team took out comes back.
          removedSections: (version.removedSections as string[]).filter((key) => !asked.includes(key)),
          removedHashes: Object.fromEntries(Object.entries(version.removedHashes as Record<string, string>).filter(([key]) => !asked.includes(key))) as Prisma.InputJsonValue,
          ...(draft &&
            drafted && {
              draft: {
                ...draft,
                sections: metaOf(unowned(drafted)),
                removed: (draft.removed ?? []).filter((key) => !asked.includes(key)),
                // Its time taken out goes with it: taken out again later, it's against English as it is then.
                removedHashes: Object.fromEntries(Object.entries(draft.removedHashes ?? {}).filter(([key]) => !asked.includes(key))),
              } as Prisma.InputJsonValue,
            }),
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

/**
 * The team's sections on a version turned back to Keep up to date: their edits, giving way where English changes, those
 * kept on publishing too (`kept` would keep them for good, and the switch says they take a new translation).
 */
const givingWay = (list: Section[]): Section[] =>
  ownedByTeam(list).map((section) => {
    const meta = { ...section.meta };
    delete meta.kept;
    return { ...section, meta };
  });

export const keepTranslationUpToDate = defineOperation({
  name: "articles.keepTranslationUpToDate",
  title: "Keep a translation up to date",
  summary:
    "Turn Keep up to date on for an article's version in another language (it's translated again; the team's sections stay theirs until English changes in them) or off (the team writes it).",
  method: "POST",
  path: "/articles/{slug}/languages/{language}/keep-up-to-date",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: articleSlug,
    language,
    keepUpToDate: z.boolean().describe("On: translated again, now and whenever English changes. Off: the team writes it").meta({ examples: [true] }),
    version: z
      .string()
      .min(1)
      .max(200)
      .describe("The `version` of the read it was turned from: refused (409 `changed`) if it changed since, so a teammate's newer text isn't handed to the translator unseen")
      .meta({ examples: ["5f2c9a…"] }),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    let queued: { articleId: string; language: string } | null = null;
    const result = await withVersion(projectId, input.slug, input.language, async (tx, version, articleId) => {
      const source = await sourceOf(tx, articleId);
      const { parts, sourceLanguage } = source;
      if (versionToken(version, source.sourceHash) !== input.version) {
        throw new OperationError(409, "changed", VERSION_CHANGED);
      }
      if (version.automatic === input.keepUpToDate) {
        return output(version, source);
      }
      const { published, draft, drafted } = versionParts(version, parts);
      // On: the team's sections are their edits now, as on any version kept up to date (theirs until English changes in
      // them); translated again, nothing reused. Off: the team writes every section.
      const data = input.keepUpToDate
        ? {
            automatic: true,
            sections: metaOf(givingWay(published)) as Prisma.InputJsonValue,
            ...(draft && drafted && { draft: { ...draft, sections: metaOf(givingWay(drafted)) } as Prisma.InputJsonValue }),
            retranslate: { increment: 1 },
          }
        : { automatic: false };
      const saved = await tx.articleTranslation.update({ where: { id: version.id }, data, select: versionSelect });
      if (input.keepUpToDate) queued = { articleId, language: input.language };
      return output(saved, { parts, sourceLanguage, sourceHash: source.sourceHash });
    });
    if (queued) await queueTranslation(queued);
    return result;
  },
});
