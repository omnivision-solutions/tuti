import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";
import { findPost, postNumber } from "./read";

/** Posts ↔ GitHub: the pull requests, issues and releases that work on or ship them (listed in posts.get). */

export const removeLink = defineOperation({
  name: "links.remove",
  title: "Remove a link",
  summary: "Remove a link from a post: a GitHub pull request, issue or release listed in posts.get",
  method: "DELETE",
  path: "/posts/{number}/links/{id}",
  scope: "write",
  access: "team",
  input: z.object({
    number: postNumber.describe("The post's number").meta({ examples: [42] }),
    id: z.string().min(1).describe("The link's id (posts.get's `links`)").meta({ examples: ["cm3k8x2qp0001ab12cd34ef56"] }),
  }),
  output: z.object({ removed: z.string().describe("The id of the link removed").meta({ examples: ["cm3k8x2qp0001ab12cd34ef56"] }) }).describe("The link removed"),
  run: async ({ projectId }, input) => {
    const post = await findPost(projectId, input.number);
    const { count } = await prisma.postLink.deleteMany({ where: { id: input.id, postId: post.id } });
    if (count === 0) {
      throw new OperationError(404, "not_found", "Link not found");
    }
    return { removed: input.id };
  },
});
