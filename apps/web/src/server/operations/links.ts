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

/** Pull requests that may be what a post asks for (by text similarity), waiting for the team. */
export const listLinkSuggestions = defineOperation({
  name: "linkSuggestions.list",
  summary: "List suggested links: pull requests that may be what a post asks for, waiting for the team",
  method: "GET",
  path: "/link-suggestions",
  scope: "read",
  access: "team",
  input: z.object({ number: postNumber.optional() }),
  example: { number: 12 },
  run: async ({ projectId }, input) => {
    const post = input.number === undefined ? null : await findPost(projectId, input.number);
    const suggestions = await prisma.linkSuggestion.findMany({
      where: { projectId, status: "PENDING", ...(post && { postId: post.id }), post: { duplicateOfId: null } },
      orderBy: { similarity: "desc" },
      select: {
        id: true,
        repo: true,
        number: true,
        url: true,
        title: true,
        similarity: true,
        post: { select: { number: true, title: true } },
      },
    });
    return {
      suggestions: suggestions.map((s) => ({
        id: s.id,
        post: s.post,
        pullRequest: { repo: s.repo, number: s.number, url: s.url, title: s.title },
        similarity: s.similarity,
      })),
    };
  },
});

export const acceptLinkSuggestion = defineOperation({
  name: "linkSuggestions.accept",
  summary: "Link a suggested pull request to its post",
  method: "POST",
  path: "/link-suggestions/{id}/accept",
  scope: "write",
  access: "team",
  input: z.object({ id: z.string().min(1) }),
  run: async ({ actor, projectId }, { id }) => {
    const suggestion = await prisma.linkSuggestion.findFirst({ where: { id, projectId, status: "PENDING" } });
    if (!suggestion) {
      throw new OperationError(404, "not_found", "Suggestion not found");
    }
    const link = await prisma.$transaction(async (tx) => {
      await tx.linkSuggestion.delete({ where: { id } });
      return tx.postLink.upsert({
        where: { postId_url: { postId: suggestion.postId, url: suggestion.url } },
        update: {},
        create: {
          projectId,
          postId: suggestion.postId,
          kind: "PULL_REQUEST",
          repo: suggestion.repo,
          number: suggestion.number,
          url: suggestion.url,
          title: suggestion.title,
          source: "SUGGESTED",
          createdById: actor.kind === "user" ? actor.userId : actor.createdById,
        },
        select: linkSelect,
      });
    });
    return linkView(link);
  },
});

export const dismissLinkSuggestion = defineOperation({
  name: "linkSuggestions.dismiss",
  summary: "Mark a suggested pull request as unrelated to its post (it won't be suggested again)",
  method: "POST",
  path: "/link-suggestions/{id}/dismiss",
  scope: "write",
  access: "team",
  input: z.object({ id: z.string().min(1) }),
  run: async ({ projectId }, { id }) => {
    const { count } = await prisma.linkSuggestion.updateMany({
      where: { id, projectId, status: "PENDING" },
      data: { status: "DISMISSED" },
    });
    if (count === 0) {
      throw new OperationError(404, "not_found", "Suggestion not found");
    }
    return { dismissed: id };
  },
});
