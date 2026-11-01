import { type Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { PROJECT_USE_KEYS } from "@/lib/project-uses";
import { MAX_PROPERTY_FORMATS, propertyFormat, type PropertyFormats, storedPropertyFormats } from "@/lib/property-formats";
import { portalAddress } from "@/server/custom-domains";

import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";
import { findPost, postNumber } from "./read";

/** The project, its team, votes and duplicate suggestions. */

/** Formats by property name, as the API takes them. */
const propertyFormatsInput = z.record(z.string().trim().min(1).max(64), propertyFormat);

export const getProject = defineOperation({
  name: "project.get",
  summary: "Get the project the key belongs to, with its portal URL and what the team said it will use (`uses`, project.update's)",
  method: "GET",
  path: "/project",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true, uses: true } });
    return { ...project, portalUrl: await portalAddress(project.slug) };
  },
});

export const updateProject = defineOperation({
  name: "project.update",
  summary:
    "Rename the project (the name its portal, emails and the app show; its address stays the same), pick Who's asking: the number property of your users (users.sync's `properties`, like `mrr`) the app totals over each post's voters for the team (null: none), pick `userColumns`: the properties Users shows as columns, in order (up to 10), or set `propertyFormats`: how the app shows each property, by name (a `label` of the team's own, and a `format`: text, number, money in a `currency`, or date; all of them at once, up to 100), or say what the team will `uses` (feedback, docs, changelog, support: Home's Get set up follows it; none: every step)",
  method: "PATCH",
  path: "/project",
  scope: "write",
  access: "admin",
  input: z.object({
    name: z.string().trim().min(2, "Give the project a name of 2 characters or more").max(60, "Keep the name under 60 characters").optional(),
    askingProperty: z.string().trim().min(1, "Pick one of your users' properties").max(64, "Properties are up to 64 characters").nullable().optional(),
    userColumns: z
      .array(z.string().trim().min(1, "Pick one of your users' properties").max(64, "Properties are up to 64 characters"))
      .max(10, "Pick up to 10 columns")
      .transform((names) => [...new Set(names)])
      .optional(),
    propertyFormats: propertyFormatsInput.optional(),
    uses: z
      .array(z.enum(PROJECT_USE_KEYS))
      .transform((uses) => [...new Set(uses)])
      .optional(),
  }),
  example: {
    name: "Acme",
    askingProperty: "mrr",
    userColumns: ["company", "plan", "mrr"],
    propertyFormats: { mrr: { label: "MRR", format: "money", currency: "USD" } },
    uses: ["feedback", "changelog"],
  },
  run: async ({ projectId }, input) => {
    const write = (db: Prisma.TransactionClient) =>
      db.project.update({
        where: { id: projectId },
        data: { name: input.name, askingProperty: input.askingProperty, userColumns: input.userColumns, uses: input.uses },
        select: { slug: true, name: true, askingProperty: true, userColumns: true, propertyFormats: true, uses: true },
      });
    // With formats, they and the rest together or not at all; without, a plain write (no transaction to wait for).
    const formats = input.propertyFormats;
    const project = formats
      ? await prisma.$transaction(async (tx) => {
          await writeFormats(tx, projectId, () => keptFormats(formats));
          return write(tx);
        }, FORMATS_WAIT)
      : await write(prisma);
    return { ...project, portalUrl: await portalAddress(project.slug) };
  },
});

/** A transaction writing formats: room past Prisma's 5 seconds to wait for another's lock. */
const FORMATS_WAIT = { timeout: 15_000 };

/**
 * Writes the project's property formats in `tx`, `build` making them from those stored now, as they are (one a later
 * release wrote, with a currency or a field this one doesn't know, is kept as it is): one write at a time per project
 * (project.update's and propertyFormats.update's alike), read and written under the same lock on one connection, so
 * two at once each keep the other's. Up to 100.
 */
