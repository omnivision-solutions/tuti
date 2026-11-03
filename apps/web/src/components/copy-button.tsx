"use client";

import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Puts `value` on the clipboard, and says so. */
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy it. Your browser may not allow it here.");
  }
}

/** "Copy" for a value the team pastes elsewhere (a DNS record, a rule); `label` names it for screen readers. `wide`: a button that says it in words (an empty list's "Copy portal link"). */
export function CopyButton({ value, label, wide = false }: { value: string; label: string; wide?: boolean }) {
  return (
    <Button
      type="button"
      variant={wide ? "outline" : "ghost"}
      size={wide ? "default" : "xs"}
      aria-label={wide ? undefined : `Copy ${label}`}
      onClick={() => copyText(value)}
    >
      <CopyIcon />
      {wide ? `Copy ${label}` : "Copy"}
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
