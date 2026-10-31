import Link from "next/link";
import type { ReactNode } from "react";

import { asking } from "@/lib/format";

/** One of the post's properties in its sidebar: a label above its control. */
export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A post's voters (those postVoters reads), each with their company and Who's asking's number; past them, "N more" of `voteCount`. */
export function PostVoters({
  voters,
  voteCount,
  property,
}: {
  voters: { userId: string; name: string; company: string | null; value: number | null }[];
  voteCount: number;
  property: string | null;
}) {
  if (voters.length === 0) {
    return null;
  }
  return (
    <Property label="Voters">
      <ul aria-label="Voters" className="flex flex-col gap-1">
        {voters.map((voter) => (
          <li key={voter.userId} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 break-words">
              {voter.name}
              {voter.company && <span className="text-muted-foreground"> · {voter.company}</span>}
            </span>
            {voter.value !== null && property && <span className="shrink-0 text-muted-foreground tabular-nums">{asking(voter.value, property)}</span>}
          </li>
        ))}
      </ul>
      {voteCount > voters.length && <span className="text-xs text-muted-foreground">{voteCount - voters.length} more</span>}
    </Property>
  );
}

/** What shipped a post (howShipped): the Autopilot change that completed it, and the changelog entries listing it. */
export function PostShipped({
  projectSlug,
  change,
  entries,
}: {
  projectSlug: string;
  change: { id: string; repo: string; number: number } | null;
  entries: { number: number; title: string; publishedAt: Date | null }[];
}) {
  return (
    <>
      {change && (
        <Property label="Shipped by">
          <Link href={`/app/${projectSlug}/autopilot/${change.id}`} className="break-all hover:underline">
            {change.repo}#{change.number}
          </Link>
        </Property>
      )}
      {entries.length > 0 && (
        <Property label="Changelog">
          {entries.map((entry) => (
            <Link key={entry.number} href={`/app/${projectSlug}/changelog/${entry.number}`} className="break-words hover:underline">
              {entry.title}
              <span className="text-muted-foreground"> · {entry.publishedAt ? "Published" : "Draft"}</span>
            </Link>
          ))}
        </Property>
      )}
    </>
  );
}
