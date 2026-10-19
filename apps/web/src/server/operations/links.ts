import { prisma } from "@tuti/db";
import { z } from "zod";

import { parseGitHubUrl } from "@/lib/github-links";

import { defineOperation, OperationError } from "./define";
import { linkSelect, linkView } from "./link-view";
import { findPost, postNumber } from "./read";

/** Posts ↔ GitHub: the pull requests, issues and releases that work on or ship them. */

export const addLink = defineOperation({
  name: "links.add",
  summary: "Link a post to a GitHub pull request, issue or release (its URL)",
  method: "POST",
  path: "/posts/{number}/links",
  scope: "write",
  access: "team",
  input: z.object({ number: postNumber, url: z.string().max(2048) }),
  example: { url: "https://github.com/acme/app/pull/42" },
  run: async ({ actor, projectId }, input) => {
    const github = parseGitHubUrl(input.url);
    if (!github) {
      throw new OperationError(400, "invalid_input", "Paste the URL of a GitHub pull request, issue or release");
    }
    const post = await findPost(projectId, input.number);
    const link = await prisma.postLink.upsert({
      where: { postId_url: { postId: post.id, url: github.url } },
      update: {},
      create: {
        projectId,
        postId: post.id,
        ...github,
        source: "MANUAL",
        createdById: actor.kind === "user" ? actor.userId : actor.createdById,
      },
      select: linkSelect,
    });
    return linkView(link);
  },
});

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
