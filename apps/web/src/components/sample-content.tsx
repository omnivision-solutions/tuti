"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { addSampleContent, removeSampleContent } from "@/server/projects";

/** Home's "Add sample content" and "Remove sample content" (server/sample-content.ts): one click each. */
export function SampleContentButton({ projectSlug, remove = false }: { projectSlug: string; remove?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await (remove ? removeSampleContent : addSampleContent)(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(remove ? "Sample content removed" : "Sample content added");
          }
        })
      }
    >
      {remove ? (pending ? "Removing…" : "Remove sample content") : pending ? "Adding…" : "Add sample content"}
    </Button>
  );
}
