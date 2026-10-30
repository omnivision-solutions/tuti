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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS } from "@/lib/roles";
import { changeTeamRole, leaveProject, removeMember } from "@/server/team";

/** A member's ••• menu: Change role (the roles you may give) and Remove, which asks first. */
export function MemberActions({
  projectSlug,
  memberId,
  name,
  role,
  assignable,
}: {
  projectSlug: string;
  memberId: string;
  name: string;
  role: TeamRole;
  assignable: TeamRole[];
}) {
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Actions for ${name}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={role}
                onValueChange={(value) =>
                  startTransition(async () => {
                    const result = await changeTeamRole(projectSlug, memberId, String(value));
                    if (result.error) {
                      toast.error(result.error);
                    } else {
                      toast.success(`Role changed to ${ROLE_LABELS[value as TeamRole]}`);
                    }
                  })
                }
              >
                {assignable.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r} closeOnClick>
                    {ROLE_LABELS[r]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>They lose access to this project right away. You can invite them again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                startTransition(async () => {
                  const result = await removeMember(projectSlug, memberId);
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
    </>
  );
}

export function LeaveProjectButton({ projectSlug, projectName }: { projectSlug: string; projectName: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>Leave project</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {projectName}?</AlertDialogTitle>
          <AlertDialogDescription>You&apos;ll need a new invite to come back.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await leaveProject(projectSlug);
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
