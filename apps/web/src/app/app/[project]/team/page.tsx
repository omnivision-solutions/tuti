import { type TeamRole, prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { InviteForm, RevokeInvitationButton } from "@/components/invitations";
import { LeaveProjectButton, RemoveMemberButton, RoleSelect } from "@/components/team-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { canAssignRole, canManageTeamMember, isAdminRole, ROLE_LABELS } from "@/lib/roles";
import { getMembership } from "@/server/membership";
import { getSession } from "@/server/session";

const ROLES: TeamRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default async function TeamPage(props: PageProps<"/app/[project]/team">) {
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
        select: { id: true, role: true, expiresAt: true, createdBy: { select: { name: true } } },
      })
    : [];
  const assignable = ROLES.filter((r) => canAssignRole(myRole, r));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">People who manage feedback in {project.name}.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "person" : "people"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          {members.map((member) => {
            const isMe = member.userId === session.user.id;
            const manageable = !isMe && canManageTeamMember(myRole, member.role);
            return (
              <div key={member.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <Avatar className="size-8">
                  {member.user.image && <AvatarImage src={member.user.image} alt="" />}
                  <AvatarFallback>{member.user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {member.user.name}
                    {isMe && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{member.user.email}</span>
                </div>
                {manageable ? (
                  <>
                    <RoleSelect
                      projectSlug={project.slug}
                      memberId={member.id}
                      role={member.role}
                      assignable={assignable}
                    />
                    <RemoveMemberButton projectSlug={project.slug} memberId={member.id} name={member.user.name} />
                  </>
                ) : (
                  <Badge variant={member.role === "OWNER" ? "default" : "secondary"}>{ROLE_LABELS[member.role]}</Badge>
                )}
              </div>
            );
          })}
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
            <CardDescription>Create a single-use link and send it to the person you&apos;re inviting.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <InviteForm projectSlug={project.slug} roles={assignable} />
            {invitations.length > 0 && (
              <div className="flex flex-col divide-y border-t pt-2">
                {invitations.map((invitation) => (
                  <div key={invitation.id} className="flex items-center gap-3 py-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm">Pending invite · {ROLE_LABELS[invitation.role]}</span>
                      <span className="text-xs text-muted-foreground">
                        Created by {invitation.createdBy.name} · expires {invitation.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    {canAssignRole(myRole, invitation.role) && (
                      <RevokeInvitationButton projectSlug={project.slug} invitationId={invitation.id} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
