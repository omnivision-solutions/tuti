import { randomUUID } from "node:crypto";

import { type DataImport, type ImportSource, type Prisma, prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";
import { type PropertyChanges, propertyChanges } from "@tuti/shared/user-properties";

import { type Featurebase, featurebase, type FeaturebaseAdmin, type FeaturebaseContact, FeaturebaseError } from "./featurebase";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { isUniqueViolation, placeholderEmail, syncUsersIn, type UserDetails } from "./project-users";
import { lockProject } from "./running-draft";

/**
 * Imports from another tool (docs/plan.md, Switching from Featurebase): a chain of import-step jobs, each doing one page
 * of the import's current step: it reads the page from the source (no lock held), then saves its records, where it got
 * to and what came across in one short transaction under the project's lock (as a placeholder's handover takes it), and
 * queues the next.
 */

type Tx = Prisma.TransactionClient;

/** What an import brought across, per kind (contacts, …): how many, and how many it left out, by reason. */
export type ImportCounts = Record<string, { imported: number; leftOut: Record<string, number> }>;

/** One page's work: the import, a client for its source, and its counts, to add to. */
export type ImportJob = {
  id: string;
  projectId: string;
  source: ImportSource;
  startedById: string | null;
  featurebase: Featurebase;
  counts: ImportCounts;
  /** Featurebase's admins, read before a page's transaction that needs them (loadAdmins). */
  admins?: Map<string, FeaturebaseAdmin>;
};

/** Adds `n` to a kind's imported (no `reason`) or left out for `reason`. */
export function tally(counts: ImportCounts, kind: string, reason: string | null, n = 1) {
  const entry = (counts[kind] ??= { imported: 0, leftOut: {} });
  if (reason === null) {
    entry.imported += n;
  } else {
    entry.leftOut[reason] = (entry.leftOut[reason] ?? 0) + n;
  }
}

/**
 * A step's page (cursor null: its first): read from the source, with no transaction or lock held, it says where the
 * next page starts (null: the step is done) and how to save this one, in the page's transaction under the project's lock
 * (short writes only: never the network there).
 */
export type StepPage = { next: string | null; save: (tx: Tx) => Promise<void> };
type Step = { name: string; page: (job: ImportJob, cursor: string | null) => Promise<StepPage> };

/**
 * The parts an import can bring, in the order they run: how a key is checked for each before it starts (its list read
 * once), and its steps. Feedback, the help center and the inbox add theirs (docs/plan.md, I3–I5).
 */
export const IMPORT_PARTS: Record<string, { check: (api: Featurebase) => Promise<unknown>; steps: Step[] }> = {
  contacts: { check: (api) => api.get("/contacts", { limit: 1, contactType: "all" }), steps: [{ name: "contacts", page: contactsPage }] },
};

const STEPS = Object.entries(IMPORT_PARTS).flatMap(([part, { steps }]) => steps.map((step) => ({ ...step, part })));

/** The step after `after` (null: the first) of the picked parts, null when there's none left. */
export function nextStep(parts: string[], after: string | null): string | null {
  const from = after === null ? 0 : STEPS.findIndex((step) => step.name === after) + 1;
  return STEPS.slice(from).find((step) => parts.includes(step.part))?.name ?? null;
}

/** An import that hasn't moved this long is stuck (its job went away): looking at it resumes it. Longer than a page may take (import-step's time limit). */
export const IMPORT_STUCK_MS = 6 * 60_000;
/** One that hasn't moved for a day is failed by the daily fail-stale-imports, its key cleared. */
const STALE_MS = 24 * 60 * 60_000;
const AGAIN = "Start it again to go on: what came across already is skipped.";

/** Imports' next pages not waited for (continueImport's `wait: false`), till each chain ends. */
const inBackground = new Set<Promise<void>>();

/**
 * Queues the import's next page. `wait: false` doesn't wait for it: inline (JOBS_DRIVER=inline) the job, and every page
 * after it, would run inside the request that started it. One that can't be queued goes on when it's looked at (stuck).
 */
export async function continueImport(importId: string, log: JobLogger, { wait = true } = {}): Promise<void> {
  const going = enqueue("importStep", { importId }).then(
    () => undefined,
    (error: unknown) => log.warn(`Import ${importId}: couldn't queue its next page (${String(error)}); it goes on when it's looked at`),
  );
  if (wait) {
    return going;
  }
  inBackground.add(going);
  void going.finally(() => inBackground.delete(going));
}

/** Resolves once every import going on in the background here has ended: for tests. */
export async function importsSettled(): Promise<void> {
  while (inBackground.size > 0) {
    await Promise.all(inBackground);
  }
}

/** Whether a running import has stopped moving (see IMPORT_STUCK_MS). */
export const importStuck = (row: Pick<DataImport, "state" | "updatedAt">) => row.state === "RUNNING" && Date.now() - row.updatedAt.getTime() > IMPORT_STUCK_MS;

/** Resumes a stuck import, once however many look at once (each claims it by moving it). */
export async function resumeImport(importId: string, log: JobLogger, options: { wait?: boolean } = {}): Promise<void> {
  const { count } = await prisma.dataImport.updateMany({
    where: { id: importId, state: "RUNNING", updatedAt: { lt: new Date(Date.now() - IMPORT_STUCK_MS) } },
    data: { updatedAt: new Date() },
  });
  if (count === 1) {
    await continueImport(importId, log, options);
  }
}

/** A page's work for an import (null: it isn't running, or its key is gone). */
export function importJob(row: DataImport): ImportJob | null {
  if (row.state !== "RUNNING" || !row.apiKey) {
    return null;
  }
  const counts = structuredClone(row.counts ?? {}) as ImportCounts;
  return { id: row.id, projectId: row.projectId, source: row.source, startedById: row.startedById, featurebase: featurebase(row.apiKey), counts };
}

/** Why a page failed, in words, for the team. */
function failure(error: unknown): string {
  if (!(error instanceof FeaturebaseError)) {
    return `Something went wrong. ${AGAIN}`;
  }
  if (error.status === 401 || error.status === 403) {
    return `Featurebase stopped accepting the API key (${error.message}). ${AGAIN}`;
  }
  return error.status === 0 ? `Featurebase couldn't be reached. ${AGAIN}` : `Featurebase answered ${error.status} (${error.message}). ${AGAIN}`;
}

/** Runs a page's transaction under the project's lock; one that lost a race to someone's first sight (a sign-in) runs again. */
async function locked<T>(projectId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = () =>
    prisma.$transaction(
      async (tx) => {
        await lockProject(tx, projectId);
        return fn(tx);
      },
      { timeout: 60_000 },
    );
  return run().catch((error: unknown) => {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return run();
  });
}

/**
 * One page of an import's current step (import-step): read from the source, then its records, where it got to and its
 * counts are saved together under the project's lock and a claim (the step and cursor it read), so a duplicate run of
 * the same page saves nothing; its records are remembered (ImportedRecord), so nothing comes across twice. The last
 * page ends it, done, and a failing one fails it; either way its key is cleared.
 */
export async function importStep({ importId }: JobInput<"importStep">, log: JobLogger): Promise<JobResult> {
  const row = await prisma.dataImport.findUnique({ where: { id: importId } });
  const job = row && importJob(row);
  if (!row || !job) {
    return { skipped: true };
  }
  const claim = { id: row.id, state: "RUNNING", step: row.step, cursor: row.cursor } as const;
  let next: string | null = null;
  let saved: boolean;
  try {
    const step = STEPS.find((s) => s.name === row.step);
    if (!step) {
      throw new Error(`no step “${row.step}”`);
    }
    const page = await step.page(job, row.cursor);
    next = page.next ? step.name : nextStep(row.parts, step.name);
    const counted = structuredClone(job.counts);
    saved = await locked(row.projectId, async (tx) => {
      // Counted afresh on each try: a retried save mustn't count its page twice.
      job.counts = structuredClone(counted);
      if ((await tx.dataImport.count({ where: claim })) === 0) {
        return false;
      }
      await page.save(tx);
      const data = next ? { step: next, cursor: page.next, counts: job.counts } : { state: "DONE" as const, apiKey: null, step: "", cursor: null, counts: job.counts, finishedAt: new Date() };
      await tx.dataImport.update({ where: { id: row.id }, data });
      return true;
    });
  } catch (error) {
    log.warn(`Import ${importId}: ${row.step} failed (${String(error)})`);
    await prisma.dataImport.updateMany({ where: claim, data: { state: "FAILED", apiKey: null, error: failure(error), finishedAt: new Date() } });
    return { failed: true };
  }
  if (saved && next) {
    await continueImport(importId, log);
  }
  return saved ? { step: next ?? "done" } : { skipped: true };
}

/** Fails imports that haven't moved for a day (daily), clearing their keys: they can be started again. */
export async function failStaleImports(): Promise<JobResult> {
  const { count } = await prisma.dataImport.updateMany({
    where: { state: "RUNNING", updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { state: "FAILED", apiKey: null, error: `It stopped moving for a day. ${AGAIN}`, finishedAt: new Date() },
  });
  return { failed: count };
}

/**
 * Records of `kind` (contact, admin) the project's imports from this source made users of, by their source id, for
 * those ids: ones whose user was deleted since are forgotten, to be made again.
 */
async function recordedUsers(tx: Tx, job: ImportJob, kind: string, externalIds: string[]): Promise<Map<string, string>> {
  const rows = await tx.importedRecord.findMany({ where: { projectId: job.projectId, source: job.source, kind, externalId: { in: externalIds } }, select: { id: true, externalId: true, localId: true } });
  const users = new Set((await tx.user.findMany({ where: { id: { in: rows.map((row) => row.localId) } }, select: { id: true } })).map((user) => user.id));
  const gone = rows.filter((row) => !users.has(row.localId));
  if (gone.length > 0) {
    await tx.importedRecord.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } });
  }
  return new Map(rows.filter((row) => users.has(row.localId)).map((row) => [row.externalId, row.localId]));
}

