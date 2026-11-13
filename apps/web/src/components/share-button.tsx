"use client";

import { LinkIcon, ShareIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { copyText } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

/** A post's link to copy: in words in its rail, an icon (named "Copy link") in the phone's row of actions. */
export function CopyLinkButton({ url }: { url: string }) {
  return (
    <Button type="button" variant="ghost" aria-label="Copy link" className="text-muted-foreground max-lg:size-10 max-lg:border max-lg:px-0 portal:max-lg:border-transparent portal:max-lg:bg-secondary portal:max-lg:hover:bg-secondary-hover" onClick={() => copyText(url)}>
      <LinkIcon />
      <span className="max-lg:hidden">Copy link</span>
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
    <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => navigator.share({ url, title }).catch(() => undefined)}>
      <ShareIcon />
      Share
    </Button>
  );
}
