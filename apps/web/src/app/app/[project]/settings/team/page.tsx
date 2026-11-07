import { type TeamRole, prisma } from "@tuti/db";
import { pendingInvitation } from "@tuti/jobs";
import { teamLimit } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InviteForm, RevokeInvitationButton, UnsentInvitations } from "@/components/invitations";
import { ItemList, ItemRow } from "@/components/item-list";
import { LeaveProjectButton, MemberActions } from "@/components/team-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { canAssignRole, canManageTeamMember, isAdminRole, ROLE_LABELS } from "@/lib/roles";
import { inviteNote } from "@/lib/verify-email";
import { getMembership } from "@/server/membership";
import { getSession } from "@/server/session";

const ROLES: TeamRole[] = ["OWNER", "ADMIN", "MEMBER"];

/** Settings → Team & roles: the team (every member sees it, and can leave), roles and invites (owners' and admins'). */
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
  const assignable = ROLES.filter((r) => canAssignRole(myRole, r));
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } });
  const limit = teamLimit(plan);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Team & roles</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "person" : "people"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemList>
            {members.map((member) => {
              const isMe = member.userId === session.user.id;
              const manageable = !isMe && canManageTeamMember(myRole, member.role);
              return (
                <ItemRow
                  key={member.id}
                  leading={
                    <Avatar className="size-8">
                      {member.user.image && <AvatarImage src={member.user.image} alt="" />}
                      <AvatarFallback>{member.user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                  }
                  title={
                    <>
                      {member.user.name}
                      {isMe && <span className="text-muted-foreground"> (you)</span>}
                    </>
                  }
                  meta={<span className="break-all">{member.user.email}</span>}
                  actions={
                    <>
                      <Badge variant={member.role === "OWNER" ? "default" : "secondary"}>{ROLE_LABELS[member.role]}</Badge>
                      {manageable && (
                        <MemberActions
                          projectSlug={project.slug}
                          memberId={member.id}
                          name={member.user.name}
                          role={member.role}
                          assignable={assignable}
                        />
                      )}
                    </>
                  }
                />
              );
            })}
          </ItemList>
        </CardContent>
        <CardFooter className="justify-end">
          {isOnlyOwner ? (
            <p className="text-sm text-muted-foreground">
              You&apos;re the only owner. To leave, make someone else an owner first.
            </p>
          ) : (
            <LeaveProjectButton projectSlug={project.slug} projectName={project.name} />
          )}
        </CardFooter>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Invite people</CardTitle>
            <CardDescription>
              {inviteNote(session.user)}
              {limit !== null && (
                <>
                  {" "}
                  Projects on the Free plan have up to {limit} team members, invites included ({members.length + invitations.length} now);{" "}
                  <Link href={`/app/${project.slug}/settings/billing`} className="underline underline-offset-4">
                    upgrade
                  </Link>{" "}
                  for more.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <InviteForm projectSlug={project.slug} roles={assignable} />
            {sent.length > 0 && (
              // Where focus goes once the last invite from Featurebase is sent (UnsentInvitations).
              <div id="pending-invites" tabIndex={-1} className="outline-none">
                <ItemList className="border-t pt-2.5" aria-label="Pending invites">
                  {sent.map((invitation) => (
                    <ItemRow
                      key={invitation.id}
                      title={`${invitation.email ?? "Invite link"} · ${ROLE_LABELS[invitation.role]}`}
                      meta={`Created by ${invitation.createdBy.name} · expires ${invitation.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                      actions={
                        canAssignRole(myRole, invitation.role) && (
                          <RevokeInvitationButton projectSlug={project.slug} invitationId={invitation.id} />
                        )
                      }
                    />
                  ))}
                </ItemList>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <UnsentInvitations
          projectSlug={project.slug}
          note={`Your team in Featurebase, invited as members. Nothing has been emailed: send the ones you want here.${limit !== null ? " Until you remove them, they count toward your plan's team members." : ""}`}
          invitations={unsent.map((invitation) => ({
            id: invitation.id,
            email: invitation.email!,
            title: `${invitation.email} · ${ROLE_LABELS[invitation.role]}`,
            meta: `Imported ${invitation.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })} by ${invitation.createdBy.name}`,
            manageable: canAssignRole(myRole, invitation.role),
          }))}
        />
      )}
    </>
  );
}