/** Featurebase's generated avatars (coloured shapes): left out, so Tuti draws its own. */
const PLACEHOLDER_AVATAR = /^https:\/\/global\.featurebase-attachments\.com\/a\/shapes\//;

/** An avatar's address worth keeping: a web address that isn't one of Featurebase's placeholders. */
const avatar = (url: string | null | undefined) => {
  const trimmed = url?.trim();
  return trimmed && /^https?:\/\//.test(trimmed) && !PLACEHOLDER_AVATAR.test(trimmed) ? trimmed : undefined;
};

/**
 * A Featurebase contact as one of the project's users: their id in the team's app (`userId`, so its SSO finds them),
 * else `featurebase:<id>`; their name, email and avatar where they have one (what they don't have stays as it is); their
 * custom fields as properties, those Tuti's properties take (the rest left out), and their first company's name as `company`.
 */
export function contactDetails(contact: FeaturebaseContact): UserDetails {
  const company = contact.companies?.[0]?.name?.trim();
  const fields = Object.entries(contact.customFields ?? {}).filter(([name, value]) => value !== null && name.trim() !== "company");
  const properties = Object.entries(propertyChanges(Object.fromEntries(company ? [["company", company], ...fields] : fields)));
  return {
    externalId: contact.userId?.trim() || `featurebase:${contact.id}`,
    name: contact.name?.trim() || undefined,
    email: contact.email?.trim() || undefined,
    image: avatar(contact.profilePicture),
    properties: Object.fromEntries(properties.filter(([, value]) => value !== null)) as PropertyChanges,
  };
}

