import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";
import { findPost, postNumber } from "./read";

/** Posts ↔ GitHub: the pull requests, issues and releases that work on or ship them (listed in posts.get). */

export const removeLink = defineOperation({
  name: "links.remove",
  summary: "Remove a link from a post",
  method: "DELETE",
  path: "/posts/{number}/links/{id}",
  scope: "write",
  access: "team",
  input: z.object({ number: postNumber, id: z.string().min(1) }),
  run: async ({ projectId }, input) => {
    const post = await findPost(projectId, input.number);
    const { count } = await prisma.postLink.deleteMany({ where: { id: input.id, postId: post.id } });
    if (count === 0) {
      throw new OperationError(404, "not_found", "Link not found");
    }
    return { removed: input.id };
  },
});
