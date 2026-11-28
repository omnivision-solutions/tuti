import { type Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { PROJECT_USE_KEYS } from "@/lib/project-uses";
import { MAX_PROPERTY_FORMATS, propertyFormat, type PropertyFormats, storedPropertyFormats } from "@/lib/property-formats";
import { portalAddress } from "@/server/custom-domains";

import { authorId, describedAuthor, noSuchComment, orNoSuchComment } from "./create";
import { defineOperation, OperationError } from "./define";
import { findVisiblePost, postNumber, postRef } from "./read";
import { rememberPageLanguage } from "@/server/portal-language";

/** The project, its team, votes and duplicate suggestions. */

/** Formats by property name, as the API takes them. */
const propertyFormatsInput = z.record(z.string().trim().min(1).max(64), propertyFormat);

/** The project as project.get and project.update return it. */
const projectFields = {
  slug: z.string().describe("The project's name in addresses, like its portal's Tuti address (acme.tuti.so); it never changes").meta({ examples: ["acme"] }),
  name: z.string().describe("The name its portal, emails and the app show").meta({ examples: ["Acme"] }),
  uses: z
    .array(z.string())
    .describe("What the team said it will use (feedback, docs, changelog, support; set with project.update): Home's Get set up follows it")
    .meta({ examples: [["feedback", "changelog"]] }),
  portalUrl: z.string().describe("The portal's address: its own domain or site path once verified, else its Tuti address").meta({ examples: ["https://acme.tuti.so"] }),
};

export const getProject = defineOperation({
  name: "project.get",
  title: "Get the project",
  summary: "Get the project the key belongs to, with its portal URL.",
  method: "GET",
  path: "/project",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z.object(projectFields).describe("The project"),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true, uses: true } });
    return { ...project, portalUrl: await portalAddress(project.slug) };
  },
});

/** Settings' gate (the (admin) layout and each settings page): nothing to read, refused to anyone but owners and admins. */
export const getSettingsAccess = defineOperation({
  name: "settings.access",
  title: "Open settings",
  summary: "Whether the caller may open the project's settings: owners and admins.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: z.object({}),
  run: async () => ({}),
});

