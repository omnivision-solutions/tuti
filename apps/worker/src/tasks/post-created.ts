import { prisma } from "@tuti/db";
import { getHatchet } from "@tuti/shared/hatchet";
import { jobs, type JobInput } from "@tuti/shared";

/**
 * Runs after a post is created. Placeholder for duplicate detection
 * (embed title + body, look for similar posts) and notifications.
 */
export const postCreated = getHatchet().task<
  JobInput<"postCreated">,
  { skipped: boolean }
>({
  name: jobs.postCreated.name,
  inputValidator: jobs.postCreated.input,
  retries: 3,
  fn: async (input, ctx) => {
    const post = await prisma.post.findFirst({
      where: { id: input.postId, workspaceId: input.workspaceId },
      select: { id: true, title: true },
    });

    if (!post) {
      ctx.logger.warn(`post ${input.postId} not found, skipping`);
      return { skipped: true };
    }

    ctx.logger.info(`post created: ${post.title}`);
    return { skipped: false };
  },
});
