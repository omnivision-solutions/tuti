"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { errorMessage, useTRPCClient } from "@/components/trpc";

/** "Email me new conversations", in the Inbox's options: the signed-in teammate's own choice. */
export function NewConversationEmailsButton({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenuItem
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await trpc.inbox.newConversationEmails.mutate({ project: projectSlug, on: !on });
          } catch (error) {
            toast.error(errorMessage(error));
            return;
          }
          toast.success(on ? "You won't be emailed new conversations" : "You'll be emailed new conversations");
          router.refresh();
        })
      }
    >
      {on ? "Stop emailing me new conversations" : "Email me new conversations"}
    </DropdownMenuItem>
  );
}