export const updateProject = defineOperation({
  name: "project.update",
  title: "Update the project",
  summary: "Change the project's name and how the app shows your users' properties, or say what the team will use. Fields left out stay as they are.",
  method: "PATCH",
  path: "/project",
  scope: "write",
  access: "admin",
  input: z.object({
    name: z
      .string()
      .trim()
      .min(2, "Give the project a name of 2 characters or more")
      .max(60, "Keep the name under 60 characters")
      .optional()
      .describe("Rename the project: the name its portal, emails and the app show (its address stays the same); 2 to 60 characters")
      .meta({ examples: ["Acme"] }),
    askingProperty: z
      .string()
      .trim()
      .min(1, "Pick one of your users' properties")
      .max(64, "Properties are up to 64 characters")
      .nullable()
      .optional()
      .describe("Pick Who's asking: the number property of your users (users.sync's `properties`, like `mrr`) the app totals over each post's voters for the team; null: none")
      .meta({ examples: ["mrr"] }),
    userColumns: z
      .array(z.string().trim().min(1, "Pick one of your users' properties").max(64, "Properties are up to 64 characters"))
      .max(10, "Pick up to 10 columns")
      .transform((names) => [...new Set(names)])
      .optional()
      .describe("The properties Users shows as columns, in order (up to 10)")
      .meta({ examples: [["company", "plan", "mrr"]] }),
    propertyFormats: propertyFormatsInput
      .optional()
      .describe("How the app shows each property, by name: a `label` of the team's own, and a `format` (text, number, money in a `currency`, or date). All of them at once, up to 100")
      .meta({ examples: [{ mrr: { label: "MRR", format: "money", currency: "USD" } }] }),
    uses: z
      .array(z.enum(PROJECT_USE_KEYS))
      .transform((uses) => [...new Set(uses)])
      .optional()
      .describe("What the team will use: Home's Get set up follows it; none: every step")
      .meta({ examples: [["feedback", "changelog"]] }),
  }),
  output: z
    .object({
      ...projectFields,
      askingProperty: z.string().nullable().describe("Who's asking: the property totalled over each post's voters; null: none").meta({ examples: ["mrr"] }),
      userColumns: z.array(z.string()).describe("The properties Users shows as columns, in order").meta({ examples: [["company", "plan", "mrr"]] }),
      propertyFormats: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional().describe("The team's own name for it").meta({ examples: ["MRR"] }),
            format: z.string().optional().describe("How it's shown: number, money or date (text without one)").meta({ examples: ["money"] }),
            currency: z.string().optional().describe("A money property's currency").meta({ examples: ["USD"] }),
          }),
        )
        .describe("How the app shows each property, by name")
        .meta({ examples: [{ mrr: { label: "MRR", format: "money", currency: "USD" } }] }),
    })
    .describe("The project, as changed"),
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
  title: "Set property formats",
  summary: "Set how the app shows some of your users' properties, by name, keeping the rest (project.update's `propertyFormats` sets them all at once).",
  method: "PATCH",
  path: "/project/property-formats",
  scope: "write",
  access: "admin",
  input: z.object({
    formats: propertyFormatsInput.describe(`Formats by property name, up to ${MAX_PROPERTY_FORMATS} in all; one with neither a label nor a format is cleared`),
  }),
  output: z
    .object({
      propertyFormats: z
        .record(z.string(), propertyFormat.meta({ id: "PropertyFormat", description: "How the app shows a property" }))
        .describe("Every property's format now, by name")
        .meta({ examples: [{ mrr: { label: "MRR", format: "money", currency: "EUR" } }] }),
    })
    .describe("The project's property formats"),
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
  title: "List the team",
  summary: "List the project's team: names and roles",
  method: "GET",
  path: "/team",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      team: z
        .array(
          z
            .object({
              name: z.string().describe("Their name in Tuti").meta({ examples: ["Olive Owner"] }),
              role: z
                .enum(["owner", "admin", "member"])
                .describe("What they may do: owners and admins change the project's settings, and only owners change some, like Autopilot's")
                .meta({ examples: ["owner"] }),
            })
            .meta({ id: "TeamMember", description: "Someone on the project's team" }),
        )
        .describe("Everyone on the team, in the order they joined"),
    })
    .describe("The project's team"),
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
  title: "Vote for a post",
  summary: "Vote for a post or take the vote back, as the key's creator or on behalf of someone from your app",
  method: "POST",
  path: "/posts/{number}/vote",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({
    number: postNumber.describe("The post's number").meta({ examples: [42] }),
    voted: z.boolean().describe("`true` to vote for it, `false` to take the vote back").meta({ examples: [true] }),
    author: describedAuthor,
  }),
  output: z
    .object({
      number: z.number().int().describe("The post's number").meta({ examples: [42] }),
      voted: z.boolean().describe("Whether they vote for it now").meta({ examples: [true] }),
      votes: z.number().int().describe("How many vote for it now").meta({ examples: [13] }),
    })
    .describe("The vote"),
  example: { voted: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const post = await findVisiblePost(context.actor, context.projectId, input.number);
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
    // The post's news is emailed to them now: in this page's language where they have none (rememberPageLanguage).
    if (input.voted) {
      await rememberPageLanguage(context.actor, userId, context.projectId);
    }
    return { number: post.number, voted: input.voted, votes };
  },
});

export const likeComment = defineOperation({
  name: "comments.like",
  title: "Like a comment",
  summary: "Like a post's comment or take the like back (one each), as the key's creator or on behalf of someone from your app",
  method: "POST",
  path: "/posts/{number}/comments/{id}/like",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({
    number: postNumber.describe("The post's number").meta({ examples: [42] }),
    id: z.string().min(1).max(64).describe("The comment's id (comments.list)").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] }),
    liked: z.boolean().describe("`true` to like it, `false` to take the like back").meta({ examples: [true] }),
    author: describedAuthor,
  }),
  output: z
    .object({
      id: z.string().describe("The comment's id").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] }),
      liked: z.boolean().describe("Whether they like it now").meta({ examples: [true] }),
      likes: z.number().int().describe("How many like it now").meta({ examples: [3] }),
    })
    .describe("The like"),
  example: { liked: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const post = await findVisiblePost(context.actor, context.projectId, input.number);
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", "This post was merged into another one; like its comments there instead");
    }
    const userId = await authorId(context, input.author);
    // Its comment deleted by a writer that doesn't lock the post (its author's account): "There's no such comment".
    return orNoSuchComment(input.id, () => prisma.$transaction(async (tx) => {
      // Locked as setVote locks it: a like during a merge waits for it, then finds the post merged (its comments moved).
      const [locked] = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
        SELECT "duplicateOfId" FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
      if (locked?.duplicateOfId) {
        throw new OperationError(409, "merged", "This post was merged into another one; like its comments there instead");
      }
      // A comment, never a note (notes are their own table): only the team sees those.
      const comment = await tx.comment.findFirst({ where: { id: input.id, postId: post.id }, select: { id: true } });
      if (!comment) {
        throw noSuchComment();
      }
      if (input.liked) {
        await tx.commentLike.createMany({ data: { commentId: comment.id, userId }, skipDuplicates: true });
      } else {
        await tx.commentLike.deleteMany({ where: { commentId: comment.id, userId } });
      }
      return { id: comment.id, liked: input.liked, likes: await tx.commentLike.count({ where: { commentId: comment.id } }) };
    }));
  },
});

