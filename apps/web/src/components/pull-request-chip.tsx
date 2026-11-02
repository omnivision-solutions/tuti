"use client";

import { cn } from "cn";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { GithubMark } from "@/components/github-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, timeAgo } from "@/lib/format";

type PullRequest = { id: string; repo: string; number: number; url: string; title: string; author: string; mergedAt: string };

/** The author's GitHub avatar, their initial until it loads (or where GitHub can't be reached). */
function GithubAvatar({ login, className }: { login: string; className?: string }) {
  return (
    <Avatar aria-hidden className={cn("size-4", className)}>
      <AvatarImage src={`https://github.com/${encodeURIComponent(login)}.png?size=40`} alt="" />
      <AvatarFallback className="text-[0.5625rem]">{login.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/**
 * A merged pull request: GitHub's mark and "PR #130" in a pill, then its author's avatar and login and when it merged
 * (`compact`: the pill alone, for Autopilot's list). Hovering or clicking it (Enter, from the keyboard) shows its title,
 * a link to it on GitHub and one to its activity page.
 */
export function PullRequestChip({ projectSlug, pr, compact = false }: { projectSlug: string; pr: PullRequest; compact?: boolean }) {
  const merged = new Date(pr.mergedAt);
  return (
    <Popover>
      {/* Its name is what it shows ("PR #130 octo merged 1 month ago"), then its title. */}
      <PopoverTrigger
        openOnHover
        delay={300}
        className="relative z-10 inline-flex max-w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-medium text-foreground hover:bg-accent">
          <GithubMark className="size-3.5" />
          PR #{pr.number}
        </span>
        {!compact && (
          <>
            {" "}
            <GithubAvatar login={pr.author} />
            <span className="truncate text-foreground">{pr.author}</span>{" "}
            <span className="shrink-0 text-muted-foreground" suppressHydrationWarning>
              merged {timeAgo(merged)}
            </span>
          </>
        )}
        <span className="sr-only">: {pr.title}</span>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-2 p-3 text-sm">
        <p className="font-medium break-words">{pr.title}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GithubAvatar login={pr.author} />
          <span className="min-w-0 truncate">
            {pr.author} · <span title={formatDate(merged)}>merged {timeAgo(merged)}</span> · {pr.repo}#{pr.number}
          </span>
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
          <a href={pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
            Open on GitHub
            <ExternalLinkIcon className="size-3" />
          </a>
          <Link href={`/app/${projectSlug}/autopilot/activity/${pr.id}`} className="hover:underline">
            Its activity
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
