import { prisma } from "@tuti/db";
import { z } from "zod";

import { portalAddress } from "@/server/custom-domains";

import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";
import { findPost, postNumber } from "./read";

/** The project, its team, votes and duplicate suggestions. */

export const getProject = defineOperation({
  name: "project.get",
  summary: "Get the project the key belongs to, with its portal URL",
  method: "GET",
  path: "/project",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true } });
    return { ...project, portalUrl: await portalAddress(project.slug) };
  },
});

export const updateProject = defineOperation({
  name: "project.update",
  summary: "Rename the project: the name its portal, emails and the app show (its address stays the same)",
  method: "PATCH",
  path: "/project",
  scope: "write",
  access: "admin",
  input: z.object({ name: z.string().trim().min(2, "Give the project a name of 2 characters or more").max(60, "Keep the name under 60 characters") }),
  example: { name: "Acme" },
  run: async ({ projectId }, input) => {
    const project = await prisma.project.update({ where: { id: projectId }, data: { name: input.name }, select: { slug: true, name: true } });
    return { ...project, portalUrl: await portalAddress(project.slug) };
  },
});

export const listTeam = defineOperation({
  name: "team.list",
  summary: "List the project's team: names and roles",
  method: "GET",
  path: "/team",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ projectId }) => {
    const team = await prisma.teamMember.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { role: true, user: { select: { name: true } } },
    });
    return { team: team.map((m) => ({ name: m.user.name, role: m.role.toLowerCase() })) };
  },
});

export const setVote = defineOperation({
  name: "votes.set",
  summary: "Vote for a post or take the vote back, as the key's creator or on behalf of someone from your app",
  method: "POST",
  path: "/posts/{number}/vote",
  scope: "write",
  access: "anyone",
  input: z.object({ number: postNumber, voted: z.boolean(), author }),
  example: { voted: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const post = await findPost(context.projectId, input.number);
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", "This post was merged into another one; vote there instead");
    }
    const userId = await authorId(context, input.author);
    const votes = await prisma.$transaction(async (tx) => {
      const changed = input.voted
        ? (await tx.vote.createMany({ data: { postId: post.id, userId, projectId: context.projectId }, skipDuplicates: true }))
            .count
        : -(await tx.vote.deleteMany({ where: { postId: post.id, userId } })).count;
      const updated = await tx.post.update({
        where: { id: post.id },
        data: { voteCount: { increment: changed } },
        select: { voteCount: true },
      });
      return updated.voteCount;
    });
    return { number: post.number, voted: input.voted, votes };
  },
});

export const listDuplicates = defineOperation({
  name: "duplicates.list",
  summary: "List possible duplicates waiting for the team: a newer post that may repeat an older one",
  method: "GET",
  path: "/duplicates",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const suggestions = await prisma.duplicateSuggestion.findMany({
      where: { projectId, status: "PENDING", post: { duplicateOfId: null }, original: { duplicateOfId: null } },
      orderBy: { similarity: "desc" },
      take: 100,
      select: {
        id: true,
        similarity: true,
        post: { select: { number: true, title: true } },
        original: { select: { number: true, title: true } },
      },
    });
    return { duplicates: suggestions };
  },
});

export const dismissDuplicate = defineOperation({
  name: "duplicates.dismiss",
  summary: "Mark a possible duplicate as not a duplicate (it won't be suggested again)",
  method: "POST",
  path: "/duplicates/{id}/dismiss",
  scope: "write",
  access: "team",
  input: z.object({ id: z.string().min(1) }),
  run: async ({ projectId }, { id }) => {
    const { count } = await prisma.duplicateSuggestion.updateMany({ where: { id, projectId }, data: { status: "DISMISSED" } });
    if (count === 0) {
      throw new OperationError(404, "not_found", "Suggestion not found");
    }
    return { dismissed: id };
  },
});
