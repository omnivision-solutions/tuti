"use client";

import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** "Copy" for a value the team pastes elsewhere (a DNS record, a rule); `label` names it for screen readers. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success("Copied");
        } catch {
          toast.error("Couldn't copy it. Your browser may not allow it here.");
        }
      }}
    >
      <CopyIcon />
      Copy
    </Button>
  );
}

/** A value to copy, labelled, in a muted box: a DNS record's host, a rule's target. */
export function CopyField({ label, value, name }: { label: string; value: string; name: string }) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={value} label={name} />
      </div>
      <code className="block px-3 py-2 text-sm break-all">{value}</code>
    </div>
  );
}
