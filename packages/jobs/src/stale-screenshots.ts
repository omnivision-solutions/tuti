import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { decide, type DecisionAnswer, type DecisionQuestion, type Meter } from "@tuti/shared";

import { docOf } from "./article-layers";
import { DECISION_DIFF_CHARS, pullRequestState, thresholds } from "./code-change-decisions";
import type { PullRequestRead } from "./pull-request";

/**
 * Screenshots a merged pull request may have made out of date (docs/plan.md, SC4): of the screenshots placed in the
 * help center articles Autopilot looks at for it (the docs agent's picks, then the nearest by meaning), the decision
 * model is asked of each whether the change makes it out of date. One it's sure enough of becomes an article edit that
 * turns the image back into its "[Screenshot: …]" line: the editor's Take screenshots retakes it, and the edit waits for
 * a person meanwhile (waitsBecause), as publishing refuses the line. Nothing here starts a browser.
 */

/** The most screenshots asked about per pull request, so a big help center costs no more than a few decisions. */
export const SCREENSHOT_DECISIONS = 5;

export const SCREENSHOT_QUESTION: Record<string, DecisionQuestion> = {
  stale: {
    type: "noul",
    instructions:
      "A help article shows this screenshot of the product's app, taken before the merged pull request: what it was asked to show, what it shows, and the page it was taken on. Does the pull request change what the screenshot shows, so the picture no longer matches the app?",
    criteria: {
      true: "Out of date: the pull request changes something visible in what this screenshot shows (its screen, labels, controls, layout or content)",
      false: "Still right: the pull request changes nothing this screenshot shows",
    },
  },
};

type Block = NonNullable<Doc["content"]>[number];
export type StaleScreenshot = { articleId: string; mediaId: string; show: string; description: string; probability: number };

/** Screenshot records placed as images (top-level, where a run puts them) in the newest text of `articleIds`' published articles, in that order, up to the cap. */
async function placedScreenshots(projectId: string, articleIds: string[]) {
  const articles = await prisma.article.findMany({
    where: { id: { in: articleIds }, projectId, publishedAt: { not: null }, deletedAt: null },
    select: { id: true, body: true, content: true, changes: { select: { body: true, content: true } } },
  });
  const images = articleIds.flatMap((id) => {
    const article = articles.find((a) => a.id === id);
    return article ? (docOf(article.changes ?? article).content ?? []).flatMap((block) => (imageId(block) ? [{ articleId: id, mediaId: imageId(block)! }] : [])) : [];
  });
  if (images.length === 0) {
    return [];
  }
  const shots = await prisma.screenshot.findMany({
    where: { projectId, imageId: { in: images.map((image) => image.mediaId) } },
    select: { imageId: true, show: true, description: true, url: true },
  });
  return images.flatMap((image) => {
    const shot = shots.find((s) => s.imageId === image.mediaId);
    return shot ? [{ ...image, show: shot.show, description: shot.description, url: shot.url }] : [];
  }).slice(0, SCREENSHOT_DECISIONS);
}

const imageId = (block: Block): string | null => (block.type === "image" && typeof block.attrs?.mediaId === "string" ? block.attrs.mediaId : null);

/** The screenshots in `articleIds` the decision model finds the pull request likely made out of date (charged to `meter`). */
export async function staleScreenshots(projectId: string, pr: PullRequestRead, summary: string, articleIds: string[], meter: Meter): Promise<StaleScreenshot[]> {
  const placed = await placedScreenshots(projectId, [...new Set(articleIds)]);
  const answers = await Promise.all(
    placed.map((shot) =>
      decide(
        {
          pull_request: pullRequestState(pr, DECISION_DIFF_CHARS),
          summary_for_users: summary,
          screenshot: { asked_to_show: shot.show, shows: shot.description, page: shot.url },
        },
        SCREENSHOT_QUESTION,
        { meter },
      ),
    ),
  );
  return placed.flatMap(({ url: _, ...shot }, i) => {
    const probability = (answers[i]!.stale as Extract<DecisionAnswer, { type: "noul" }>).noul;
    return probability >= thresholds().ARTICLE_EDIT.maybe ? [{ ...shot, probability }] : [];
  });
}

/** `doc` with each of `stale`'s images turned back into the line that asked for it (no alt text: the retake writes its own); null if none is in it. */
export function withLines(doc: Doc, stale: StaleScreenshot[]): Doc | null {
  let turned = 0;
  const content = (doc.content ?? []).map((block): Block => {
    const shot = stale.find((s) => s.mediaId === imageId(block));
    if (!shot) {
      return block;
    }
    turned++;
    return { type: "paragraph", content: [{ type: "text", text: `[Screenshot: ${shot.show}]` }] };
  });
  return turned > 0 ? { ...doc, content } : null;
}

/** What the team reads on the edit. */
export const staleReason = (stale: StaleScreenshot[]) =>
  stale.length === 1
    ? `This change may have made the screenshot "${stale[0]!.description || stale[0]!.show}" out of date: its line is put back so it can be taken again.`
    : `This change may have made ${stale.length} screenshots out of date: their lines are put back so they can be taken again.`;

/** An article edit of its own for `stale` (one article's), on its newest text: null if none of the images is there any more. */
export async function screenshotEdit(articleId: string, stale: StaleScreenshot[]) {
  const article = await prisma.article.findUnique({ where: { id: articleId }, select: { title: true, body: true, content: true, changes: { select: { title: true, body: true, content: true } } } });
  if (!article) {
    return null;
  }
  const writtenOn = docOf(article.changes ?? article);
  const doc = withLines(writtenOn, stale);
  return doc && { writtenOn, doc, title: (article.changes ?? article).title, before: toPlainText(writtenOn), body: toPlainText(doc) };
}
