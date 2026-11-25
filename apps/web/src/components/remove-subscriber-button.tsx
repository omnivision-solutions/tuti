"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { removeChangelogSubscriber } from "@/server/groups";

/** Users → Subscribers' Remove: stops the changelog's emails to one address, after asking. */
export function RemoveSubscriberButton({ projectSlug, email }: { projectSlug: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Removed, the row has no Remove to return to: the search box takes focus instead of the page's top.
  const removed = useRef(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Remove ${email}`}>
        Remove
      </Button>
      <AlertDialogContent finalFocus={() => (removed.current ? document.getElementById("subscribers-search") : true)}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Remove {email}?</AlertDialogTitle>
          <AlertDialogDescription>
            They stop getting your changelog by email, and any link to confirm it stops working.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeChangelogSubscriber(projectSlug, email);
                if (result.error) {
                  toast.error(result.error);
                  return;
                }
                removed.current = true;
                setOpen(false);
                toast.success(`${email} removed`);
              })
            }
          >
            Remove subscriber
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
