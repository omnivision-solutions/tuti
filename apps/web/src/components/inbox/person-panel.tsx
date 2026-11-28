import type { PostStatus } from "@tuti/db";
import Link from "next/link";
import { UserIcon, MessagesSquareIcon } from "lucide-react";
import { DetailSection } from "@/components/inbox/detail-section";
import type { ReactNode } from "react";

import { inboxHref, type View } from "@/components/inbox/inbox-panes";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Badge } from "@/components/ui/badge";
import { ConversationStatusText } from "./conversation-status";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_STYLES, type ConversationStatusName } from "@/lib/conversation-statuses";
import { cn } from "@/lib/utils";
import type { PersonPanelData } from "@/server/operations/conversation-person";
import { ViewerDate } from "@/components/inbox/viewer-date";

/** A part of what they did. `card`: on their own page (a pane), a part of its own with a heading. */
function Section({ title, count, card = false, big = false, children }: { title: string; count?: number; card?: boolean; big?: boolean; children: ReactNode }) {
  if (card) {
    return (
      <section aria-label={title} className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-[1rem] font-semibold">
          {title}
          {count !== undefined && <span className="rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {children}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h2 className={big ? "mb-1 text-[1rem] font-semibold" : "text-xs font-medium text-muted-foreground"}>
        {title}
        {count !== undefined && count > 0 && <span className="tabular-nums"> · {count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** Links to what they did; `rows`: on their own page, rows with lines between them. */
function Links({ items, empty, rows = false }: { items: { href: string; title: string; meta: ReactNode }[]; empty: string; rows?: boolean }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className={rows ? "-my-2 flex flex-col divide-y" : "flex flex-col gap-1"}>
      {items.map((item) => (
        <li key={item.href} className={cn("flex min-w-0 items-baseline justify-between gap-2 text-sm", rows && "items-center py-2.5")}>
          <Link href={item.href} className="min-w-0 break-words hover:underline">
            {item.title}
          </Link>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">{item.meta}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Who the conversation is with, beside it: someone Tuti knows (their app's id, properties, groups,
 * posts and votes) or just an email address, and their other conversations.
 */
export function PersonPanel({
  slug,
  details,
  besides,
  inbox,
  page = false,
}: {
  slug: string;
  /** Who they are and what they did (personPanel: beside a conversation, inbox.conversation's `panel`). */
  details: PersonPanelData;
  /** The conversation it's beside, left out of theirs. */
  besides?: number;
  /**
   * Beside a conversation in the Inbox: the view its list shows, and who's looking. Their conversations in that view
   * open beside it there; the others in the Inbox's first view (one without them would have no row for it).
   */
  inbox?: { view: View; pages: number; q: string };
  /** On their own page (Users): their avatar and name as its heading, the profile beside the activity, all of it. */
  page?: boolean;
}) {
  const { account: user, id, name, email: shownEmail, verified, blocked, maybe: lookalike, properties: allProperties, groups, posts, postCount, votes, voteCount } = details;
  const others = details.conversations;
  const otherCount = details.conversationCount;
  const postLink = (p: { number: number; title: string; status: PostStatus }) => ({
    href: `/app/${slug}/p/${p.number}`,
    title: p.title,
    meta: <PostStatusBadge status={p.status} />,
  });

  // Beside a conversation, under Details (on their own page, the header has the id).
  const identity = id !== null && !page && <p className="text-xs break-all text-muted-foreground">id {id}</p>;
  const groupBadges = groups.length > 0 && (
    <div className="mt-1 flex flex-wrap gap-1">
      {groups.map((group) => (
        <Badge key={group.key} variant="secondary" className="h-auto max-w-full shrink whitespace-normal break-words">
          {group.name}
        </Badge>
      ))}
    </div>
  );
  const properties = (entries: PersonPanelData["properties"], title?: string) => {
    if (entries.length === 0) {
      return null;
    }
    const list = (
      <dl aria-label={title ? undefined : "Properties"} className="grid grid-cols-[fit-content(50%)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
        {entries.map((property) => (
          <div key={property.key} className="contents">
            <dt className="break-all text-muted-foreground">{property.label}</dt>
            <dd className="min-w-0 break-words">{property.text}</dd>
          </div>
        ))}
      </dl>
    );
    return title ? (
      <Section title={title} big={page}>
        {list}
      </Section>
    ) : (
      list
    );
  };

  const profile = (
    <>
      <section className="flex flex-col gap-1 empty:hidden" aria-label="Who">
        {page && user ? null : ( // On their own page the header has their face, name, address and id.
          <p className="font-medium break-words">{name ?? shownEmail ?? "Unknown"}</p>
        )}
        {shownEmail && !(page && user) && (
          // A long address breaks anywhere; "(not verified)" only between its words.
          <p className="text-sm break-words text-muted-foreground">
            <span className="break-all">{shownEmail}</span>
            {!verified && " (not verified)"}
          </p>
        )}
        {blocked && <p className="text-xs text-muted-foreground">Marked your email as spam, so replies aren&apos;t emailed to them any more.</p>}
        {!user && <p className="text-xs text-muted-foreground">Known only by this address.</p>}
        {lookalike && (
          <p className="text-xs break-words text-muted-foreground">
            Maybe {lookalike.name} (not signed in){lookalike.id && <span className="break-all">, id {lookalike.id}</span>}
          </p>
        )}
        {page && groupBadges}
      </section>

      {page ? properties(allProperties, "Properties") : null}
    </>
  );
  const activity = (
    <>
      {user && (
        <>
          {!(page && postCount === 0) && (
            <Section title="Posts" count={postCount} card={page}>
              <Links items={posts.map(postLink)} empty="No posts." rows={page} />
            </Section>
          )}
          {/* On their own page, a part they have nothing in is left out (the others say it). */}
          {!(page && voteCount === 0) && (
            <Section title="Votes" count={voteCount} card={page}>
              <Links items={votes.map(postLink)} empty="No votes on others' posts." rows={page} />
            </Section>
          )}
        </>
      )}

      <Section title={besides === undefined ? "Conversations" : "Other conversations"} count={otherCount} card={page}>
        <Links
          rows={page}
          items={others.map((c) => ({
            href: c.inView && inbox ? inboxHref(slug, inbox.view, c.number, inbox.pages, 1, inbox.q) : `/app/${slug}/inbox/${c.number}`,
            title: c.subject,
            meta: (
              <>
                #{c.number}
                <ConversationStatusText status={c.status} />
              </>
            ),
          }))}
          empty="None."
        />
      </Section>
    </>
  );

  // Their own page: what they did in numbers, then who they are beside it in full.
  // Their page's card beside what they did, when it has something (their properties, groups, a note); else what they
  // did takes the width.
  const hasProfile = !user || !!blocked || !!lookalike || (id !== null && (groups.length > 0 || allProperties.length > 0));
  return page ? (
    <div className="flex flex-col gap-6">
      <div className={cn("grid gap-6 lg:items-start", hasProfile && "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]")}>
        {hasProfile && (
          // On a muted fill, not a card: their page is a pane (no card in a card).
          <div className="flex flex-col gap-5 rounded-xl bg-muted/60 p-4">{profile}</div>
        )}
        <div className="flex flex-col gap-8">{activity}</div>
      </div>
    </div>
  ) : (
    <aside aria-label="About them">
      <DetailSection
        title="Customer details"
        count={
          Number(!!name) +
          Number(!!shownEmail) +
          Number(id !== null) +
          allProperties.length +
          groups.length +
          postCount +
          voteCount
        }
        icon={UserIcon}
        open
      >
        <div className="flex flex-col gap-3">
          {profile}
          {identity}
          {groupBadges}
          {properties(allProperties, "Properties")}
          {user && (
            <>
              <Section title="Posts" count={postCount}>
                <Links items={posts.map(postLink)} empty="No posts." />
              </Section>
              <Section title="Votes" count={voteCount}>
                <Links items={votes.map(postLink)} empty="No votes on others' posts." />
              </Section>
            </>
          )}
        </div>
      </DetailSection>
      <DetailSection title="Other conversations" count={otherCount} icon={MessagesSquareIcon}>
        <section aria-label="Other conversations" className="inbox-other-conversations">
          {others.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            // Their history with you, newest first: on a line, each a dot in its status's colour.
            <ol className="flex min-w-0 flex-col">
              {others.map((c) => (
                <li
                  key={c.number}
                  className="relative flex min-w-0 flex-col items-start gap-0.5 pb-3 pl-4 text-xs after:absolute after:top-4 after:bottom-0 after:left-[0.1875rem] after:w-px after:bg-border last:after:hidden"
                >
                  <span aria-hidden className={cn("absolute top-1.25 left-0 size-[0.4375rem] rounded-full", CONVERSATION_STATUS_STYLES[c.status].dot)} />
                  <p className="text-muted-foreground">
                    <ViewerDate at={c.lastMessageAt.toISOString()} /> · {CONVERSATION_STATUS_LABELS[c.status.toLowerCase() as ConversationStatusName]} · #{c.number}
                  </p>
                  <Link
                    href={c.inView && inbox ? inboxHref(slug, inbox.view, c.number, inbox.pages, 1, inbox.q) : `/app/${slug}/inbox/${c.number}`}
                    className="max-w-full text-[0.8125rem] leading-snug font-[550] wrap-anywhere hover:underline"
                  >
                    {c.subject}
                  </Link>
                  <p className="max-w-full truncate text-muted-foreground">{c.line}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </DetailSection>
    </aside>
  );
}
