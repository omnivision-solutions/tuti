"use client";

import type { TeamRole } from "@tuti/db";
import { MoreHorizontalIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_LABELS } from "@/lib/roles";
import { changeTeamRole, leaveProject, removeMember } from "@/server/team";

/** A member's role on their row, for whoever may change it: the roles they may give, saved as one is picked. */
export function MemberRoleSelect({ projectSlug, memberId, name, role, assignable }: { projectSlug: string; memberId: string; name: string; role: TeamRole; assignable: TeamRole[] }) {
  const [pending, startTransition] = useTransition();
  return (
    <Select
      items={ROLE_LABELS}
      value={role}
      disabled={pending}
      onValueChange={(value) => {
        if (value === role) {
          return;
        }
        startTransition(async () => {
          const result = await changeTeamRole(projectSlug, memberId, String(value));
          if (result.error) {
            toast.error(result.error);
          } else {
            const n = result.cancelledInvites ?? 0;
            const cancelled =
              n === 1
                ? ". The invite they sent for a role they can't give any more was cancelled."
                : n > 1
                  ? `. The ${n} invites they sent for roles they can't give any more were cancelled.`
                  : "";
            toast.success(`Role changed to ${ROLE_LABELS[value as TeamRole]}${cancelled}`);
          }
        });
      }}
    >
      <SelectTrigger className="w-30" aria-label={`Role of ${name}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {assignable.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A member's ⋯ menu. Someone else's: Remove, which asks first. Your own (`leave`): Leave project, which asks first too,
 * or says why you can't while you're the only owner (a project always keeps one).
 */
export function MemberActions({
  projectSlug,
  memberId,
  name,
  leave,
}: {
  projectSlug: string;
  memberId: string;
  name: string;
  leave?: { projectName: string; onlyOwner: boolean };
}) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Actions for ${name}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem variant="destructive" onClick={() => setAsking(true)}>
            {leave ? "Leave project" : "Remove"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        {leave?.onlyOwner ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>You&apos;re the only owner</AlertDialogTitle>
              <AlertDialogDescription>To leave, make someone else an owner first.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>OK</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{leave ? `Leave ${leave.projectName}?` : `Remove ${name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {leave
                  ? "The API keys you created for it stop working, the invites you sent are cancelled, and you'll need a new invite to come back."
                  : "They lose access to this project right away, the API keys they created stop working, and the invites they sent are cancelled. You can invite them again later."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  startTransition(async () => {
                    const result = leave ? await leaveProject(projectSlug) : await removeMember(projectSlug, memberId);
                    if (result?.error) {
                      toast.error(result.error);
                    } else if (!leave) {
                      toast.success(`${name} removed`);
                    }
                  })
                }
              >
                {leave ? "Leave" : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
