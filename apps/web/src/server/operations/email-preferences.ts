import { prisma } from "@tuti/db";
import { z } from "zod";

import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";

/** Which of the project's emails about posts someone gets (their portal's Account): about posts they wrote, about posts they voted on or follow, or none (the opt-out). */
export async function emailPreferences(projectId: string, userId: string) {
  const key = { userId_projectId: { userId, projectId } };
  const [preference, optOut] = await Promise.all([
    prisma.emailPreference.findUnique({ where: key, select: { ownPosts: true, followedPosts: true } }),
    prisma.emailOptOut.findUnique({ where: key }),
  ]);
  return { ownPosts: preference?.ownPosts ?? true, followedPosts: preference?.followedPosts ?? true, unsubscribed: optOut !== null };
}

export const updateEmailPreferences = defineOperation({
  name: "emailPreferences.update",
  summary:
    "Choose which of the project's emails about posts someone gets, as the key's creator or on behalf of someone from your app: about posts they wrote (`ownPosts`) or posts they voted on, commented on or follow (`followedPosts`), each when it ships, and the team's replies emailed to its voters (writing a post votes for it); or no emails about posts at all (`unsubscribed`, as the unsubscribe link in every such email; replies to their messages and sign-in emails still arrive). What's left out stays as it was. On someone's behalf, only turning emails off",
  method: "PATCH",
  path: "/email-preferences",
  scope: "write",
  access: "anyone",
  input: z.object({ ownPosts: z.boolean().optional(), followedPosts: z.boolean().optional(), unsubscribed: z.boolean().optional(), author }),
  example: { followedPosts: false, author: { id: "user-42" } },
  run: async (context, input) => {
    // For someone from the app, only ever fewer emails: what they turned off (here or by an email's link) stays off.
    if (input.author && (input.ownPosts || input.followedPosts || input.unsubscribed === false)) {
      throw new OperationError(403, "forbidden", "Only the person themselves can turn their emails back on");
    }
    const userId = await authorId(context, input.author);
    const key = { userId, projectId: context.projectId };
    const posts = { ownPosts: input.ownPosts, followedPosts: input.followedPosts };
    if (posts.ownPosts !== undefined || posts.followedPosts !== undefined) {
      await prisma.emailPreference.upsert({ where: { userId_projectId: key }, create: { ...key, ...posts }, update: posts });
    }
    if (input.unsubscribed) {
      await prisma.emailOptOut.createMany({ data: key, skipDuplicates: true });
    } else if (input.unsubscribed === false) {
      await prisma.emailOptOut.deleteMany({ where: key });
    }
    return emailPreferences(context.projectId, userId);
  },
});
