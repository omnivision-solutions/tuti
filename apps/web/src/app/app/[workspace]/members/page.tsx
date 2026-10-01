import { type MemberRole, prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { LeaveWorkspaceButton, RemoveMemberButton, RoleSelect } from "@/components/member-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { canAssignRole, canManageMember, ROLE_LABELS } from "@/lib/roles";
import { getMembership } from "@/server/members";
import { getSession } from "@/server/session";

const ROLES: MemberRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default async function MembersPage(props: PageProps<"/app/[workspace]/members">) {
  const { workspace: slug } = await props.params;
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const { workspace, role: myRole } = membership;

  const members = await prisma.member.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, role: true, userId: true, user: { select: { name: true, email: true, image: true } } },
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">People who manage feedback in {workspace.name}.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "member" : "members"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          {members.map((member) => {
            const isMe = member.userId === session.user.id;
            const manageable = !isMe && canManageMember(myRole, member.role);
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
                      workspaceSlug={workspace.slug}
                      memberId={member.id}
                      role={member.role}
                      assignable={ROLES.filter((r) => canAssignRole(myRole, r))}
                    />
                    <RemoveMemberButton workspaceSlug={workspace.slug} memberId={member.id} name={member.user.name} />
                  </>
                ) : (
                  <Badge variant={member.role === "OWNER" ? "default" : "secondary"}>{ROLE_LABELS[member.role]}</Badge>
                )}
              </div>
            );
          })}
        </CardContent>
        <CardFooter className="justify-end">
          <LeaveWorkspaceButton workspaceSlug={workspace.slug} workspaceName={workspace.name} />
        </CardFooter>
      </Card>
    </>
  );
}
