"use client";

import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";

/**
 * The upgrade prompt, shared by every page: opened by choosing a setting the plan doesn't include (docs/design.md,
 * Interaction). Its words come from the server (`upgradePrompt`); the setting stays as it was.
 */
export function UpgradeDialog({ prompt, open, onOpenChange }: { prompt: UpgradePrompt; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="leading-snug">{prompt.title}</DialogTitle>
          {prompt.note && <DialogDescription>{prompt.note}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{prompt.billingHref ? "Not now" : "Close"}</DialogClose>
          {prompt.billingHref && <Link href={prompt.billingHref} className={buttonVariants()}>See plans</Link>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
