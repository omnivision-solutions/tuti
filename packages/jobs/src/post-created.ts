import { prisma } from "@tuti/db";
import { embeddingsEnabled, type JobInput } from "@tuti/shared";

import { detectDuplicates, embedPosts } from "./duplicates";
import type { JobLogger, JobResult } from "./index";

/** After a post is created: embed it and look for posts it may duplicate. */
export async function postCreated(input: JobInput<"postCreated">, log: JobLogger): Promise<JobResult> {
  const post = await prisma.post.findFirst({
    where: { id: input.postId, projectId: input.projectId },
    select: { id: true, projectId: true, title: true, body: true, duplicateOfId: true },
  });

  if (!post) {
    log.warn(`post ${input.postId} not found, skipping`);
    return { skipped: true };
  }
  if (!embeddingsEnabled()) {
    log.info("OPENAI_API_KEY not set: skipping duplicate detection");
    return { skipped: true };
  }

  const embedded = await embedPosts([post]);
  const suggestions = post.duplicateOfId ? 0 : await detectDuplicates(post.id);
  log.info(`post ${post.id}: embedded ${embedded}, ${suggestions} possible duplicate(s)`);
  return { skipped: false, embedded, suggestions };
}
