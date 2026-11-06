import type { Prisma } from "@tuti/db";
import { teamLimit } from "@tuti/shared";

import type { FeaturebaseAdmin } from "./featurebase";
import { ALREADY_HERE, type ImportJob, type StepPage, tally } from "./imports";
import { generateInvitationToken, hashInvitationToken, pendingInvitation, teamPlacesTaken, UNSENT_EXPIRY } from "./invitations";

/**
 * Team (docs/plan.md, Switching from Featurebase, I6): every Featurebase admin with an email becomes an invitation to the
 * project, as a member (Featurebase's roles are its own names, which can't be mapped), not sent: an owner or admin
 * reviews and sends them from Team & roles (`sentAt` null; its token is one nobody has, and it "expired" long ago for the
 * release before, so it can't be accepted till then: UNSENT_EXPIRY). Unsent, it waits till it's sent or removed. Left out, and counted: whoever started the import, people already on the team (by verified address) or
 * already invited, admins without an address, and those past the plan's room for the team. An admin is remembered
 * (ImportedRecord "invite"), so another import never invites them again, even once the team removed the invitation.
 */

type Tx = Prisma.TransactionClient;

/** Why an admin wasn't invited, as the summary says it after "2 invitations". */
export const TEAM_LEFT_OUT = {
  // Stored, and shown to anyone who reads the summary (Home, imports.get): true whoever reads it.
  you: "for whoever ran the import",
  member: "for people already on the team",
  invited: "for people already invited",
  noEmail: "for admins without an email",
  full: "past the plan's team limit (invite them after upgrading)",
} as const;

/** The team's one page: Featurebase's admins (one list, unpaged), read before the page's transaction. */
export async function teamPage(job: ImportJob): Promise<StepPage> {
  const { data: admins } = await job.featurebase.get<{ data: FeaturebaseAdmin[] }>("/admins");
  return { next: null, save: (tx) => inviteAdmins(tx, job, admins) };
}

async function inviteAdmins(tx: Tx, job: ImportJob, admins: FeaturebaseAdmin[]) {
  const { projectId } = job;
  const leaveOut = (reason: string) => tally(job.counts, "invitations", reason);
  const recorded = new Set(
    (await tx.importedRecord.findMany({ where: { projectId, source: job.source, kind: "invite", externalId: { in: admins.map((admin) => admin.id) } }, select: { externalId: true } })).map((row) => row.externalId),
  );
  // Who invites them: whoever started the import, else (gone since) the project's first owner.
  const by =
    (job.startedById && (await tx.user.findUnique({ where: { id: job.startedById }, select: { id: true, email: true } }))) ||
    (await tx.teamMember.findFirst({ where: { projectId, role: "OWNER" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { user: { select: { id: true, email: true } } } }))?.user;
  const members = new Set(
    (await tx.teamMember.findMany({ where: { projectId, user: { emailVerified: true } }, select: { user: { select: { email: true } } } })).map((member) => member.user.email.toLowerCase()),
  );
  // Pending invites, sent or not, as Team & roles lists them; addresses the same email twice in Featurebase join them.
  const invited = new Set(
    (await tx.invitation.findMany({ where: { projectId, ...pendingInvitation(), email: { not: null } }, select: { email: true } })).map((invitation) => invitation.email!),
  );
  const { plan } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
  const limit = teamLimit(plan);
  let taken = limit === null ? 0 : await teamPlacesTaken(tx, projectId);
  for (const admin of admins) {
    const email = admin.email?.trim().toLowerCase();
    if (recorded.has(admin.id)) {
      leaveOut(ALREADY_HERE);
    } else if (!email) {
      leaveOut(TEAM_LEFT_OUT.noEmail);
    } else if (!by || by.email.toLowerCase() === email) {
      leaveOut(TEAM_LEFT_OUT.you);
    } else if (members.has(email)) {
      leaveOut(TEAM_LEFT_OUT.member);
    } else if (invited.has(email)) {
      leaveOut(TEAM_LEFT_OUT.invited);
    } else if (limit !== null && taken >= limit) {
      leaveOut(TEAM_LEFT_OUT.full);
    } else {
      const invitation = await tx.invitation.create({
        data: { projectId, email, role: "MEMBER", tokenHash: hashInvitationToken(generateInvitationToken()), createdById: by.id, expiresAt: UNSENT_EXPIRY, sentAt: null },
        select: { id: true },
      });
      await tx.importedRecord.create({ data: { projectId, source: job.source, kind: "invite", externalId: admin.id, localId: invitation.id } });
      invited.add(email);
      taken++;
      tally(job.counts, "invitations", null);
    }
  }
}
