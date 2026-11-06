import { htmlToContent, type HtmlContent } from "@tuti/content/html";
import { type ChangelogTag, prisma } from "@tuti/db";

import type { FeaturebaseChangelog } from "./featurebase";
import { MEDIA_LEFT_OUT } from "./import-docs";
import { mediaImporter } from "./import-media";
import { ALREADY_HERE, type ImportJob, type StepPage, tally } from "./imports";

/**
 * The changelog from Featurebase (docs/plan.md, Switching from Featurebase): the entries everyone may see, in date order
 * (numbered so), published at their dates and drafts as drafts, with their content and images, cover and categories as
 * tags. Written straight to the database as sample content is, so nothing is announced, emailed or sent to webhooks; one
 * Featurebase emailed to its subscribers is marked emailed here, so publishing it again never emails it twice. Tuti's
 * changelog has no comments: theirs are counted.
 */

/**
 * A page's limits, well within import-step's 5 minutes: `entries` at most (each may have several images to copy, each
 * fetch taking 30 seconds at most); past `hardMs` from its start, its remaining images are left out, as ones that
 * couldn't be fetched. Tests shorten them.
 */
export const CHANGELOG_PAGE = { entries: 10, hardMs: 210_000 };

/** The changelog's images, files and videos, counted apart from feedback's and the help center's, so each part says its own. */
const CHANGELOG_MEDIA = { image: "changelogImages", file: "changelogFiles", video: "changelogVideos" } as const;

/** Featurebase's categories as Tuti's tags, by their words ("New", "Improved", "Fixed"); others have none. */
const TAGS: [RegExp, ChangelogTag][] = [
  [/break/i, "BREAKING"],
  [/fix|bug/i, "FIXED"],
  [/improv|enhanc|update/i, "IMPROVED"],
  [/new|feature|add|launch/i, "NEW"],
];
const tagsOf = ({ categories }: FeaturebaseChangelog) => [...new Set((categories ?? []).flatMap(({ name }) => TAGS.find(([words]) => words.test(name))?.[1] ?? []))];

/** Seen by only some people in Featurebase (segments, or a category some roles see): left out, counted. */
const restricted = (entry: FeaturebaseChangelog) => Boolean(entry.allowedSegmentIds?.length || entry.categories?.some((category) => category.roles?.length));

const dateOf = (value: string | null | undefined) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);

export async function changelogPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const begun = Date.now();
  const { items, next } = await job.featurebase.page<FeaturebaseChangelog>("/changelogs", cursor, { state: "all", sortOrder: "asc", limit: CHANGELOG_PAGE.entries });
  const recorded = async () =>
    new Set(
      (await prisma.importedRecord.findMany({ where: { projectId: job.projectId, source: job.source, kind: "changelog", externalId: { in: items.map((entry) => entry.id) } }, select: { externalId: true } })).map(
        (record) => record.externalId,
      ),
    );
  const known = await recorded();
  const copy = job.startedById ? mediaImporter({ projectId: job.projectId, uploaderId: job.startedById }) : undefined;
  const media: typeof copy = copy && (async (source) => (Date.now() - begun > CHANGELOG_PAGE.hardMs ? { leftOut: "unreachable" } : copy(source)));
  // Images copied first, outside the page's transaction and lock.
  const copied = new Map<string, { content: HtmlContent | { error: string }; cover: Awaited<ReturnType<NonNullable<typeof media>>> | null }>();
  for (const entry of items) {
    if (!known.has(entry.id) && !restricted(entry)) {
      const content = await htmlToContent("changelog", entry.content ?? "", { media });
      const cover = entry.featuredImage ? await (media?.({ kind: "image", url: entry.featuredImage, key: entry.featuredImage }) ?? { leftOut: "unsupported" as const }) : null;
      copied.set(entry.id, { content, cover });
    }
  }
  return {
    next,
    save: async (tx) => {
      const saved = await recorded();
      for (const entry of items) {
        const made = copied.get(entry.id);
        if (restricted(entry)) {
          tally(job.counts, "changelogEntries", "only some people see");
          continue;
        }
        if (saved.has(entry.id) || !made) {
          tally(job.counts, "changelogEntries", ALREADY_HERE);
          continue;
        }
        const { content, cover } = made;
        if ("error" in content) {
          tally(job.counts, "changelogEntries", "whose content couldn't be read");
          continue;
        }
        const { changelogCount: number } = await tx.project.update({ where: { id: job.projectId }, data: { changelogCount: { increment: 1 } }, select: { changelogCount: true } });
        const date = dateOf(entry.date) ?? dateOf(entry.createdAt) ?? new Date();
        const publishedAt = entry.state === "live" ? date : null;
        const created = await tx.changelogEntry.create({
          data: {
            projectId: job.projectId,
            number,
            title: (entry.title ?? "").trim().slice(0, 120) || "Untitled",
            body: content.text,
            content: content.doc,
            tags: tagsOf(entry),
            publishedAt,
            coverId: cover && "mediaId" in cover ? cover.mediaId : null,
            subscribersEmailedAt: publishedAt && entry.emailSentToSubscribers ? publishedAt : null,
            createdById: job.startedById,
            createdAt: dateOf(entry.createdAt) ?? date,
            updatedAt: dateOf(entry.updatedAt) ?? date,
          },
          select: { id: true },
        });
        await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "changelog", externalId: entry.id, localId: created.id } });
        tally(job.counts, "changelogEntries", null);
        if (content.mediaIds.length > 0) {
          tally(job.counts, "changelogImages", null, content.mediaIds.length);
        }
        content.leftOut.forEach((item) => tally(job.counts, CHANGELOG_MEDIA[item.kind], MEDIA_LEFT_OUT[item.reason]));
        if (cover) {
          tally(job.counts, "changelogImages", "mediaId" in cover ? null : MEDIA_LEFT_OUT[cover.leftOut]);
        }
        if (entry.commentCount) {
          tally(job.counts, "changelogComments", "(Tuti's changelog has no comments)", entry.commentCount);
        }
      }
    },
  };
}
