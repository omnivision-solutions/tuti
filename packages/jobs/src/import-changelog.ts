import { htmlToContent, type HtmlContent, sameFile } from "@tuti/content/html";
import { type ChangelogTag, type Prisma, prisma } from "@tuti/db";
import { MAX_ENTRY_LENGTH } from "@tuti/shared";

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
 * fetch taking 30 seconds at most); past `softMs` from its start no more entries are begun (the rest are the next
 * page's, reading the same list page again); past `hardMs` the entry under way's remaining images are left out, as ones
 * that couldn't be fetched. `now` is the page's clock. Tests shorten them, and drive the clock.
 */
export const CHANGELOG_PAGE = { entries: 10, softMs: 120_000, hardMs: 210_000, now: () => Date.now() };

/** Where the step got to: Featurebase's list page (its cursor) and the last of its entries done (null: none yet). */
type ChangelogAt = { page: string | null; after: { id: string; date: string } | null };

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

/** A title the editor saves as it is (3 to 120 characters, as changelog.update takes): "v2" is "Update: v2". */
function entryTitle(title: string | null | undefined): string {
  const words = (title ?? "").trim().slice(0, 120);
  return words.length >= 3 ? words : words ? `Update: ${words}` : "Untitled";
}

const dateOf = (value: string | null | undefined) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);

export async function changelogPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const begun = CHANGELOG_PAGE.now();
  const at: ChangelogAt = cursor ? JSON.parse(cursor) : { page: null, after: null };
  const listed = await job.featurebase.page<FeaturebaseChangelog>("/changelogs", at.page, { state: "all", sortBy: "date", sortOrder: "asc", limit: CHANGELOG_PAGE.entries });
  // After the last one done; one gone since (deleted, made a segment's), from its date on: entries of the same date may
  // not be done yet (one done already is skipped by its record, counted as brought earlier).
  const index = at.after ? listed.items.findIndex((entry) => entry.id === at.after!.id) : -1;
  const later = at.after ? listed.items.findIndex((entry) => Date.parse(entry.date ?? "") >= Date.parse(at.after!.date)) : 0;
  const rest = listed.items.slice(index >= 0 ? index + 1 : later >= 0 ? later : listed.items.length);
  // Read again in the page's transaction, under its lock: what the check before copying saw may have changed.
  const recorded = async (db: Prisma.TransactionClient) =>
    new Set(
      (await db.importedRecord.findMany({ where: { projectId: job.projectId, source: job.source, kind: "changelog", externalId: { in: rest.map((entry) => entry.id) } }, select: { externalId: true } })).map(
        (record) => record.externalId,
      ),
    );
  const known = await recorded(prisma);
  const copy = job.startedById ? mediaImporter({ projectId: job.projectId, uploaderId: job.startedById }) : undefined;
  const media: typeof copy = copy && (async (source) => (CHANGELOG_PAGE.now() - begun > CHANGELOG_PAGE.hardMs ? { leftOut: "unreachable" } : copy(source)));
  // Images copied first, outside the page's transaction and lock; past the soft limit, the rest are left to the next page.
  const copied = new Map<string, { content: HtmlContent | { error: string }; cover: Awaited<ReturnType<NonNullable<typeof media>>> | null }>();
  let done = 0;
  for (const entry of rest) {
    if (done > 0 && CHANGELOG_PAGE.now() - begun > CHANGELOG_PAGE.softMs) {
      break;
    }
    if (!known.has(entry.id) && !restricted(entry)) {
      // Its length first, without copying anything: one too long to keep (left out on saving) copies nothing.
      const words = await htmlToContent("changelog", entry.content ?? "");
      const tooLong = !("error" in words) && words.text.length > MAX_ENTRY_LENGTH;
      const content = tooLong ? words : await htmlToContent("changelog", entry.content ?? "", { media });
      // Keyed as the text's images are (signatures aside), so a cover that's also in the text is one copy.
      const url = !tooLong && entry.featuredImage;
      const cover = url ? await (media?.({ kind: "image", url, key: sameFile(url) }) ?? { leftOut: "unsupported" as const }) : null;
      copied.set(entry.id, { content, cover });
    }
    done++;
  }
  const items = rest.slice(0, done);
  return {
    next:
      done < rest.length
        ? JSON.stringify({ page: at.page, after: { id: items.at(-1)!.id, date: items.at(-1)!.date ?? "" } })
        : listed.next && JSON.stringify({ page: listed.next, after: null }),
    save: async (tx) => {
      const saved = await recorded(tx);
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
        if ("error" in content || content.text.length > MAX_ENTRY_LENGTH) {
          tally(job.counts, "changelogEntries", "error" in content ? "whose content couldn't be read" : `longer than ${MAX_ENTRY_LENGTH.toLocaleString("en")} characters, Tuti's most`);
          continue;
        }
        const { changelogCount: number } = await tx.project.update({ where: { id: job.projectId }, data: { changelogCount: { increment: 1 } }, select: { changelogCount: true } });
        const date = dateOf(entry.date) ?? dateOf(entry.createdAt) ?? new Date();
        const publishedAt = entry.state === "live" ? date : null;
        const created = await tx.changelogEntry.create({
          data: {
            projectId: job.projectId,
            number,
            title: entryTitle(entry.title),
            body: content.text,
            content: content.doc,
            tags: tagsOf(entry),
            publishedAt,
            coverId: cover && "mediaId" in cover ? cover.mediaId : null,
            // Moved back to a draft since, too: publishing it here mustn't email it again.
            subscribersEmailedAt: entry.emailSentToSubscribers ? date : null,
            createdById: job.startedById,
            createdAt: dateOf(entry.createdAt) ?? date,
            updatedAt: dateOf(entry.updatedAt) ?? date,
          },
          select: { id: true },
        });
        await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "changelog", externalId: entry.id, localId: created.id } });
        // Emailed by Featurebase, not Tuti: its sidebar says so (a send Tuti makes later is its own).
        if (entry.emailSentToSubscribers) {
          await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "changelog-emailed", externalId: entry.id, localId: created.id } });
        }
        tally(job.counts, "changelogEntries", null);
        // Images only (the changelog takes no files), each once: a cover that's also in the text too.
        const copies = new Set([...content.mediaIds, ...(cover && "mediaId" in cover ? [cover.mediaId] : [])]);
        if (copies.size > 0) {
          tally(job.counts, "changelogImages", null, copies.size);
        }
        content.leftOut.forEach((item) => tally(job.counts, CHANGELOG_MEDIA[item.kind], MEDIA_LEFT_OUT[item.reason]));
        // Left out from the text already (the same file): counted once.
        if (cover && "leftOut" in cover && !content.leftOut.some((item) => sameFile(item.url) === sameFile(entry.featuredImage!))) {
          tally(job.counts, "changelogImages", MEDIA_LEFT_OUT[cover.leftOut]);
        }
        if (entry.commentCount) {
          tally(job.counts, "changelogComments", "(Tuti's changelog has no comments)", entry.commentCount);
        }
      }
    },
  };
}
