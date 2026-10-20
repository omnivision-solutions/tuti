import { prisma } from "@tuti/db";
import { emailConfigured, portalReaderEmail, sendEmail } from "@tuti/email";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { portalUrl } from "@/lib/hosts";

import { emailAddress } from "./assistant";
import { defineOperation, OperationError } from "./define";

/**
 * Who may read the portal (Phase 10): public (anyone), or private (only the team, the people the
 * project's SSO signs in and the readers it adds by email; see server/portal-access.ts for where it's applied).
 */

const ACCESS = ["public", "private"] as const;
export type PortalAccess = (typeof ACCESS)[number];

export async function portalAccess(projectId: string): Promise<{ access: PortalAccess }> {
  const { portalAccess } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true } });
  return { access: portalAccess === "PRIVATE" ? "private" : "public" };
}

export const getPortal = defineOperation({
  name: "portal.get",
  summary: "Get who may read the portal: public (anyone) or private (only the team and people your app signs in with SSO)",
  method: "GET",
  path: "/portal",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => portalAccess(projectId),
});

export const updatePortal = defineOperation({
  name: "portal.update",
  summary:
    "Set who may read the portal: public (anyone), or private (only the team and people your app signs in with SSO; its pages, feeds, widget and AI answers ask everyone else to sign in)",
  method: "PATCH",
  path: "/portal",
  scope: "write",
  access: "admin",
  input: z.object({ access: z.enum(ACCESS, { error: "Pick public or private" }) }),
  example: { access: "private" },
  run: async ({ projectId }, input) => {
    await prisma.project.update({ where: { id: projectId }, data: { portalAccess: input.access === "private" ? "PRIVATE" : "PUBLIC" } });
    return portalAccess(projectId);
  },
});

/** Readers added at once, and at most per project. */
export const READERS_PER_ADD = 20;
export const MAX_READERS = 2000;

const readerView = (reader: { email: string; createdAt: Date; addedBy: { name: string } | null }) => ({
  email: reader.email,
  addedAt: reader.createdAt.toISOString(),
  addedBy: reader.addedBy?.name ?? null,
});
const readerSelect = { email: true, createdAt: true, addedBy: { select: { name: true } } } as const;

/** The private portal's readers by email, newest first (Settings → Portal access, and portalReaders.list). */
export async function portalReaders(projectId: string) {
  const readers = await prisma.portalReader.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { email: "asc" }], select: readerSelect });
  return readers.map(readerView);
}

export const listPortalReaders = defineOperation({
  name: "portalReaders.list",
  summary:
    "List the people (by email) who may read the portal while it's private, besides the team and people your app signs in with SSO; newest first",
  method: "GET",
  path: "/portal/readers",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ readers: await portalReaders(projectId) }),
});

export const addPortalReaders = defineOperation({
  name: "portalReaders.add",
  summary: `Let people read the portal while it's private, by email (up to ${READERS_PER_ADD} at once, ${MAX_READERS} in all): any account with that address, once it's verified (an emailed sign-in link verifies it). On a private portal, each new one is emailed a link to it unless \`notify\` is false. Addresses already there are left as they are`,
  method: "POST",
  path: "/portal/readers",
  scope: "write",
  access: "admin",
  input: z.object({
    emails: z.array(emailAddress).min(1, "Enter an email address").max(READERS_PER_ADD, `Add up to ${READERS_PER_ADD} at once`),
    notify: z.boolean().default(true),
  }),
  example: { emails: ["e2e-reader@example.com"] },
  run: async ({ actor, projectId }, input) => {
    const emails = [...new Set(input.emails)];
    // Under the project's lock, so adds at the same time can't go past the limit together.
    const added = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const existing = new Set(
        (await tx.portalReader.findMany({ where: { projectId, email: { in: emails } }, select: { email: true } })).map((r) => r.email),
      );
      const fresh = emails.filter((email) => !existing.has(email));
      if ((await tx.portalReader.count({ where: { projectId } })) + fresh.length > MAX_READERS) {
        throw new OperationError(400, "invalid_input", `A portal can have up to ${MAX_READERS} readers`);
      }
      const addedById = actor.kind === "user" ? actor.userId : actor.createdById;
      await tx.portalReader.createMany({ data: fresh.map((email) => ({ projectId, email, addedById })) });
      return fresh;
    });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true, portalAccess: true } });
    let emailed = 0;
    if (input.notify && project.portalAccess === "PRIVATE" && added.length > 0) {
      const inviter = await prisma.user.findUnique({
        where: { id: actor.kind === "user" ? actor.userId : actor.createdById },
        select: { name: true, email: true },
      });
      const url = `${portalUrl(project.slug)}/sign-in`;
      // Never fails the add: they're readers either way, and the team can tell them.
      const sent = await Promise.allSettled(
        added.map((email) =>
          sendEmail({
            to: email,
            replyTo: inviter?.email,
            ...portalReaderEmail({ inviterName: inviter?.name ?? project.name, projectName: project.name, email, url }),
          }),
        ),
      );
      for (const result of sent) {
        if (result.status === "rejected") {
          log.error("Emailing a new portal reader failed", { error: result.reason });
        }
      }
      emailed = emailConfigured() ? sent.filter((result) => result.status === "fulfilled").length : 0;
    }
    return { added, emailed };
  },
});

export const removePortalReader = defineOperation({
  name: "portalReaders.remove",
  summary: "Stop letting someone read the private portal by their email (the team and SSO users keep their access); their account stays",
  method: "DELETE",
  path: "/portal/readers/{email}",
  scope: "write",
  access: "admin",
  input: z.object({ email: emailAddress }),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.portalReader.deleteMany({ where: { projectId, email: input.email } });
    if (count === 0) {
      throw new OperationError(404, "not_found", `${input.email} isn't a reader`);
    }
    return { removed: input.email };
  },
});
