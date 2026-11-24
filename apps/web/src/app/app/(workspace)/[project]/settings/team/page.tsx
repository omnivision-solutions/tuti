import type { Metadata } from "next";
import { type TeamRole, prisma } from "@tuti/db";
import { pendingInvitation } from "@tuti/jobs";
import { planDisplay, roomierPlan, teamLimit } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InviteDialog, RevokeInvitationButton, UnsentInvitations } from "@/components/invitations";
import { ItemList, ItemRow } from "@/components/item-list";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { MemberActions, MemberRoleSelect } from "@/components/team-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatDay } from "@/lib/format";
import { oneTool } from "@/lib/import-parts";
import { canAssignRole, canManageTeamMember, isAdminRole, ROLE_LABELS } from "@/lib/roles";
import { getMembership } from "@/server/membership";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Team & roles · Settings" };

const ROLES: TeamRole[] = ["OWNER", "ADMIN", "MEMBER"];

/**
 * Settings → Team & roles: the team (every member sees it, and can leave from their own row's menu), then, for owners
 * and admins, each role as a dropdown, Invite people and the invites still pending.
 */
export default async function TeamPage(props: PageProps<"/app/[project]/settings/team">) {
  const { project: slug } = await props.params;
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const { project, role: myRole } = membership;

  const members = await prisma.teamMember.findMany({
    where: { projectId: project.id },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, role: true, userId: true, user: { select: { name: true, email: true, image: true } } },
  });
  const isAdmin = isAdminRole(myRole);
  // A project always keeps an owner, so the only owner can't leave.
  const isOnlyOwner = myRole === "OWNER" && members.filter((m) => m.role === "OWNER").length === 1;
  const invitations = isAdmin
    ? await prisma.invitation.findMany({
        where: { projectId: project.id, ...pendingInvitation() },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, role: true, expiresAt: true, sentAt: true, createdAt: true, createdBy: { select: { name: true } } },
      })
    : [];
  // An import's invitations (docs/plan.md, Switching from Featurebase) wait apart until someone sends them.
  const sent = invitations.filter((invitation) => invitation.sentAt);
  const unsent = invitations.filter((invitation) => !invitation.sentAt && invitation.email);
  // The tool they came from, by the import's record of each pending one: sent ones too, so the card still names it while
  // it shows the links of those just sent (a server without email).
  const tool = oneTool(
    (await prisma.importedRecord.findMany({ where: { projectId: project.id, kind: "invite", localId: { in: invitations.map((invitation) => invitation.id) } }, select: { source: true } })).map(
      (record) => record.source,
    ),
  );
  const assignable = ROLES.filter((r) => canAssignRole(myRole, r));
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } });
  const limit = teamLimit(plan);

  return (
    <SettingsPane title="Team & roles">
      <SettingsCard
        title="Team"
        count={members.length}
        action={
          isAdmin && (
            <InviteDialog
              projectSlug={project.slug}
              roles={assignable}
              note={
                limit !== null && (
                  <>
                    Projects on the {planDisplay(plan).name} plan have up to {limit} team members, invites included ({members.length + invitations.length} now)
                        {roomierPlan(plan, teamLimit) ? (
                          <>
                            ;{" "}
                            <Link href={`/app/${project.slug}/settings/billing`} className="underline underline-offset-4">
                              upgrade
                            </Link>{" "}
                            for more.
                          </>
                        ) : (
                      "."
                    )}
                  </>
                )
              }
            />
          )
        }
      >
        <ItemList>
          {members.map((member) => {
            const isMe = member.userId === session.user.id;
            const manageable = !isMe && canManageTeamMember(myRole, member.role);
            return (
              // On a phone the dropdown goes under the name, so the address keeps the row's width; a badge is small enough to stay.
              <li key={member.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 @min-[34rem]/settings:flex-nowrap @min-[34rem]/settings:px-5">
                <Avatar className="size-8">
                  {member.user.image && <AvatarImage src={member.user.image} alt="" />}
                  <AvatarFallback>{member.user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium break-words">
                    {member.user.name}
                    {isMe && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <span className="text-xs break-all text-muted-foreground">{member.user.email}</span>
                </div>
                {manageable ? (
                  <div className="order-last basis-full pl-11 @min-[34rem]/settings:order-none @min-[34rem]/settings:basis-auto @min-[34rem]/settings:pl-0">
                    <MemberRoleSelect projectSlug={project.slug} memberId={member.id} name={member.user.name} role={member.role} assignable={assignable} />
                  </div>
                ) : (
                  <Badge variant={member.role === "OWNER" ? "default" : "secondary"}>{ROLE_LABELS[member.role]}</Badge>
                )}
                {(manageable || isMe) && (
                  <MemberActions
                    projectSlug={project.slug}
                    memberId={member.id}
                    name={member.user.name}
                    leave={isMe ? { projectName: project.name, onlyOwner: isOnlyOwner } : undefined}
                  />
                )}
              </li>
            );
          })}
        </ItemList>
      </SettingsCard>

      {sent.length > 0 && (
        <SettingsCard title="Pending invites" count={sent.length}>
          {/* Where focus goes once the last imported invite is sent (UnsentInvitations). */}
          <div id="pending-invites" tabIndex={-1} className="rounded-xl outline-none">
            <ItemList aria-label="Pending invites">
              {sent.map((invitation) => (
                <ItemRow
                  key={invitation.id}
                  className="px-4 first:pt-3 last:pb-3 @min-[34rem]/settings:px-5"
                  title={`${invitation.email ?? "Invite link"} · ${ROLE_LABELS[invitation.role]}`}
                  meta={`Created by ${invitation.createdBy.name} · expires ${formatDay(invitation.expiresAt)}`}
                  actions={
                    canAssignRole(myRole, invitation.role) && (
                      <RevokeInvitationButton projectSlug={project.slug} invitationId={invitation.id} />
                    )
                  }
                />
              ))}
            </ItemList>
          </div>
        </SettingsCard>
      )}

      {isAdmin && (
        <UnsentInvitations
          projectSlug={project.slug}
          tool={tool}
          counted={limit !== null}
          invitations={unsent.map((invitation) => ({
            id: invitation.id,
            email: invitation.email!,
            title: `${invitation.email} · ${ROLE_LABELS[invitation.role]}`,
            meta: `Imported ${formatDay(invitation.createdAt)} by ${invitation.createdBy.name}`,
            manageable: canAssignRole(myRole, invitation.role),
          }))}
        />
      )}
    </SettingsPane>
  );
}
