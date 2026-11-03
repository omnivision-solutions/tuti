import { createHash, randomUUID } from "node:crypto";

import { Prisma, prisma } from "@tuti/db";

import { mergeProperties, type PropertyChanges, type PropertyValue, storedProperties } from "@/lib/user-properties";

import { OperationError } from "./operations/define";

/**
 * A project's users: the people its app tells Tuti about, by SSO sign-ins (and the widget's), `author`
 * on API calls, and users.sync. Each is an SsoIdentity (their id in the app, their email and properties)
 * with a User of their own, matched by that id, never by email: a project controls everything it
 * sends, so trusting email would let it act as any Tuti user.
 */

/** What's said about one of them; only what's given changes. `properties` sets the ones it names and removes (null) others. */
export type UserDetails = {
  externalId: string;
  name?: string;
  image?: string | null;
  email?: string | null;
  properties?: PropertyChanges;
};

/** The `groups` property as a list (a list's items, or the one value), none when it's not set. */
const groupsOf = (value: PropertyValue | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [String(value)]);

/** The name of someone their app gave none: their address's first part, or "Anonymous" without one. */
const madeUpName = (email: string | null | undefined) => email?.split("@")[0] ?? "Anonymous";

/** User.email must be unique, so a project's users get a stable placeholder; the email it gives them lives on SsoIdentity. */
function placeholderEmail(projectId: string, externalId: string): string {
  const hash = createHash("sha256").update(`${projectId}:${externalId}`).digest("hex").slice(0, 32);
  return `sso-${hash}@users.tuti.invalid`;
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Creates or changes the project's users (each `externalId` once), in one transaction: their Users
 * are made on first sight, and only the details given change. Properties past 50 are left out, or
 * with `strict` (the API) refused. Returns each one's User id, and how many were new.
 */
export async function syncUsers(projectId: string, users: UserDetails[], { strict = false } = {}) {
  const run = () =>
    prisma.$transaction(
      async (tx) => {
        const externalIds = users.map((user) => user.externalId);
        // Locked (in one order, so two syncs can't deadlock), so changes at once (a sign-in, an API call) both land.
        const rows = await tx.$queryRaw<{ id: string; userId: string; externalId: string; email: string | null; properties: unknown }[]>`
          SELECT id, "userId", "externalId", email, attributes AS properties FROM sso_identity
          WHERE "projectId" = ${projectId} AND "externalId" = ANY(${externalIds}::text[])
          ORDER BY "externalId" FOR UPDATE`;
        const existing = new Map(rows.map((row) => [row.externalId, row]));
        const userIds = new Map<string, string>();
        const created: Prisma.SsoIdentityCreateManyInput[] = [];
        const accounts: Prisma.UserCreateManyInput[] = [];
        // In one order too, so two syncs adding the same new users can't deadlock on their inserts.
        for (const user of [...users].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0))) {
          // Lowercase, so a reader signing in by email finds them (portal-access.ts readerOf).
          const email = user.email === null ? null : user.email?.toLowerCase();
          const row = existing.get(user.externalId);
          const { properties, dropped } = mergeProperties(storedProperties(row?.properties ?? {}), user.properties ?? {});
          if (strict && dropped.length > 0) {
            throw new OperationError(400, "invalid_input", `“${user.externalId}” would have more than 50 properties`);
          }
          // Their `groups` property in its old column too, for instances from before it (see SsoIdentity.legacyGroups).
          const legacyGroups = user.properties && "groups" in user.properties ? groupsOf(properties.groups) : undefined;
          if (row) {
            userIds.set(user.externalId, row.userId);
            if (user.name !== undefined || user.image !== undefined) {
              await tx.user.update({ where: { id: row.userId }, data: { name: user.name, image: user.image } });
            }
            // A new address, and still no name given: one made up from the old address is made up from the new one
            // (never taken for a name they gave, as the widget's greeting would: widget-home.ts portalReaderHome).
            // In any case (an SSO token's address keeps its own: lib/sso.ts). A name their app gave that is just
            // the old address's first part can't be told from one made up, and follows too, as the greeting reads it.
            if (user.name === undefined && email !== undefined && email !== row.email) {
              const made = { equals: madeUpName(row.email), mode: "insensitive" as const };
              await tx.user.updateMany({ where: { id: row.userId, name: made }, data: { name: madeUpName(email) } });
            }
            if (email !== undefined || user.properties !== undefined) {
              await tx.ssoIdentity.update({ where: { id: row.id }, data: { email, properties, legacyGroups } });
            }
            continue;
          }
          const userId = randomUUID();
          userIds.set(user.externalId, userId);
          accounts.push({
            id: userId,
            name: user.name ?? madeUpName(email),
            image: user.image ?? null,
            email: placeholderEmail(projectId, user.externalId),
          });
          created.push({ projectId, externalId: user.externalId, userId, email: email ?? null, properties, legacyGroups });
        }
        await tx.user.createMany({ data: accounts });
        await tx.ssoIdentity.createMany({ data: created });
        return { userIds, created: created.length };
      },
      { timeout: 60_000 },
    );
  try {
    return await run();
  } catch (error) {
    // Lost a race with a concurrent first sight of someone: they exist now, so these details go on
    // them like any later ones.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return run();
  }
}

/** The User for someone from a project's app (see syncUsers), created on first sight. Used by SSO sign-ins and by API calls made on someone's behalf. */
export async function upsertProjectUser(projectId: string, externalId: string, details: Omit<UserDetails, "externalId">): Promise<string> {
  return (await syncUsers(projectId, [{ ...details, externalId }])).userIds.get(externalId)!;
}
