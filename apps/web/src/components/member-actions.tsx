"use client";

import type { MemberRole } from "@tuti/db";
import { useTransition } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_LABELS } from "@/lib/roles";
import { changeMemberRole, leaveWorkspace, removeMember } from "@/server/team";

export function RoleSelect({
  workspaceSlug,
  memberId,
  role,
  assignable,
}: {
  workspaceSlug: string;
  memberId: string;
  role: MemberRole;
  assignable: MemberRole[];
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Select
      items={ROLE_LABELS}
      value={role}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const result = await changeMemberRole(workspaceSlug, memberId, String(value));
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Role changed to ${ROLE_LABELS[value as MemberRole]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className="w-28" aria-label="Role">
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

export function RemoveMemberButton({ workspaceSlug, memberId, name }: { workspaceSlug: string; memberId: string; name: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Remove</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>They lose access to this workspace right away. You can invite them again later.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await removeMember(workspaceSlug, memberId);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${name} removed`);
                }
              })
            }
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function LeaveWorkspaceButton({ workspaceSlug, workspaceName }: { workspaceSlug: string; workspaceName: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>Leave workspace</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {workspaceName}?</AlertDialogTitle>
          <AlertDialogDescription>You&apos;ll need a new invite to come back.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await leaveWorkspace(workspaceSlug);
                if (result?.error) {
                  toast.error(result.error);
                }
              })
            }
          >
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