/** Brings contacts across as users (those imported before skipped) and counts them; returns each one's user. */
async function importContacts(tx: Tx, job: ImportJob, contacts: FeaturebaseContact[]): Promise<Map<string, string>> {
  const known = await recordedUsers(tx, job, "contact", contacts.map((contact) => contact.id));
  const fresh = contacts.filter((contact) => !known.has(contact.id));
  if (fresh.length > 0) {
    // One per id in their app: two Featurebase contacts with the same one are one user.
    const details = new Map(fresh.map((contact) => [contactDetails(contact).externalId, contactDetails(contact)]));
    const { userIds } = await syncUsersIn(tx, job.projectId, [...details.values()]);
    const records = fresh.map((contact) => ({ externalId: contact.id, localId: userIds.get(contactDetails(contact).externalId)! }));
    await tx.importedRecord.createMany({ data: records.map((record) => ({ projectId: job.projectId, source: job.source, kind: "contact", ...record })), skipDuplicates: true });
    records.forEach((record) => known.set(record.externalId, record.localId));
  }
  tally(job.counts, "contacts", null, contacts.length);
  return known;
}

/** Contacts: every one (customers and leads), a page at a time. */
async function contactsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const { items, next } = await job.featurebase.page<FeaturebaseContact>("/contacts", cursor, { contactType: "all" });
  return { next, save: (tx) => importContacts(tx, job, items).then(() => undefined) };
}