export const setSubscription = defineOperation({
  name: "subscriptions.set",
  title: "Follow a post",
  summary: "Follow a post without voting for it, or stop: its followers are emailed as it moves forward and when it ships, as its voters are",
  method: "POST",
  path: "/posts/{number}/subscription",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({
    number: postNumber.describe("The post's number").meta({ examples: [42] }),
    subscribed: z
      .boolean()
      .describe("`true` to follow it, `false` to stop; a completed or closed post can't be followed (409 `finished`)")
      .meta({ examples: [true] }),
    author: describedAuthor,
  }),
  output: z
    .object({
      number: z.number().int().describe("The post's number").meta({ examples: [42] }),
      subscribed: z.boolean().describe("Whether they follow it now").meta({ examples: [true] }),
    })
    .describe("Whether they follow the post"),
  example: { subscribed: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const post = await findVisiblePost(context.actor, context.projectId, input.number);
    const userId = await authorId(context, input.author);
    await prisma.$transaction(async (tx) => {
      // Locked as setVote locks it: a subscription during a merge waits for it, then finds the post merged.
      const [locked] = await tx.$queryRaw<{ duplicateOfId: string | null; status: string }[]>`
        SELECT "duplicateOfId", status::text FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
      if (locked?.duplicateOfId) {
        throw new OperationError(409, "merged", "This post was merged into another one; follow that one instead");
      }
      // Its shipped email has gone out, or won't: nothing to follow (stopping is always fine).
      if (input.subscribed && (locked?.status === "COMPLETED" || locked?.status === "CLOSED")) {
        throw new OperationError(409, "finished", "This post is completed or closed; there's nothing more to follow");
      }
      if (input.subscribed) {
        await tx.postSubscription.createMany({ data: { postId: post.id, userId }, skipDuplicates: true });
      } else {
        await tx.postSubscription.deleteMany({ where: { postId: post.id, userId } });
      }
    });
    // The post's news is emailed to them now: in this page's language where they have none (rememberPageLanguage).
    if (input.subscribed) {
      await rememberPageLanguage(context.actor, userId, context.projectId);
    }
    return { number: post.number, subscribed: input.subscribed };
  },
});

export const listDuplicates = defineOperation({
  name: "duplicates.list",
  title: "List possible duplicates",
  summary: "List possible duplicates waiting for the team, most alike first, up to 100: a newer post that may repeat an older one",
  method: "GET",
  path: "/duplicates",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      duplicates: z
        .array(
          z
            .object({
              id: z.string().describe("The suggestion's id: duplicates.dismiss takes it").meta({ examples: ["cm3kb7de10003ab12cd34ef56"] }),
              similarity: z.number().describe("How alike the two read, up to 1 (the same)").meta({ examples: [0.91] }),
              post: postRef.describe("The newer post, which may repeat `original`"),
              original: postRef.describe("The older post"),
            })
            .meta({ id: "PossibleDuplicate", description: "A newer post that may repeat an older one" }),
        )
        .describe("Up to 100, most alike first; merged posts left out"),
    })
    .describe("The possible duplicates"),
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
  title: "Dismiss a possible duplicate",
  summary: "Mark a possible duplicate as not a duplicate (it won't be suggested again)",
  method: "POST",
  path: "/duplicates/{id}/dismiss",
  scope: "write",
  access: "team",
  input: z.object({ id: z.string().min(1).describe("The suggestion's id (duplicates.list)").meta({ examples: ["cm3kb7de10003ab12cd34ef56"] }) }),
  output: z.object({ dismissed: z.string().describe("The id of the suggestion dismissed").meta({ examples: ["cm3kb7de10003ab12cd34ef56"] }) }).describe("The suggestion dismissed"),
  run: async ({ projectId }, { id }) => {
    const { count } = await prisma.duplicateSuggestion.updateMany({ where: { id, projectId }, data: { status: "DISMISSED" } });
    if (count === 0) {
      throw new OperationError(404, "not_found", "Suggestion not found");
    }
    return { dismissed: id };
  },
});
