import { prisma } from "@tuti/db";
import { embeddingsEnabled, jobs, type JobInput } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { detectDuplicates, embedPosts } from "../duplicates";

/** After a post is created: embed it and look for posts it may duplicate. */
export const postCreated = getHatchet().task<
  JobInput<"postCreated">,
  { skipped: boolean; embedded?: number; suggestions?: number }
>({
  name: jobs.postCreated.name,
  inputValidator: jobs.postCreated.input,
  retries: 3,
  fn: async (input, ctx) => {
    const post = await prisma.post.findFirst({
      where: { id: input.postId, projectId: input.projectId },
      select: { id: true, projectId: true, title: true, body: true, duplicateOfId: true },
    });

    if (!post) {
      ctx.logger.warn(`post ${input.postId} not found, skipping`);
      return { skipped: true };
    }
    if (!embeddingsEnabled()) {
      ctx.logger.info("OPENAI_API_KEY not set: skipping duplicate detection");
      return { skipped: true };
    }

    const embedded = await embedPosts([post]);
    const suggestions = post.duplicateOfId ? 0 : await detectDuplicates(post.id);
    ctx.logger.info(`post ${post.id}: embedded ${embedded}, ${suggestions} possible duplicate(s)`);
    return { skipped: false, embedded, suggestions };
  },
});
