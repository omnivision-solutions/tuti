import { type Prisma, prisma } from "@tuti/db";
import { emailConfigured, portalReaderEmail, sendEmail } from "@tuti/email";
import { emailBrand, lockProject, projectSender, readerEmailLanguage } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { portalAddress } from "@/server/custom-domains";
import { hashSecret } from "@/lib/portal-handoff";
import { DOMAIN_ENTRY, OPEN_DOMAINS } from "@/lib/reader-domains";

import { emailAddress } from "./assistant";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/**
 * Who may read the portal (Phase 10): public (anyone), or private (only the team, the people the
 * project's SSO signs in and the readers it adds by email; see server/portal-access.ts for where it's applied).
 */

const ACCESS = ["public", "private"] as const;
export type PortalAccess = (typeof ACCESS)[number];
/** What the portal's home opens (feedback: its first board). */
const HOMES = ["feedback", "roadmap", "changelog", "docs"] as const;
export type PortalHomePage = (typeof HOMES)[number];

/** Who may read the portal, and what its home opens (Settings, portal.get). */
export async function portalAccess(projectId: string): Promise<{ access: PortalAccess; home: PortalHomePage }> {
  const { portalAccess, portalHome } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, portalHome: true } });
  return { access: portalAccess === "PRIVATE" ? "private" : "public", home: portalHome.toLowerCase() as PortalHomePage };
}

const ACCESS_LINE = "Who may read the portal: public (anyone), or private (only the team, people your app signs in with SSO and readers added by email)";
const HOME_LINE = "What the portal's home page opens: feedback (its first board), roadmap, changelog or docs";

const portalOutput = z
  .object({
    access: z.enum(ACCESS).describe(ACCESS_LINE).meta({ examples: ["public"] }),
    home: z.enum(HOMES).describe(HOME_LINE).meta({ examples: ["feedback"] }),
  })
  .meta({ id: "PortalSettings", description: "Who may read the portal, and what its home page opens" });

export const getPortal = defineOperation({
  name: "portal.get",
  title: "Get the portal settings",
  summary: "Get who may read the portal and what its home page opens.",
  method: "GET",
  path: "/portal",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: portalOutput.describe("The portal's settings"),
  run: ({ projectId }) => portalAccess(projectId),
});

export const updatePortal = defineOperation({
  name: "portal.update",
  title: "Update the portal settings",
  summary: "Set who may read the portal and what its home page opens. Fields left out stay as they are.",
  method: "PATCH",
  path: "/portal",
  scope: "write",
  access: "admin",
  errors: [402],
  input: z.object({
    access: z
      .enum(ACCESS, { error: "Pick public or private" })
      .optional()
      .describe(
        `${ACCESS_LINE}; see portalReaders.add. A private portal's pages, feeds, widget and AI answers ask everyone else to sign in. Where plans are sold, private needs a plan with private portals (402 otherwise), and on a lower plan a private portal is its team's only`,
      )
      .meta({ examples: ["private"] }),
    home: z
      .enum(HOMES, { error: "Pick feedback, roadmap, changelog or docs" })
      .optional()
      .describe(HOME_LINE)
      .meta({ examples: ["docs"] }),
  }),
  output: portalOutput.describe("The portal's settings, as changed"),
  example: { access: "private", home: "docs" },
  run: async ({ projectId }, input) => {
    if (input.access === "private") {
      await requirePlan(projectId, "privatePortal");
    }
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.access && { portalAccess: input.access === "private" ? "PRIVATE" : "PUBLIC" }),
        ...(input.home && { portalHome: input.home.toUpperCase() as Uppercase<PortalHomePage> }),
      },
    });
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

/** The private portal's readers by email, newest first (Settings → Access, and portalReaders.list). */
export async function portalReaders(projectId: string) {
  const readers = await prisma.portalReader.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { email: "asc" }], select: readerSelect });
  return readers.map(readerView);
}

export const listPortalReaders = defineOperation({
  name: "portalReaders.list",
  title: "List portal readers",
  summary: "List who may read the private portal besides the team and people your app signs in with SSO, newest first.",
  method: "GET",
  path: "/portal/readers",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      readers: z
        .array(
          z
            .object({
              email: z.string().describe("An address allowed to read it, or a whole domain (\"@acme.com\")").meta({ examples: ["e2e-reader@example.com"] }),
              addedAt: z.string().describe("When it was added").meta({ examples: ["2026-11-02T09:30:00.000Z"] }),
              addedBy: z.string().nullable().describe("Who on the team added it, or null if their account is gone").meta({ examples: ["Olive Owner"] }),
            })
            .meta({ id: "PortalReader", description: "Someone, or a domain, who may read the private portal" }),
        )
        .describe("The readers, newest first"),
    })
    .describe("The private portal's readers"),
  run: async ({ projectId }) => ({ readers: await portalReaders(projectId) }),
});

