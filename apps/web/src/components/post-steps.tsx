"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";

import { Button, buttonVariants } from "@/components/ui/button";

/** Whether a key press is someone typing (in a field, an editor), not a shortcut. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The team's post page: the newer and the older post (as Feedback lists them, newest first), as
 * buttons in its header and as K and J (not while typing, nor with a dialog open).
 */
export function PostSteps({ projectSlug, newer, older }: { projectSlug: string; newer: number | null; older: number | null }) {
  const router = useRouter();
  const href = (number: number) => `/app/${projectSlug}/p/${number}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector('[role="dialog"]')) {
        return;
      }
      const to = event.key === "k" ? newer : event.key === "j" ? older : null;
      if (to !== null) {
        router.push(`/app/${projectSlug}/p/${to}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, projectSlug, newer, older]);

  const step = (to: number | null, label: string, key: string, icon: ReactNode) =>
    to === null ? (
      <Button variant="ghost" size="icon-sm" disabled aria-label={label}>
        {icon}
      </Button>
    ) : (
      <Link href={href(to)} aria-label={label} title={`${label} (${key})`} className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
        {icon}
      </Link>
    );

  return (
    <span className="flex items-center">
      {step(newer, "Newer post", "K", <ChevronUpIcon />)}
      {step(older, "Older post", "J", <ChevronDownIcon />)}
    </span>
  );
}