async function writeFormats(
  tx: Prisma.TransactionClient,
  projectId: string,
  build: (stored: Record<string, Prisma.JsonValue>) => Record<string, Prisma.JsonValue>,
): Promise<PropertyFormats> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${projectId}))`;
  const { propertyFormats } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { propertyFormats: true } });
  const stored = (typeof propertyFormats === "object" && propertyFormats !== null && !Array.isArray(propertyFormats) ? propertyFormats : {}) as Record<
    string,
    Prisma.JsonValue
  >;
  const formats = build(stored);
  if (Object.keys(formats).length > MAX_PROPERTY_FORMATS) {
    throw new OperationError(400, "invalid_input", `Up to ${MAX_PROPERTY_FORMATS} properties`);
  }
  await tx.project.update({ where: { id: projectId }, data: { propertyFormats: formats as Prisma.InputJsonObject } });
  return storedPropertyFormats(formats);
}

export const updatePropertyFormats = defineOperation({
  name: "propertyFormats.update",
  summary:
    "Set how the app shows some of your users' properties, by name, keeping the rest (project.update's `propertyFormats` sets them all at once): a `label` of the team's own and a `format` (text, number, money in a `currency`, or date); one with neither is cleared",
  method: "PATCH",
  path: "/project/property-formats",
  scope: "write",
  access: "admin",
  input: z.object({ formats: propertyFormatsInput }),
  example: { formats: { mrr: { label: "MRR", format: "money", currency: "EUR" }, seats: { label: "" } } },
  // fromEntries, so a property named "__proto__" is one like any other.
  run: async ({ projectId }, input) => ({
    propertyFormats: await prisma.$transaction(
      (tx) =>
        writeFormats(tx, projectId, (stored) => {
          // Only those given change (kept as keptFormats has them; one with nothing left is cleared); the rest stay as stored.
          // fromEntries, so a property named "__proto__" is one like any other.
          const given = new Set(Object.keys(input.formats));
          return Object.fromEntries([...Object.entries(stored).filter(([name]) => !given.has(name)), ...Object.entries(keptFormats(input.formats))]);
        }),
      FORMATS_WAIT,
    ),
  }),
});

/** Formats as kept: no empty name, no "text" (what a property is without one), no property with neither. */
function keptFormats(formats: PropertyFormats): PropertyFormats {
  const kept: [string, PropertyFormats[string]][] = [];
  for (const [name, { label, format, currency }] of Object.entries(formats)) {
    const shown = {
      ...(label && { label }),
      ...(format && format !== "text" && { format }),
      ...(format === "money" && currency && { currency }),
    };
    if (Object.keys(shown).length > 0) {
      kept.push([name, shown]);
    }
  }
  return Object.fromEntries(kept);
}

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
      // Its post locked first, as a merge locks it (mergePosts): a vote during a merge waits for it (no
      // deadlock over the votes it moves), then finds the post merged.
      const [locked] = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
        SELECT "duplicateOfId" FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
      if (locked?.duplicateOfId) {
        throw new OperationError(409, "merged", "This post was merged into another one; vote there instead");
      }
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

export const setSubscription = defineOperation({
  name: "subscriptions.set",
  summary: "Follow a post without voting for it, or stop: its followers are emailed when it ships, as its voters are",
  method: "POST",
  path: "/posts/{number}/subscription",
  scope: "write",
  access: "anyone",
  input: z.object({ number: postNumber, subscribed: z.boolean(), author }),
  example: { subscribed: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const post = await findPost(context.projectId, input.number);
    const userId = await authorId(context, input.author);
    await prisma.$transaction(async (tx) => {
      // Locked as setVote locks it: a subscription during a merge waits for it, then finds the post merged.
      const [locked] = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
        SELECT "duplicateOfId" FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
      if (locked?.duplicateOfId) {
        throw new OperationError(409, "merged", "This post was merged into another one; follow that one instead");
      }
      if (input.subscribed) {
        await tx.postSubscription.createMany({ data: { postId: post.id, userId }, skipDuplicates: true });
      } else {
        await tx.postSubscription.deleteMany({ where: { postId: post.id, userId } });
      }
    });
    return { number: post.number, subscribed: input.subscribed };
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
