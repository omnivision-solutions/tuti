"use client";

import { LinkIcon, ShareIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { copyText } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

// A post's round icon buttons (docs/design.md → Portals → Buttons): the secondary's grey fill on the portal.
const ROUND = "rounded-full text-muted-foreground";

/** A post's link to copy: a round icon button named "Copy link". */
export function CopyLinkButton({ url }: { url: string }) {
  return (
    <Button type="button" variant="outline" size="icon-lg" aria-label="Copy link" title="Copy link" className={ROUND} onClick={() => copyText(url)}>
      <LinkIcon />
    </Button>
  );
}

const noChange = () => () => {};

/** The device's share sheet (Web Share), where the browser has one; elsewhere nothing (Copy link is beside it). */
export function ShareButton({ url, title }: { url: string; title: string }) {
  const canShare = useSyncExternalStore(
    noChange,
    () => typeof navigator.share === "function",
    () => false,
  );
  if (!canShare) {
    return null;
  }
  return (
    // Closing the sheet without sharing rejects: nothing to say.
    <Button type="button" variant="outline" size="icon-lg" aria-label="Share" title="Share" className={ROUND} onClick={() => navigator.share({ url, title }).catch(() => undefined)}>
      <ShareIcon />
    </Button>
  );
}
