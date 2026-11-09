import type { ConversationStatus, PostStatus } from "@tuti/db";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { PostStatusBadge } from "@/components/post-status-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { VoterFaces } from "@/components/voter-faces";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName } from "@/lib/conversation-statuses";
import { asking, initial } from "@/lib/format";
import type { PropertyFormats } from "@/lib/property-formats";

/** One of the post's properties in its sidebar: a label above its control. */
export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="group-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A property's select drawn as its value until it's hovered or focused, for rows of properties (a post's page): the
 * row reads as "Owner  Sam Rivera", not as a form.
 */
export const QUIET_TRIGGER =
  "h-8 border-transparent bg-transparent shadow-none -ml-2.5 w-[calc(100%+0.625rem)] hover:bg-muted dark:bg-transparent dark:hover:bg-muted aria-expanded:bg-muted [&>svg]:opacity-0 hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100";

/**
 * One of the post's properties as a row on its page: its icon and label on the left, its value (a quiet select) on the
 * right, with `hint` under the value.
 */
export function PropertyRow({ icon: Icon, label, hint, children }: { icon: LucideIcon; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2">
      <span className="flex h-8 items-center gap-2 text-muted-foreground">
        <Icon aria-hidden className="size-4 shrink-0" />
        {label}
      </span>
      <div className="min-w-0">{children}</div>
      {hint && <div className="col-start-2 pb-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** How many voters a post's sidebar lists by name before "N more". */
export const VOTERS_NAMED = 3;

/**
 * A post's voters (those postVoters reads): the first few, each with their face, company and Who's asking's number;
 * past them, "N more" of `voteCount`, the rest of those read behind it.
 */
export function PostVoters({
  voters,
  voteCount,
  property,
  formats,
  total,
}: {
  voters: { userId: string; name: string; image: string | null; company: string | null; value: number | null }[];
  voteCount: number;
  property: string | null;
  /** The team's names and formats for its users' properties. */
  formats: PropertyFormats;
  /** Who's asking's total over them (voterTotals), in the heading. */
  total?: number;
}) {
  if (voters.length === 0) {
    return null;
  }
  const row = (voter: (typeof voters)[number]) => (
    <li key={voter.userId} className="flex items-center gap-2">
      <Avatar size="sm" className="size-6" aria-hidden>
        {voter.image && <AvatarImage src={voter.image} alt="" />}
        <AvatarFallback className="text-xs">{initial(voter.name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate" title={voter.company ? `${voter.name} · ${voter.company}` : voter.name}>
        {voter.name}
        {voter.company && <span className="text-muted-foreground"> · {voter.company}</span>}
      </span>
      {voter.value !== null && property && <span className="max-w-1/2 text-right break-words text-muted-foreground tabular-nums">{asking(voter.value, property, formats)}</span>}
    </li>
  );
  const rest = voteCount - VOTERS_NAMED;
  return (
    <Property label={`Voters${total !== undefined && property ? ` · ${asking(total, property, formats)}` : ""}`}>
      {/* Their faces at a glance (Canny's way), then the first few by name. */}
      <VoterFaces voters={voters.slice(0, 6).map((voter) => ({ ...voter, id: voter.userId }))} count={voteCount} label={`${voteCount} ${voteCount === 1 ? "voter" : "voters"}`} />
      <ul aria-label="Voters" className="flex flex-col gap-2 pt-2">
        {voters.slice(0, VOTERS_NAMED).map(row)}
      </ul>
      {rest > 0 &&
        (voters.length > VOTERS_NAMED ? (
          <details className="group/more">
            <summary className="w-fit cursor-pointer list-none pt-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline [&::-webkit-details-marker]:hidden">
              <span className="group-open/more:hidden">{rest} more</span>
              <span className="hidden group-open/more:inline">Fewer</span>
            </summary>
            <ul aria-label="More voters" className="flex flex-col gap-2 pt-2">
              {voters.slice(VOTERS_NAMED).map(row)}
            </ul>
            {voteCount > voters.length && <span className="mt-2 block text-xs text-muted-foreground">and {voteCount - voters.length} more</span>}
          </details>
        ) : (
          <span className="pt-1 text-xs text-muted-foreground">{rest} more</span>
        ))}
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
          <Link href={`/app/${projectSlug}/autopilot/activity/${change.id}`} className="break-all hover:underline">
            {change.repo}#{change.number}
          </Link>
        </Property>
      )}
      {entries.length > 0 && (
        <Property label="Changelog">
          <ul aria-label="Changelog entries" className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <li key={entry.number} className="flex items-start justify-between gap-2">
                <Link href={`/app/${projectSlug}/changelog/${entry.number}`} className="min-w-0 break-words hover:underline">
                  {entry.title}
                </Link>
                <Badge variant={entry.publishedAt ? "secondary" : "outline"} className="shrink-0">
                  {entry.publishedAt ? "Published" : "Draft"}
                </Badge>
              </li>
            ))}
          </ul>
        </Property>
      )}
    </>
  );
}

/** Posts like it (postsLike), each with its status and votes: maybe the same idea, to merge from its menu. */
export function PostsLike({ projectSlug, posts }: { projectSlug: string; posts: { id: string; number: number; title: string; voteCount: number; status: PostStatus }[] }) {
  if (posts.length === 0) {
    return null;
  }
  return (
    <Property label="Similar">
      <ul aria-label="Similar posts" className="flex flex-col gap-2">
        {posts.map((post) => (
          <li key={post.id} className="flex flex-col gap-0.5">
            <Link href={`/app/${projectSlug}/p/${post.number}`} className="break-words hover:underline">
              {post.title}
            </Link>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <PostStatusBadge status={post.status} />
              {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
            </span>
          </li>
        ))}
      </ul>
    </Property>
  );
}

/** How many of a post's linked conversations its sidebar lists, the latest linked first. */
export const CONVERSATIONS_SHOWN = 10;

/**
 * The conversations linked to the post (from the Inbox), the latest linked first: each opens in the Inbox, with who
 * it's with and its status; past CONVERSATIONS_SHOWN, "N more" of `count`.
 */
export function PostConversations({
  projectSlug,
  conversations,
  count,
}: {
  projectSlug: string;
  conversations: { number: number; subject: string; status: ConversationStatus; person: string }[];
  count: number;
}) {
  if (conversations.length === 0) {
    return null;
  }
  return (
    <Property label="Conversations">
      <ul aria-label="Conversations" className="flex flex-col gap-2">
        {conversations.map((conversation) => (
          <li key={conversation.number} className="flex flex-col gap-0.5">
            <Link href={`/app/${projectSlug}/inbox/${conversation.number}`} className="break-words hover:underline">
              {conversation.subject}
            </Link>
            <span className="text-xs break-words text-muted-foreground">
              {conversation.person} · {CONVERSATION_STATUS_LABELS[conversation.status.toLowerCase() as ConversationStatusName]}
            </span>
          </li>
        ))}
      </ul>
      {count > conversations.length && <span className="text-xs text-muted-foreground">{count - conversations.length} more</span>}
    </Property>
  );
}
