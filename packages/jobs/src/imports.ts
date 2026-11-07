import { randomUUID } from "node:crypto";

import { type DataImport, type ImportSource, type Prisma, prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";
import { openValue } from "@tuti/shared/signed";
import { type PropertyChanges, propertyChanges } from "@tuti/shared/user-properties";

import type { FeaturebaseAdmin, FeaturebaseContact } from "./featurebase";
import { changelogPage } from "./import-changelog";
import { DOCS_STEPS } from "./import-docs";
import { avatarsPage, feedbackSteps } from "./import-feedback";
import { conversationsPage } from "./import-inbox";
import { teamPage } from "./import-team";
import { type ImportPart, IMPORT_SOURCES, type ImportReaders } from "./import-sources";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { lockConflict } from "./lock-retries";
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

/** One page's work: the import, its source's readers (import-sources), and its counts, to add to. */
export type ImportJob = {
  id: string;
  projectId: string;
  source: ImportSource;
  startedById: string | null;
  read: ImportReaders;
  counts: ImportCounts;
  /** Whether articles published in the source come published (DataImport.publishArticles), else as drafts. */
  publishArticles: boolean;
  /** The source's admins, read before a page's transaction that needs them (loadAdmins). */
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
export type StepPage = {
  next: string | null;
  save: (tx: Tx) => Promise<void>;
  /** Once its save is in (not for a duplicate run, which saves nothing): what follows from it, such as articles indexed for search. */
  after?: () => Promise<void>;
};
type Step = { name: string; page: (job: ImportJob, cursor: string | null) => Promise<StepPage> };

/**
 * The parts an import can bring, in the order they run, and their steps (docs/plan.md, I1, I3–I6); which of them a
 * source has, and how its credential is checked for each, is its own (import-sources).
 */
export const IMPORT_PARTS: Record<ImportPart, { steps: Step[] }> = {
  // First, so the team's invitations are ready to send while the rest comes across.
  team: { steps: [{ name: "team", page: teamPage }] },
  contacts: { steps: [{ name: "contacts", page: contactsPage }] },
  feedback: { steps: feedbackSteps },
  changelog: { steps: [{ name: "changelog", page: changelogPage }] },
  docs: { steps: DOCS_STEPS },
  inbox: { steps: [{ name: "conversations", page: conversationsPage }] },
  // Last: the least of it, and the slowest, so nothing waits for it.
  avatars: { steps: [{ name: "avatars", page: avatarsPage }] },
};

const STEPS = Object.entries(IMPORT_PARTS).flatMap(([part, { steps }]) => steps.map((step) => ({ ...step, part })));

/** The step after `after` (null: the first) of the picked parts, null when there's none left. */
export function nextStep(parts: string[], after: string | null): string | null {
  const from = after === null ? 0 : STEPS.findIndex((step) => step.name === after) + 1;
  return STEPS.slice(from).find((step) => parts.includes(step.part))?.name ?? null;
}

/** An import that hasn't moved this long is stuck (its job went away): looking at it resumes it. Longer than a page may take (import-step's time limit). */
export const IMPORT_STUCK_MS = 6 * 60_000;
/** One that hasn't moved for a day is failed by the daily fail-stale-imports (or, inline, when it's looked at), its key cleared. */
const STALE_MS = 24 * 60 * 60_000;
/**
 * How long a page may spend reading its source, retries and their waits included: import-step's time limit is 5
 * minutes (apps/worker tasks.ts), so a page has time left to save, and IMPORT_STUCK_MS is longer than both.
 */
const PAGE_READ_MS = 3 * 60_000;
const AGAIN = "Start it again to go on: what came across already is skipped.";
/** Why records an earlier import (or an earlier try of this one) brought aren't brought again, as the summary says it. */
export const ALREADY_HERE = "already brought across earlier";

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

/** Whether a running import hasn't moved for a day: fail-stale-imports fails it. */
export const importStale = (row: Pick<DataImport, "state" | "updatedAt">) => row.state === "RUNNING" && Date.now() - row.updatedAt.getTime() > STALE_MS;

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
  const { read } = IMPORT_SOURCES[row.source].connect(openValue(IMPORT_KEY, row.apiKey), { deadline: Date.now() + PAGE_READ_MS });
  return { id: row.id, projectId: row.projectId, source: row.source, startedById: row.startedById, read, counts, publishArticles: row.publishArticles };
}

/** What an import's API key is sealed for while it's kept (sealValue: encrypted at rest). */
export const IMPORT_KEY = "import-key";

/** Why a page failed, in words, for the team. */
function failure(source: ImportSource, error: unknown): string {
  const { name, status: statusOf } = IMPORT_SOURCES[source];
  const status = statusOf(error);
  if (status === null || !(error instanceof Error)) {
    return `Something went wrong. ${AGAIN}`;
  }
  if (status === 401 || status === 403) {
    return `${name} stopped accepting the API key (${error.message}). ${AGAIN}`;
  }
  return status === 0 ? `${error.message} ${AGAIN}` : `${name} answered ${status} (${error.message}). ${AGAIN}`;
}

/** Why an import stopped, in words, for the team: whoever started it is no longer an owner or admin of the project. */
class StarterGone extends Error {
  constructor() {
    super(`Whoever started it is no longer an owner or admin of this project. ${AGAIN}`);
  }
}

/**
 * Stops the import (StarterGone) unless whoever started it is still an owner or admin of its project: checked as a page
 * starts and again in its save, where their team row is held till the save commits, so removing them or changing their
 * role waits for the page (which they were still allowed to bring), and the next page sees it.
 */
async function assertStarterAdmin(db: Tx, row: Pick<DataImport, "projectId" | "startedById">): Promise<void> {
  const [admin] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM team_member
    WHERE "projectId" = ${row.projectId} AND "userId" = ${row.startedById} AND role IN ('OWNER', 'ADMIN')
    FOR SHARE`;
  if (!admin) {
    throw new StarterGone();
  }
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
  // Run again when it lost a race to someone's first sight (a sign-in making the same user: a unique key), or when
  // Postgres gave up on it for its locks (a deadlock with that sign-in's foreign-key check on the project's row).
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 3 || !(isUniqueViolation(error) || lockConflict(error))) {
        throw error;
      }
    }
  }
}

/**
 * One page of an import's current step (import-step): read from the source, then its records, where it got to and its
 * counts are saved together under the project's lock and a claim (the step and cursor it read), so a duplicate run of
 * the same page saves nothing; its records are remembered (ImportedRecord), so nothing comes across twice. The last
 * page ends it, done, and a failing one fails it; either way its key is cleared.
 */
export async function importStep({ importId }: JobInput<"importStep">, log: JobLogger): Promise<JobResult> {
  // A source this worker doesn't have (it's the release before the web that started the import, mid-deploy): its
  // client can't read the row (the enum value is unknown to it), so the source is read as text first, and the import
  // failed as a part it doesn't have is, never left running with its key.
  const [raw] = await prisma.$queryRaw<{ source: string }[]>`SELECT source::text AS source FROM data_import WHERE id = ${importId}`;
  if (raw && !(raw.source in IMPORT_SOURCES)) {
    await prisma.$executeRaw`
      UPDATE data_import SET state = 'FAILED', "apiKey" = NULL, error = ${`Tuti was updating as it started. ${AGAIN}`}, "finishedAt" = now(), "updatedAt" = now()
      WHERE id = ${importId} AND state = 'RUNNING'`;
    return { failed: true };
  }
  const row = await prisma.dataImport.findUnique({ where: { id: importId } });
  let job: ImportJob | null;
  try {
    job = row && importJob(row);
  } catch {
    // The key can't be opened: this worker hasn't the web app's BETTER_AUTH_SECRET (a self-hosted worker set up apart).
    await prisma.dataImport.updateMany({
      where: { id: importId, state: "RUNNING" },
      data: { state: "FAILED", apiKey: null, error: `The worker couldn't read the API key: give it the web app's BETTER_AUTH_SECRET. ${AGAIN}`, finishedAt: new Date() },
    });
    return { failed: true };
  }
  if (!row || !job) {
    return { skipped: true };
  }
  const claim = { id: row.id, state: "RUNNING", step: row.step, cursor: row.cursor } as const;
  // A part this worker doesn't have (it's the release before the web that started the import, mid-deploy) fails it,
  // never skipped: an import that ended "done" without it would say nothing of what it left behind.
  const unknown = row.parts.find((part) => !(part in IMPORT_PARTS));
  if (unknown) {
    await prisma.dataImport.updateMany({ where: claim, data: { state: "FAILED", apiKey: null, error: `Tuti was updating as it started. ${AGAIN}`, finishedAt: new Date() } });
    return { failed: true };
  }
  // One from before avatars were a part of their own, last (Feedback's, before its duplicate check): it goes on with the
  // rest, and copies them last.
  if (row.step === "avatars" && !row.parts.includes("avatars")) {
    const parts = [...row.parts, "avatars"];
    const step = nextStep(parts, "comments")!;
    const { count } = await prisma.dataImport.updateMany({ where: claim, data: { parts, step, cursor: null } });
    if (count > 0) {
      await continueImport(importId, log);
    }
    return count > 0 ? { step } : { skipped: true };
  }
  let next: string | null = null;
  let saved: boolean;
  let after: StepPage["after"];
  try {
    const step = STEPS.find((s) => s.name === row.step);
    if (!step) {
      throw new Error(`no step “${row.step}”`);
    }
    await assertStarterAdmin(prisma, row);
    const page = await step.page(job, row.cursor);
    after = page.after;
    next = page.next ? step.name : nextStep(row.parts, step.name);
    const counted = structuredClone(job.counts);
    saved = await locked(row.projectId, async (tx) => {
      // Counted afresh on each try: a retried save mustn't count its page twice.
      job.counts = structuredClone(counted);
      // The import's row, held till this commits: the same page failing in another run (its updateMany on the claim)
      // waits for this save, then finds the claim moved on, so it can't fail an import this page saved, or the reverse.
      const [held] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM data_import
        WHERE id = ${row.id} AND state = 'RUNNING' AND step = ${row.step} AND cursor IS NOT DISTINCT FROM ${row.cursor}::text
        FOR UPDATE`;
      if (!held) {
        return false;
      }
      await assertStarterAdmin(tx, row);
      await page.save(tx);
      const data = next ? { step: next, cursor: page.next, counts: job.counts } : { state: "DONE" as const, apiKey: null, step: "", cursor: null, counts: job.counts, finishedAt: new Date() };
      await tx.dataImport.update({ where: { id: row.id }, data });
      return true;
    });
  } catch (error) {
    log.warn(`Import ${importId}: ${row.step} failed (${String(error)})`);
    await prisma.dataImport.updateMany({ where: claim, data: { state: "FAILED", apiKey: null, error: error instanceof StarterGone ? error.message : failure(row.source, error), finishedAt: new Date() } });
    return { failed: true };
  }
  if (saved) {
    await after?.();
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
    // With what was noted of them (`lead`, `linked`), so a user made again is noted afresh.
    await tx.importedRecord.deleteMany({
      where: { projectId: job.projectId, source: job.source, externalId: { in: gone.map((row) => row.externalId) }, localId: { in: gone.map((row) => row.localId) } },
    });
  }
  return new Map(rows.filter((row) => users.has(row.localId)).map((row) => [row.externalId, row.localId]));
}