/**
 * The users some Featurebase contacts are here (by contact id; one Featurebase doesn't have is missing), for a page's
 * authors and voters. Those the contacts step didn't bring (missing from the list, or Contacts imported earlier
 * without them) are read now, before the page's transaction; `save`, in it, brings them across.
 */
export async function contactUsers(job: ImportJob, contactIds: string[]): Promise<{ save: (tx: Tx) => Promise<Map<string, string>> }> {
  const ids = [...new Set(contactIds)];
  const known = await recordedUsers(prisma, job, "contact", ids);
  const fetched: FeaturebaseContact[] = [];
  for (const id of ids.filter((id) => !known.has(id))) {
    const contact = await job.featurebase.get<FeaturebaseContact>(`/contacts/${encodeURIComponent(id)}`).catch((error: unknown) => {
      if (error instanceof FeaturebaseError && error.status === 404) {
        return null;
      }
      throw error;
    });
    if (contact) {
      fetched.push(contact);
    }
  }
  return {
    save: async (tx) => {
      const users = await recordedUsers(tx, job, "contact", ids);
      const brought = await importContacts(tx, job, fetched.filter((contact) => !users.has(contact.id)));
      return new Map([...users, ...brought]);
    },
  };
}

/** Reads Featurebase's admins once for the job, before a page's transaction that looks them up (adminMember). */
export async function loadAdmins(job: ImportJob): Promise<void> {
  job.admins ??= new Map((await job.featurebase.get<{ data: FeaturebaseAdmin[] }>("/admins")).data.map((admin) => [admin.id, admin]));
}

/**
 * Who a Featurebase admin is here, in a page's transaction (loadAdmins first): the team member with the same verified
 * email (`member`; an address anyone could sign up with proves nothing), else a placeholder person of the project's under the admin's name (no account anyone can sign in to, a
 * placeholder address), made once per admin, so nobody else signs their words; handed over if they join the team
 * (handOverPlaceholders). `seen` is what the caller knows of them, for an admin Featurebase no longer lists.
 */
export async function adminMember(tx: Tx, job: ImportJob, adminId: string, seen: { name?: string | null; email?: string | null } = {}): Promise<{ userId: string; member: boolean }> {
  if (!job.admins) {
    throw new Error("loadAdmins before adminMember: the network isn't read in a page's transaction");
  }
  const admin = job.admins.get(adminId) ?? { id: adminId, ...seen };
  const email = admin.email?.trim().toLowerCase() || null;
  if (email) {
    const [member] = await tx.$queryRaw<{ userId: string }[]>`
      SELECT m."userId" FROM team_member m JOIN "user" u ON u.id = m."userId"
      WHERE m."projectId" = ${job.projectId} AND lower(u.email) = ${email} AND u."emailVerified" LIMIT 1`;
    if (member) {
      return { userId: member.userId, member: true };
    }
  }
  const known = await recordedUsers(tx, job, "admin", [adminId]);
  if (known.has(adminId)) {
    return { userId: known.get(adminId)!, member: false };
  }
  // Under the project's lock, so no other page makes them at the same time.
  const user = await tx.user.create({
    data: {
      id: randomUUID(),
      name: admin.name?.trim() || "Former teammate",
      email: placeholderEmail(job.projectId, `${job.source}:admin:${adminId}`, "imported"),
      image: avatar(admin.profilePicture) ?? null,
      placeholderProjectId: job.projectId,
      placeholderFor: email,
    },
    select: { id: true },
  });
  await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "admin", externalId: adminId, localId: user.id } });
  return { userId: user.id, member: false };
}

