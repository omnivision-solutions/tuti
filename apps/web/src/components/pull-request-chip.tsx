"use client";

import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";
import { ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { Children, isValidElement, type ReactNode, useState } from "react";

import { GithubMark } from "@/components/github-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, timeAgo } from "@/lib/format";

type PullRequest = { id: string; repo: string; number: number; url: string; title: string; author: string; mergedAt: string };

/** The chip row's id: focus goes back to it once what a chip's popover did took the chip away. */
export const CHIPS_ID = "pull-requests";

/** The author's GitHub avatar, their initial until it loads (or where GitHub can't be reached). */
function GithubAvatar({ login, className }: { login: string; className?: string }) {
  return (
    <Avatar aria-hidden className={cn("size-4", className)}>
      <AvatarImage src={`https://github.com/${encodeURIComponent(login)}.png?size=40`} alt="" />
      <AvatarFallback className="text-[0.5625rem]">{login.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** What a review adds to a chip: its part's reason, state and actions in the popover (`children`), its popover's state, and whether its edit is out of date (an amber dot). */
export type ChipPart = {
  children?: ReactNode;
  outOfDate?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  finalFocus?: PopoverPrimitive.Popup.Props["finalFocus"];
};

/** The amber dot of a chip whose edit is out of date. */
function OutOfDate() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-kind-edit" />;
}

/** A pill (`pill`, then `after` beside it) that shows `popup` when hovered or clicked (Enter, from the keyboard). */
function Chip({ label, pill, after, popup, part }: { label: string; pill: ReactNode; after?: ReactNode; popup: ReactNode; part?: ChipPart }) {
  return (
    <Popover open={part?.open} onOpenChange={part?.onOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={300}
        aria-label={label}
        suppressHydrationWarning
        className="relative z-10 inline-flex max-w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-medium text-foreground hover:bg-accent">
          {pill}
          {part?.outOfDate && <OutOfDate />}
        </span>
        {after}
      </PopoverTrigger>
      <PopoverContent finalFocus={part?.finalFocus} className="flex w-80 flex-col gap-2 p-3 text-sm">
        {popup}
        {part?.children}
      </PopoverContent>
    </Popover>
  );
}

const links = "flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium";

/**
 * A merged pull request: GitHub's mark and "PR #130" in a pill (`byline`: then its author's avatar and login and when
 * it merged, for its activity page). Hovering or clicking it (Enter, from the keyboard) shows its title, who merged it
 * when, what `part` adds (a review's actions for it), a link to it on GitHub and one to its activity page.
 */
export function PullRequestChip({ projectSlug, pr, byline = false, part }: { projectSlug: string; pr: PullRequest; byline?: boolean; part?: ChipPart }) {
  const merged = new Date(pr.mergedAt);
  return (
    <Chip
      // Its name starts with what it shows ("PR #130 octo merged 1 month ago"), then its title: said as one (a visually
      // hidden title would be read after a pause).
      label={`PR #${pr.number}${byline ? ` ${pr.author} merged ${timeAgo(merged)}` : ""}${part?.outOfDate ? ", out of date" : ""}: ${pr.title}`}
      pill={
        <>
          <GithubMark className="size-3.5" />
          PR #{pr.number}
        </>
      }
      after={
        byline && (
          <>
            <GithubAvatar login={pr.author} />
            <span className="truncate text-foreground">{pr.author}</span>
            <span className="shrink-0 text-muted-foreground" suppressHydrationWarning>
              merged {timeAgo(merged)}
            </span>
          </>
        )
      }
      part={part}
      popup={
        <>
          <p className="font-medium break-words">{pr.title}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GithubAvatar login={pr.author} />
            <span className="min-w-0 truncate">
              {pr.author} · <span title={formatDate(merged)}>merged {timeAgo(merged)}</span> · {pr.repo}#{pr.number}
            </span>
          </p>
          {/* After the part's actions. */}
          <div className={cn(links, "order-last")}>
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
              Open on GitHub
              <ExternalLinkIcon className="size-3" />
            </a>
            <Link href={`/app/${projectSlug}/autopilot/activity/${pr.id}`} className="hover:underline">
              Its activity
            </Link>
          </div>
        </>
      }
    />
  );
}

/**
 * A Verify run, where a pull request's chip would be (its fix is a part of the article's update): a shield and
 * "Verify" in a pill, its popover saying the commit it checked and when, what `part` adds, and a link to the article's
 * verification history.
 */
export function VerifyChip({
  projectSlug,
  articleSlug,
  verification,
  part,
}: {
  projectSlug: string;
  articleSlug: string;
  verification: { repo: string; commit: string; createdAt: string };
  part?: ChipPart;
}) {
  const at = new Date(verification.createdAt);
  return (
    <Chip
      label={`Verify${part?.outOfDate ? ", out of date" : ""}: checked ${verification.commit.slice(0, 7)} ${timeAgo(at)}`}
      pill={
        <>
          <ShieldCheckIcon aria-hidden className="size-3.5" />
          Verify
        </>
      }
      part={part}
      popup={
        <>
          <p className="text-xs text-muted-foreground" suppressHydrationWarning>
            Checked {verification.repo}@{verification.commit.slice(0, 7)} · <span title={formatDate(at)}>{timeAgo(at)}</span>
          </p>
          <div className={cn(links, "order-last")}>
            <Link href={`/app/${projectSlug}/docs/${articleSlug}?verify`} className="hover:underline">
              Its history
            </Link>
          </div>
        </>
      }
    />
  );
}

const SHOWN = 3;

/**
 * A review's chips (`outOfDate`: those whose edit is), the first three then "+N more", which shows the rest (and
 * "Fewer", them hidden again). The "+N more" chip has the amber dot when one it hides is out of date.
 */
export function PullRequestChips({ children, outOfDate = [] }: { children: ReactNode; outOfDate?: boolean[] }) {
  const [all, setAll] = useState(false);
  const chips = Children.toArray(children);
  const hidden = chips.length - SHOWN;
  const hiddenOutOfDate = outOfDate.slice(SHOWN).filter(Boolean).length;
  return (
    // role="list": Safari drops a list's role (and its name) once its markers are off, as Tailwind's preflight does.
    <ul role="list" id={CHIPS_ID} tabIndex={-1} aria-label="Pull requests" className="flex flex-wrap gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {chips.map(
        (chip, i) =>
          (all || i < SHOWN) && (
            <li key={isValidElement(chip) ? chip.key : i} className={cn("flex min-w-0", i >= SHOWN && "animate-in duration-200 fade-in-0 slide-in-from-left-2 motion-reduce:animate-none")}>
              {chip}
            </li>
          ),
      )}
      {hidden > 0 && (
        <li className="flex">
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {all ? "Fewer" : `+${hidden} more`}
            {!all && hiddenOutOfDate > 0 && (
              <>
                <OutOfDate />
                <span className="sr-only">, {hiddenOutOfDate} out of date</span>
              </>
            )}
          </button>
        </li>
      )}
    </ul>
  );
}
