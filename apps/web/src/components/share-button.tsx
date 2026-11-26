"use client";

import { LinkIcon, ShareIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { copyText } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

// A post's round icon buttons (docs/design.md → Portals → Buttons): the secondary's grey fill on the portal.
const ROUND = "rounded-full text-muted-foreground";

/** A post's link to copy: a round icon button named "Copy link". */
export function CopyLinkButton({ url }: { url: string }) {
  const t = useTranslations("feedback");
  const said = { copied: t("copied"), failed: t("copyFailed") };
  return (
    <Button type="button" variant="outline" size="icon-lg" aria-label={t("copyLink")} title={t("copyLink")} className={ROUND} onClick={() => copyText(url, said)}>
      <LinkIcon />
    </Button>
  );
}

const noChange = () => () => {};

/** The device's share sheet (Web Share), where the browser has one; elsewhere nothing (Copy link is beside it). */
export function ShareButton({ url, title }: { url: string; title: string }) {
  const t = useTranslations("feedback");
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
    <Button type="button" variant="outline" size="icon-lg" aria-label={t("share")} title={t("share")} className={ROUND} onClick={() => navigator.share({ url, title }).catch(() => undefined)}>
      <ShareIcon />
    </Button>
  );
}
