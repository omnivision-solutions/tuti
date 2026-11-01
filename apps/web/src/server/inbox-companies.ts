import { prisma } from "@tuti/db";

import { storedProperties } from "@/lib/user-properties";

type Row = {
  id: string;
  userId: string | null;
  email: string | null;
  emailVerified: boolean;
  user: { email: string; emailVerified: boolean; ssoIdentity: { properties: unknown } | null } | null;
};

/**
 * The company each conversation's person is at (Users' `company` property, when it's text), by conversation id: one of
 * the project's users, theirs; anyone else (signed in another way, or only an address) with a verified address one of
 * them has, that user's (the oldest's, when several share it), as Users counts them; never for the team's own accounts.
 * Identities' addresses are kept lowercase.
 */
export async function conversationCompanies(projectId: string, rows: Row[]): Promise<Map<string, string>> {
  const team = new Set((await prisma.teamMember.findMany({ where: { projectId }, select: { userId: true } })).map((m) => m.userId));
  const addressOf = (row: Row) =>
    row.user?.ssoIdentity || (row.userId && team.has(row.userId))
      ? undefined
      : row.user
        ? row.user.emailVerified
          ? row.user.email.toLowerCase()
          : undefined
        : row.emailVerified
          ? (row.email ?? undefined)
          : undefined;
  const addresses = rows.flatMap((row) => addressOf(row) ?? []);
  const byAddress = new Map<string, unknown>();
  const identities = addresses.length
    ? await prisma.ssoIdentity.findMany({
        where: { projectId, email: { in: addresses } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { email: true, properties: true },
      })
    : [];
  for (const identity of identities) {
    if (!byAddress.has(identity.email!)) {
      byAddress.set(identity.email!, storedProperties(identity.properties).company);
    }
  }
  const companies = new Map<string, string>();
  for (const row of rows) {
    const company = row.user?.ssoIdentity ? storedProperties(row.user.ssoIdentity.properties).company : byAddress.get(addressOf(row) ?? "");
    if (typeof company === "string" && company.trim()) {
      companies.set(row.id, company);
    }
  }
  return companies;
}
