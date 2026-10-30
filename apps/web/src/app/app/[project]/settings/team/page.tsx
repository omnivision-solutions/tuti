import { type TeamRole, prisma } from "@tuti/db";
import { teamLimit } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InviteForm, RevokeInvitationButton } from "@/components/invitations";
import { ItemList, ItemRow } from "@/components/item-list";
import { LeaveProjectButton, MemberActions } from "@/components/team-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { canAssignRole, canManageTeamMember, isAdminRole, ROLE_LABELS } from "@/lib/roles";
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
        where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, role: true, expiresAt: true, createdBy: { select: { name: true } } },
      })
    : [];
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
              We&apos;ll email them an invite. Only that email address can accept it.
              {limit !== null && (
                <>
                  {" "}
                  Projects on the free plan have up to {limit} team members, invites included ({members.length + invitations.length} now);{" "}
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
            {invitations.length > 0 && (
              <ItemList className="border-t pt-2.5">
                {invitations.map((invitation) => (
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
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
