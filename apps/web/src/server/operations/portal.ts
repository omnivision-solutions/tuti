import { type Prisma, prisma } from "@tuti/db";
import { emailConfigured, portalReaderEmail, sendEmail } from "@tuti/email";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { portalAddress } from "@/server/custom-domains";
import { hashSecret } from "@/lib/portal-handoff";
import { DOMAIN_ENTRY, OPEN_DOMAINS } from "@/lib/reader-domains";

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
  summary: "Get who may read the portal: public (anyone) or private (only the team, people your app signs in with SSO and readers added by email)",
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
    "Set who may read the portal: public (anyone), or private (only the team, people your app signs in with SSO and readers added by email, see portalReaders.add; its pages, feeds, widget and AI answers ask everyone else to sign in)",
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

/** A reader: an address, or a whole domain ("@acme.com", not one anyone can get an address at). */
const readerEntry = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((entry, ctx) => {
    if (!entry.startsWith("@")) {
      if (!emailAddress.safeParse(entry).success) {
        ctx.addIssue({ code: "custom", message: "Enter a valid email address" });
      }
    } else if (!DOMAIN_ENTRY.test(entry)) {
      ctx.addIssue({ code: "custom", message: "Enter an email address, or a domain like @acme.com" });
    } else if (OPEN_DOMAINS.has(entry.slice(1))) {
      ctx.addIssue({ code: "custom", message: `Anyone can get an ${entry} address: add people from it one by one` });
    }
  });
const isDomain = (entry: string) => entry.startsWith("@");

/** Readers added at once, and at most per project. */
export const READERS_PER_ADD = 20;
export const MAX_READERS = 2000;
/** Emails to new readers a day: per project, and per address across projects (removing and adding someone again counts). */
export const READER_EMAILS_PER_PROJECT_PER_DAY = 100;
export const READER_EMAILS_PER_ADDRESS_PER_DAY = 3;

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
  summary: `Let people read the portal while it's private, by email (up to ${READERS_PER_ADD} at once, ${MAX_READERS} in all): any account with that address, once it's verified (an emailed sign-in link verifies it). An entry can be a whole domain ("@acme.com"): everyone with a verified address there (not free email providers, where anyone can get one). On a private portal, each new one is emailed a link to it unless \`notify\` is false (up to ${READER_EMAILS_PER_PROJECT_PER_DAY} such emails a day per portal, and ${READER_EMAILS_PER_ADDRESS_PER_DAY} per address; past them, readers are added without one, and \`emailed\` says how many were sent). Addresses already there are left as they are`,
  method: "POST",
  path: "/portal/readers",
  scope: "write",
  access: "admin",
  input: z.object({
    emails: z.array(readerEntry).min(1, "Enter an email address").max(READERS_PER_ADD, `Add up to ${READERS_PER_ADD} at once`),
    notify: z.boolean().default(true),
  }),
  example: { emails: ["e2e-reader@example.com"] },
  run: async ({ actor, projectId }, input) => {
    const emails = [...new Set(input.emails)];
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true, portalAccess: true } });
    const notify = input.notify && project.portalAccess === "PRIVATE" && emailConfigured();
    // Before the readers are added: if it failed after, a retry would find them added and email nobody.
    const signInUrl = notify ? `${await portalAddress(project.slug)}/sign-in` : "";
    // Under the project's lock, so adds at the same time can't go past the limits together.
    const { added, toEmail } = await prisma.$transaction(async (tx) => {
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
      // A domain has nobody to email.
      return { added: fresh, toEmail: notify ? await claimReaderEmails(tx, projectId, fresh.filter((entry) => !isDomain(entry))) : [] };
    });

    let emailed = 0;
    if (toEmail.length > 0) {
      const inviter = await prisma.user.findUnique({
        where: { id: actor.kind === "user" ? actor.userId : actor.createdById },
        select: { name: true, email: true },
      });
      const url = signInUrl;
      // Never fails the add: they're readers either way, and the team can tell them.
      const sent = await Promise.allSettled(
        toEmail.map((email) =>
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
      emailed = sent.filter((result) => result.status === "fulfilled").length;
    }
    return { added, emailed };
  },
});

/**
 * Which of `emails` (new readers) may be emailed now, within the day's limits (per project, and
 * per address across projects, so a project made for it can't mail anyone much), each recorded
 * before it's sent. Call it with the project locked.
 */
async function claimReaderEmails(tx: Prisma.TransactionClient, projectId: string, emails: string[]) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await tx.portalReaderEmail.deleteMany({ where: { createdAt: { lt: since } } });
  let left = READER_EMAILS_PER_PROJECT_PER_DAY - (await tx.portalReaderEmail.count({ where: { projectId, createdAt: { gt: since } } }));
  const claimed: string[] = [];
  // Addresses in a fixed order, so two projects adding the same ones can't wait on each other.
  for (const email of [...emails].sort()) {
    if (left <= 0) {
      break;
    }
    const emailHash = hashSecret(email);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${emailHash}))`;
    if ((await tx.portalReaderEmail.count({ where: { emailHash, createdAt: { gt: since } } })) >= READER_EMAILS_PER_ADDRESS_PER_DAY) {
      continue;
    }
    await tx.portalReaderEmail.create({ data: { projectId, emailHash } });
    claimed.push(email);
    left--;
  }
  return claimed;
}

export const removePortalReader = defineOperation({
  name: "portalReaders.remove",
  summary:
    "Stop letting someone (an address) or a domain (\"@acme.com\") read the private portal (the team and SSO users keep their access); accounts stay",
  method: "DELETE",
  path: "/portal/readers/{email}",
  scope: "write",
  access: "admin",
  // An address or a domain entry ("@acme.com"), as listed.
  input: z.object({ email: z.string().trim().toLowerCase().min(1).max(320) }),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.portalReader.deleteMany({ where: { projectId, email: input.email } });
    if (count === 0) {
      throw new OperationError(404, "not_found", `${input.email} isn't a reader`);
    }
    return { removed: input.email };
  },
});
