"use client";

import { useState, useTransition } from "react";
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
import { addSampleContent, removeSampleContent } from "@/server/projects";

/** Home's "Add sample content" (server/sample-content.ts): one click. */
export function AddSampleContent({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await addSampleContent(projectSlug);
          if (result.error) {
            toast.error(result.error);
            return;
          }
          toast.success("Sample content added");
        })
      }
    >
      {pending ? "Adding…" : "Add sample content"}
    </Button>
  );
}

/** Home's "Remove sample content": it can't be undone, and takes what the team added to sample items, so it asks first. */
export function RemoveSampleContent({ projectSlug }: { projectSlug: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Remove sample content
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the sample content?</AlertDialogTitle>
          <AlertDialogDescription>
            Everything labelled Sample is deleted, with any changes, votes, comments and replies you added to it. Your own posts, articles and updates stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeSampleContent(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                  return;
                }
                setOpen(false);
                toast.success("Sample content removed");
              })
            }
          >
            {pending ? "Removing…" : "Remove sample content"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
