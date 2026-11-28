import { z } from "zod";

import { defineOperation, OperationError } from "./define";
import { articleScreenshotsRunning, entryScreenshotsRunning } from "./screenshots";

/**
 * Whether a text's screenshots are still being taken, and which version of it is saved: each editor asks while a run
 * goes (its `screenshots` route). Not a GET: a run that ended without placing its screenshots is placed here.
 */
const status = z.object({ running: z.boolean(), savedAt: z.string().nullable() });

export const getEntryScreenshotsStatus = defineOperation({
  name: "changelog.screenshotsStatus",
  title: "Check an entry's screenshots",
  summary: "Whether an entry's screenshots are still being taken, and when it was last saved.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "team",
  input: z.object({ number: z.number().int().positive() }),
  output: status,
  run: ({ projectId }, { number }) => entryScreenshotsRunning(projectId, number),
});

export const getArticleScreenshotsStatus = defineOperation({
  name: "articles.screenshotsStatus",
  title: "Check an article's screenshots",
  summary: "Whether an article's screenshots are still being taken, and its newest version.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "team",
  errors: [404],
  input: z.object({ slug: z.string().min(1).max(200) }),
  output: status,
  run: async ({ projectId }, { slug }) => {
    const answer = await articleScreenshotsRunning(projectId, slug);
    if (!answer) {
      throw new OperationError(404, "not_found", "Article not found");
    }
    return answer;
  },
});
