import type { ConversationStatus, PostStatus } from "@tuti/db";
import Link from "next/link";
import type { ReactNode } from "react";

import { PostStatusBadge } from "@/components/post-status-badge";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName } from "@/lib/conversation-statuses";
import { asking } from "@/lib/format";
import type { PropertyFormats } from "@/lib/property-formats";

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
  formats,
}: {
  voters: { userId: string; name: string; company: string | null; value: number | null }[];
  voteCount: number;
  property: string | null;
  /** The team's names and formats for its users' properties. */
  formats: PropertyFormats;
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
            {voter.value !== null && property && <span className="max-w-1/2 text-right break-all text-muted-foreground tabular-nums">{asking(voter.value, property, formats)}</span>}
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