/** A user's external id for someone of a source's without an id in the team's app (`featurebase:<id>`): one namespace per source. */
export const sourceUserId = (source: ImportSource, id: string) => `${source.toLowerCase()}:${id}`;

/** Featurebase's generated avatars (coloured shapes): left out, so Tuti draws its own. */
const PLACEHOLDER_AVATAR = /^https:\/\/global\.featurebase-attachments\.com\/a\/shapes\//;

/** An avatar's address worth keeping: a web address that isn't one of Featurebase's placeholders. */
const avatar = (url: string | null | undefined) => {
  const trimmed = url?.trim();
  return trimmed && /^https?:\/\//.test(trimmed) && !PLACEHOLDER_AVATAR.test(trimmed) ? trimmed : undefined;
};

/**
 * A source's contact as one of the project's users: their id in the team's app (`userId`, so its SSO finds them),
 * else `<source>:<id>` (`featurebase:<id>`), so two sources' ids never meet; their name, email and avatar where they have one (what they don't have stays as it is); their
 * custom fields as properties, those Tuti's properties take (the rest left out), and their first company's name as `company`.
 */
export function contactDetails(contact: FeaturebaseContact, source: ImportSource): UserDetails {
  const company = contact.companies?.[0]?.name?.trim();
  const fields = Object.entries(contact.customFields ?? {}).filter(([name, value]) => value !== null && !(company && name.trim() === "company"));
  const properties = Object.entries(propertyChanges(Object.fromEntries(company ? [["company", company], ...fields] : fields)));
  return {
    // As the app's SSO sends it (`sub` isn't trimmed), so the two find the same user.
    externalId: contact.userId?.trim() ? contact.userId : sourceUserId(source, contact.id),
    name: contact.name?.trim() || undefined,
    email: contact.email?.trim() || undefined,
    image: avatar(contact.profilePicture),
    properties: Object.fromEntries(properties.filter(([, value]) => value !== null)) as PropertyChanges,
  };
}