export const addPortalReaders = defineOperation({
  name: "portalReaders.add",
  title: "Add portal readers",
  summary: `Let people read the portal while it's private, by email: up to ${READERS_PER_ADD} at once, ${MAX_READERS} in all. Addresses already there are left as they are.`,
  method: "POST",
  path: "/portal/readers",
  scope: "write",
  access: "admin",
  errors: [402],
  input: z.object({
    emails: z
      .array(readerEntry)
      .min(1, "Enter an email address")
      .max(READERS_PER_ADD, `Add up to ${READERS_PER_ADD} at once`)
      .describe(
        `Addresses, any account with one reading once it's verified (an emailed sign-in link verifies it), or whole domains ("@acme.com"): everyone with a verified address there (not free email providers, where anyone can get one); up to ${READERS_PER_ADD}`,
      ),
    notify: z
      .boolean()
      .default(true)
      .describe(
        `On a private portal, email each new one a link to it, unless false: up to ${READER_EMAILS_PER_PROJECT_PER_DAY} such emails a day per portal and ${READER_EMAILS_PER_ADDRESS_PER_DAY} per address; past them, readers are added without one`,
      ),
  }),
  output: z
    .object({
      added: z
        .array(z.string().meta({ examples: ["e2e-reader@example.com"] }))
        .describe("Each entry added; those already there are left out"),
      emailed: z.number().int().describe("Says how many emails were sent: none to a domain, nor past the day's limits").meta({ examples: [1] }),
    })
    .describe("Who was added, and how many were emailed"),
  example: { emails: ["e2e-reader@example.com"] },
  run: async ({ actor, projectId }, input) => {
    await requirePlan(projectId, "privatePortal");
    const emails = [...new Set(input.emails)];
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true, portalAccess: true, brandColor: true } });
    const notify = input.notify && project.portalAccess === "PRIVATE" && emailConfigured();
    // Before the readers are added: if it failed after, a retry would find them added and email nobody.
    const address = notify ? await portalAddress(project.slug) : "";
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
      // Inside each send: setting up the project's sender or reading its brand failing is a failed email, never a failed add.
      // Both awaited together, so a failing brand is handled even when the sender failed first.
      // Each in their language: one they chose on a portal (an account with that address) while this portal serves it,
      // else the portal's default; its sign-in page at that language's address.
      const setup = Promise.all([
        projectSender(projectId, inviter?.email),
        emailBrand(projectId),
        readerEmailLanguage(projectId),
        prisma.user
          .findMany({ where: { email: { in: toEmail, mode: "insensitive" } }, select: { email: true, language: true } })
          .then((people) => new Map(people.map((person) => [person.email.toLowerCase(), person.language]))),
      ]);
      // Never fails the add: they're readers either way, and the team can tell them.
      const sent = await Promise.allSettled(
        toEmail.map(async (email) => {
          const [sender, brand, language, chosen] = await setup;
          const words = language(chosen.get(email.toLowerCase()) ?? null);
          const url = `${address}${words.prefix}/sign-in`;
          return sendEmail({ to: email, ...sender, ...portalReaderEmail({ ...brand, inviterName: inviter?.name ?? project.name, email, url, language: words.language }) });
        }),
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
  title: "Remove a portal reader",
  summary: "Stop letting someone read the private portal. The team and SSO users keep their access, and accounts stay.",
  method: "DELETE",
  path: "/portal/readers/{email}",
  scope: "write",
  access: "admin",
  input: z.object({ email: z.string().trim().toLowerCase().min(1).max(320).describe("An address, or a domain (\"@acme.com\"), as listed") }),
  output: z.object({ removed: z.string().describe("The entry removed").meta({ examples: ["e2e-reader@example.com"] }) }).describe("They can't read it any more"),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.portalReader.deleteMany({ where: { projectId, email: input.email } });
    if (count === 0) {
      throw new OperationError(404, "not_found", `${input.email} isn't a reader`);
    }
    return { removed: input.email };
  },
});