/**
 * A team member whose verified address is a placeholder's (their address in the other tool) takes over from it, on
 * joining or on verifying their address later: what the placeholder wrote (posts, votes, comments, notes, uploads,
 * articles and their versions, messages), the conversations it still holds (heldById, still unassigned), and the record
 * map's row; then it's deleted, once nothing points at it. Under the project's lock (as import pages write). Nothing for
 * someone not on the team, or whose address isn't verified.
 */
export async function handOverPlaceholders(tx: Tx, projectId: string, userId: string) {
  await lockProject(tx, projectId);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, teamMemberships: { where: { projectId }, select: { id: true } } } });
  if (!user?.emailVerified || user.teamMemberships.length === 0) {
    return;
  }
  const email = user.email;
  const placeholders = await tx.user.findMany({ where: { placeholderProjectId: projectId, placeholderFor: email.toLowerCase() }, select: { id: true } });
  for (const { id: from } of placeholders) {
    await tx.post.updateMany({ where: { authorId: from }, data: { authorId: userId } });
    // A post they both voted for keeps the joined user's vote, and its count drops by the duplicate.
    const voted = (await tx.vote.findMany({ where: { userId: from }, select: { postId: true } })).map((vote) => vote.postId);
    await tx.$executeRaw`UPDATE vote SET "userId" = ${userId} WHERE "userId" = ${from} AND NOT EXISTS (SELECT 1 FROM vote mine WHERE mine."postId" = vote."postId" AND mine."userId" = ${userId})`;
    await tx.vote.deleteMany({ where: { userId: from } });
    await tx.$executeRaw`UPDATE post SET "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = post.id) WHERE id = ANY(${voted}::text[])`;
    await tx.comment.updateMany({ where: { authorId: from }, data: { authorId: userId } });
    await tx.postNote.updateMany({ where: { authorId: from }, data: { authorId: userId } });
    await tx.media.updateMany({ where: { uploaderId: from }, data: { uploaderId: userId } });
    await tx.article.updateMany({ where: { createdById: from }, data: { createdById: userId } });
    await tx.articleRevision.updateMany({ where: { authorId: from }, data: { authorId: userId } });
    await tx.conversationMessage.updateMany({ where: { authorId: from }, data: { authorId: userId } });
    // The conversations they held, if nobody was assigned since (new code clears heldById on any change of assignee,
    // unassigning too; the release before it didn't, so an assignee is checked as well).
    await tx.conversation.updateMany({ where: { projectId, heldById: from, assigneeId: null }, data: { assigneeId: userId } });
    await tx.conversation.updateMany({ where: { projectId, heldById: from }, data: { heldById: null } });
    // Later imports find them as the team member they are now.
    await tx.importedRecord.updateMany({ where: { projectId, kind: "admin", localId: from }, data: { localId: userId } });
    // Deleting a user deletes what's theirs: only once nothing is.
    const left = await Promise.all([
      tx.post.count({ where: { authorId: from } }),
      tx.vote.count({ where: { userId: from } }),
      tx.comment.count({ where: { authorId: from } }),
      tx.postNote.count({ where: { authorId: from } }),
      tx.media.count({ where: { uploaderId: from } }),
    ]);
    if (left.every((n) => n === 0)) {
      await tx.user.delete({ where: { id: from } });
    }
  }
}

/** Someone verified their address: placeholders for it in the projects they're on hand over to them (handOverPlaceholders). */
export async function handOverOnVerified(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, teamMemberships: { select: { projectId: true } } } });
  if (!user?.emailVerified) {
    return;
  }
  const waiting = await prisma.user.findMany({
    where: { placeholderFor: user.email.toLowerCase(), placeholderProjectId: { in: user.teamMemberships.map((m) => m.projectId) } },
    select: { placeholderProjectId: true },
    distinct: ["placeholderProjectId"],
  });
  for (const { placeholderProjectId } of waiting) {
    await prisma.$transaction((tx) => handOverPlaceholders(tx, placeholderProjectId!, userId), { timeout: 60_000 });
  }
}