/** Brings contacts across as users and counts them (those imported before skipped, and counted so); returns each one's user. */
async function importContacts(tx: Tx, job: ImportJob, contacts: FeaturebaseContact[]): Promise<Map<string, string>> {
  const known = await recordedUsers(tx, job, "contact", contacts.map((contact) => contact.id));
  const fresh = contacts.filter((contact) => !known.has(contact.id));
  if (fresh.length > 0) {
    // One per id in their app: two Featurebase contacts with the same one are one user. And one per address in a
    // project: a customer without an id in their app whose address a user here has (signed in, or brought by any
    // import) is that user, and one whose address another customer on the page has is theirs. Never by a lead's: anyone
    // can type any address as a lead, and would see that person's conversations. Someone with an id in their app keeps
    // it, so the app's SSO finds them.
    const all = fresh.map((contact) => contactDetails(contact, job.source));
    const byAddress = (contact: FeaturebaseContact) => (contact.type !== "lead" && !contact.userId?.trim() && contact.email?.trim().toLowerCase()) || null;
    const emails = fresh.flatMap((contact) => byAddress(contact) ?? []);
    const byEmail = new Map(
      emails.length === 0
        ? []
        : (
            // Never one an import made of a lead (remembered as `lead`): their address is as unproven.
            await tx.$queryRaw<{ email: string; userId: string }[]>`
              SELECT DISTINCT ON (email) email, "userId" FROM sso_identity s
              WHERE "projectId" = ${job.projectId} AND email = ANY(${emails}::text[])
                AND NOT EXISTS (SELECT 1 FROM imported_record r WHERE r."projectId" = s."projectId" AND r.kind = 'lead' AND r."localId" = s."userId")
              ORDER BY email, "createdAt" ASC`
          ).map((row) => [row.email, row.userId]),
    );
    const details = new Map<string, UserDetails>();
    const firstWith = new Map<string, string>();
    const linked = new Map<string, { userId: string } | { externalId: string }>();
    fresh.forEach((contact, i) => {
      const d = all[i]!;
      const email = byAddress(contact);
      const user = email && byEmail.get(email);
      const first = email && firstWith.get(email);
      if (user) {
        linked.set(contact.id, { userId: user });
      } else if (first) {
        linked.set(contact.id, { externalId: first });
      } else {
        details.set(d.externalId, d);
        linked.set(contact.id, { externalId: d.externalId });
        const own = contact.type !== "lead" && d.email?.toLowerCase();
        if (own && !firstWith.has(own)) {
          firstWith.set(own, d.externalId);
        }
      }
    });
    const { userIds } = await syncUsersIn(tx, job.projectId, [...details.values()]);
    const records = fresh.map((contact) => {
      const to = linked.get(contact.id)!;
      // Linked by their address to someone else's user (there before, or another contact's): not theirs to change.
      const byLink = "userId" in to || to.externalId !== all[fresh.indexOf(contact)]!.externalId;
      return { externalId: contact.id, localId: "userId" in to ? to.userId : userIds.get(to.externalId)!, byLink };
    });
    // Only those of their own: a lead with an id in the team's app is that app's user.
    const leads = new Set(fresh.filter((contact) => contact.type === "lead" && !contact.userId?.trim()).map((contact) => contact.id));
    await tx.importedRecord.createMany({
      // `lead`: their address is never matched; `linked`: their user's avatar isn't the import's to copy (avatarsPage).
      data: records.flatMap(({ byLink, ...record }) => [
        { projectId: job.projectId, source: job.source, kind: "contact", ...record },
        ...(leads.has(record.externalId) ? [{ projectId: job.projectId, source: job.source, kind: "lead", ...record }] : []),
        ...(byLink ? [{ projectId: job.projectId, source: job.source, kind: "linked", ...record }] : []),
      ]),
      skipDuplicates: true,
    });
    records.forEach((record) => known.set(record.externalId, record.localId));
  }
  tally(job.counts, "contacts", null, fresh.length);
  if (fresh.length < contacts.length) {
    tally(job.counts, "contacts", ALREADY_HERE, contacts.length - fresh.length);
  }
  return known;
}

