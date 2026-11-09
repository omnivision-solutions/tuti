"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { pageShortcut } from "@/lib/shortcut-keys";

/**
 * The team's post page: the newer and the older post (by number, merged ones skipped), as buttons in
 * its header and as K and J (not while typing, nor with a dialog, menu or list of choices open, the
 * page's More actions too: a letter there picks an option).
 */
export function PostSteps({ projectSlug, newer, older }: { projectSlug: string; newer: number | null; older: number | null }) {
  const router = useRouter();
  const href = (number: number) => `/app/${projectSlug}/p/${number}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!pageShortcut(event)) {
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
    // One control of two halves, so it doesn't read as voting.
    <span className="flex items-center divide-x rounded-lg border bg-card [&>*]:rounded-none [&>*:first-child]:rounded-l-lg [&>*:last-child]:rounded-r-lg">
      {step(newer, "Newer post", "K", <ChevronLeftIcon />)}
      {step(older, "Older post", "J", <ChevronRightIcon />)}
    </span>
  );
}