/** Contacts: every one (customers and leads), a page at a time. */
async function contactsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const { items, next } = await job.read.contacts!(cursor);
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
    const contact = await job.read.contact!(id);
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

/** Reads the source's admins once for the job, before a page's transaction that looks them up (adminMember). */
export async function loadAdmins(job: ImportJob): Promise<void> {
  job.admins ??= new Map((await job.read.admins!()).map((admin) => [admin.id, admin]));
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
    // Theirs by a verified address, or by joining with this project's invite to it (handOverPlaceholders).
    const [member] = await tx.$queryRaw<{ userId: string }[]>`
      SELECT m."userId" FROM team_member m JOIN "user" u ON u.id = m."userId"
      WHERE m."projectId" = ${job.projectId} AND lower(u.email) = ${email}
        AND (u."emailVerified" OR EXISTS (SELECT 1 FROM invitation i WHERE i."projectId" = m."projectId" AND i."acceptedById" = u.id AND i.email = ${email}))
      LIMIT 1`;
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
 * someone not on the team, or whose address isn't verified, unless `invited`: they joined by this project's invite to
 * their address, which its team chose to trust (it doesn't verify the address: see acceptInvitation).
 */
export async function handOverPlaceholders(tx: Tx, projectId: string, userId: string, invited = false) {
  await lockProject(tx, projectId);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, teamMemberships: { where: { projectId }, select: { id: true } } } });
  if (!user || !(user.emailVerified || invited) || user.teamMemberships.length === 0) {
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
  // The projects they're on with a placeholder for them, or an import running (a page may be saving one right now,
  // uncommitted): each read again under its lock (handOverPlaceholders locks, then reads), so a page's placeholder is
  // seen once it commits, never missed. A page only runs while its import is RUNNING, so nothing else needs the lock.
  const email = user.email.toLowerCase();
  const candidates = await prisma.project.findMany({
    where: {
      id: { in: user.teamMemberships.map((m) => m.projectId) },
      OR: [{ placeholders: { some: { placeholderFor: email } } }, { dataImports: { some: { state: "RUNNING" } } }],
    },
    select: { id: true },
  });
  for (const { id: projectId } of candidates) {
    await prisma.$transaction((tx) => handOverPlaceholders(tx, projectId, userId), { timeout: 60_000 });
  }
}
