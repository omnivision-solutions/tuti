import { type Prisma, prisma } from "@tuti/db";
import { historySince, pastConversations, visibleConversations } from "@tuti/jobs";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { ConversationDetails } from "@/components/inbox/conversation-details";
import { NewConversationEmailsButton } from "@/components/inbox/conversation-controls";
import { ListKeys } from "@/components/inbox/list-keys";
import { LoadMore } from "@/components/inbox/load-more";
import { MessagesOffNotice } from "@/components/inbox/messages-off";
import { PastHistoryNotice } from "@/components/inbox/past-history-notice";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { SampleBadge } from "@/components/sample-badge";
import { StatTile } from "@/components/stat-tile";
import { SubNav } from "@/components/sub-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { initial, longDuration, replyTime, rowBy, rowLine, shortDuration, timeAgo } from "@/lib/format";
import { isAdminRole } from "@/lib/roles";
import { getMembership } from "@/server/membership";
import { conversationCompanies } from "@/server/inbox-companies";
import { inboxStats } from "@/server/inbox-stats";
import { awake, conversationPerson, latestMessages } from "@/server/operations/conversations";
import { getSession } from "@/server/session";

/** The inbox's views: what needs an answer first, then the rest. */
const VIEWS = {
  open: { title: "Needs reply", empty: "Nothing waits for an answer." },
  mine: { title: "Mine", empty: "Nothing's assigned to you." },
  unassigned: { title: "Unassigned", empty: "Every open conversation has someone on it." },
  waiting: { title: "Waiting on user", empty: "No conversations wait on a user." },
  snoozed: { title: "Snoozed", empty: "Nothing's snoozed." },
  closed: { title: "Closed", empty: "No closed conversations yet." },
  spam: { title: "Spam", empty: "No spam." },
} as const;
export type View = keyof typeof VIEWS;

/** The view a `?view=` asks for; Needs reply for none, or one it doesn't know. */
export function inboxView(param: string | string[] | undefined): View {
  // Own keys only: `in` would also take inherited names like "constructor".
  return typeof param === "string" && Object.hasOwn(VIEWS, param) ? (param as View) : "open";
}

/** How many pages a `?page=` (or `?messages=`) asks for: 1 for none, or one that isn't a count. */
export function inboxPages(param: string | string[] | undefined) {
  const pages = Number(param);
  return Number.isSafeInteger(pages) && pages > 1 ? pages : 1;
}

/** The list shows this many conversations, and this many more with each "Load more" (`?page=`). */
const PER_PAGE = 100;

/**
 * The inbox's address in a view, with a conversation open in it (`/inbox/<number>`) or none, its list `pages` long
 * (`?page=`: rows loaded with "Load more" stay as another conversation opens), and the open one's `messages` pages of
 * messages (`?messages=`).
 */
export function inboxHref(slug: string, view: View, number: number | null = null, pages = 1, messages = 1) {
  const params = new URLSearchParams({
    ...(view !== "open" && { view }),
    ...(pages > 1 && { page: String(pages) }),
    ...(messages > 1 && { messages: String(messages) }),
  });
  return `/app/${slug}/inbox${number === null ? "" : `/${number}`}${params.size > 0 ? `?${params}` : ""}`;
}

/**
 * A view's conversations: always this project's, whatever the view; snoozed ones only in Snoozed (till it passes). With
 * `since` (historySince), closed ones from before it are past the plan's history: in no view.
 */
function viewWhere(view: View, projectId: string, userId: string, since: Date | null = null): Prisma.ConversationWhereInput {
  const now = new Date();
  const filters: Record<View, Prisma.ConversationWhereInput> = {
    open: { spam: false, status: "OPEN", ...awake(now) },
    mine: { spam: false, assigneeId: userId, status: { not: "CLOSED" }, ...awake(now) },
    unassigned: { spam: false, assigneeId: null, status: "OPEN", ...awake(now) },
    waiting: { spam: false, status: "WAITING", ...awake(now) },
    // Closed is done with, snoozed or not (a snooze left on one, by a release from before, doesn't hide it).
    snoozed: { spam: false, status: { not: "CLOSED" }, snoozedUntil: { gt: now } },
    closed: { spam: false, status: "CLOSED" },
    spam: { spam: true },
  };
  return { AND: [filters[view], visibleConversations(since)], projectId };
}

/** Which of these conversations (ids) are in the view, by the list's own filter: their numbers. */
export async function inInboxView(projectId: string, userId: string, view: View, ids: string[]): Promise<Set<number>> {
  if (ids.length === 0) {
    return new Set();
  }
  const listed = await prisma.conversation.findMany({ where: { AND: [viewWhere(view, projectId, userId), { id: { in: ids } }] }, select: { number: true } });
  return new Set(listed.map((c) => c.number));
}

const LISTED = {
  number: true,
  subject: true,
  status: true,
  email: true,
  name: true,
  emailVerified: true,
  lastMessageAt: true,
  waitingSince: true,
  snoozedUntil: true,
  sample: true,
  id: true,
  assignee: { select: { name: true } },
  userId: true,
  user: { select: { name: true, email: true, emailVerified: true, image: true, ssoIdentity: { select: { externalId: true, email: true, properties: true } } } },
} as const;

/** A view's first `pages` pages of conversations, the latest message first. */
async function listed(view: View, projectId: string, userId: string, history: Date | null, pages: number) {
  const where = viewWhere(view, projectId, userId, history);
  return prisma.conversation.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }], take: PER_PAGE * pages, select: LISTED });
}

/**
 * The Inbox: its views, the list, and the conversation open beside it (`children`, the `open` one's), each
 * scrolling on its own under the header from laptop width up (the page itself doesn't); narrower, one at a time. The
 * views are a row of tabs above the list at every width, in the same place whether a conversation is open or not.
 * With none open, the pane beside the list has the Inbox's numbers (`children` only with one open). The list is `pages`
 * pages long (`?page=`), with "Load more" under it while the view has more; it keeps the open one's `messages` pages.
 */
export async function InboxPanes({
  slug,
  view,
  open,
  pages = 1,
  messages = 1,
  children,
}: {
  slug: string;
  view: View;
  open: number | null;
  pages?: number;
  messages?: number;
  children?: ReactNode;
}) {
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const projectId = membership.project.id;
  const userId = session.user.id;

  const views = Object.keys(VIEWS) as View[];
  const history = await historySince(projectId);
  const [counts, conversations, member, { supportInbox, plan }, stats] = await Promise.all([
    Promise.all(views.map((v) => prisma.conversation.count({ where: viewWhere(v, projectId, userId, history) }))),
    listed(view, projectId, userId, history, pages),
    // The list's own header, with no conversation open (one that is has its own).
    open === null
      ? prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId } }, select: { emailNewConversations: true } })
      : null,
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true, plan: true } }),
    open === null ? inboxStats(projectId) : null,
  ]);
  // Closed and Spam: whether some are past the plan's history (said above the list, rather than an empty one alone).
  const hidden =
    history && (view === "closed" || view === "spam")
      ? await prisma.conversation.count({ where: { AND: [viewWhere(view, projectId, userId), pastConversations(history)] } })
      : 0;
  // Not one conversation in any view, spam included: the views split them all between them.
  const none = counts.every((n) => n === 0);
  const whereFrom = "New conversations show up here as they come in.";
  const latest = await latestMessages(conversations.map((c) => c.id));
  const companies = await conversationCompanies(projectId, conversations);

  return (
    // From laptop width up, the rest of the window under the header and any banners (-mt-6 etc.: over the page's own padding).
    // The list a third of the width (22–25rem): rows that read in a few lines, the conversation's pane still wide enough
    // for the person beside it at 1280 and 1440px.
    <div
      data-slot="pane-layout"
      data-fills-window
      className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:grid lg:min-h-0 lg:grid-cols-[clamp(22rem,33%,25rem)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]"
    >
      {member && <PageHeader title="Inbox" className="px-6 pt-6" more={<NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />} />}
      {/* On a phone, the list or the conversation (its Back is to the list). */}
      <SubNav
        label="Views"
        current={inboxHref(slug, view)}
        // The view the list shows: the page itself, or, with a conversation open, the one beside it.
        currentIs={open === null ? "page" : "true"}
        className={cn("mx-6 mt-4 lg:mx-0 lg:mt-0 lg:border-r lg:px-3", open !== null && "max-lg:hidden")}
        items={views.map((v, i) => ({
          href: inboxHref(slug, v),
          title: (
            <>
              <span className="min-w-0">{VIEWS[v].title}</span> <span className="shrink-0 text-muted-foreground tabular-nums">{counts[i]}</span>
            </>
          ),
        }))}
      />

      {/* The list's pane: a note above the list when there's one, the list scrolling under it. */}
      <div className={cn("flex flex-col lg:row-start-2 lg:min-h-0 lg:border-r", open !== null && "max-lg:hidden")}>
        {/* Off, the widget offers no way to write in: said above the list (outside it: the list is only its conversations), whatever is in it. */}
        {!supportInbox && (
          <div className="px-6 pt-6 lg:px-3 lg:pt-3">
            <MessagesOffNotice projectSlug={slug} admin={isAdminRole(membership.role)} />
          </div>
        )}
        {hidden > 0 && (
          <div className="px-6 pt-6 lg:px-3 lg:pt-3">
            <PastHistoryNotice what={view === "spam" ? "Spam conversations" : "Closed conversations"} plan={plan} projectSlug={slug} admin={isAdminRole(membership.role)} />
          </div>
        )}
        <ListKeys
          place={`${slug}:${view}`}
          open={open}
          none={inboxHref(slug, view, null, pages)}
          aria-label="Conversations"
          // Relative: what's placed absolutely in it (a label for screen readers) stays in it, not past the page's end.
          className="p-6 lg:relative lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-3"
        >
          {conversations.length === 0 ? (
            // From laptop width up, an empty Inbox says new conversations show up here, beside the list, with its numbers.
            <EmptyState title={VIEWS[view].empty} description={<span className={cn(none && "lg:hidden")}>{whereFrom}</span>} />
          ) : (
            <Card size="sm">
              <CardContent>
                <ItemList>
                  {conversations.map((c) => {
                    const person = conversationPerson(c);
                    const name = person.name ?? person.email ?? "Unknown";
                    // Their company, as the team's app says (Users' company property), when it says one.
                    const company = companies.get(c.id);
                    // The latest message's first line, with who wrote it when it isn't the person (an AI answer isn't their question).
                    const message = latest.get(c.id);
                    const text = message && rowLine(c.subject, message.body);
                    const by = message && rowBy(message, userId);
                    const line = text && (by ? `${by}: ${text}` : text);
                    // Spam waits on nobody, however it came in. Not said in Needs reply, where every row does.
                    const needsReply = view !== "spam" && c.status === "OPEN" && c.waitingSince !== null;
                    // One age per row: how long they've waited for the team, or since the latest message.
                    const since = needsReply && c.waitingSince ? c.waitingSince : c.lastMessageAt;
                    const age = needsReply ? `Waiting ${longDuration(since)}` : `Latest message ${longDuration(since)} ago`;
                    return (
                      <ItemRow
                        key={c.number}
                        selected={c.number === open}
                        // Relative: the name's link covers the whole row, so a click anywhere in it opens the conversation.
                        // Isolated: what's raised over the cover stays in the row, under the page's sticky header.
                        className="relative isolate items-start"
                        leading={
                          <Avatar className="size-8">
                            {c.user?.image && <AvatarImage src={c.user.image} alt="" />}
                            <AvatarFallback>{initial(name)}</AvatarFallback>
                          </Avatar>
                        }
                        title={
                          // Named for screen readers by whom, what and which: one person's conversations told apart.
                          // Who on one line, cut short (in full on hover, and in the conversation).
                          <Link
                            href={inboxHref(slug, view, c.number, pages)}
                            scroll={false}
                            data-row-link={c.number}
                            aria-current={c.number === open ? "page" : undefined}
                            aria-label={`${name}${company ? `, ${company}` : ""}: ${c.subject} (#${c.number})`}
                            className="block truncate after:absolute after:inset-0 hover:underline"
                          >
                            {/* In full on hover (over the link's cover, still inside the link); not read out again after the link's name. */}
                            <span aria-hidden className="relative z-10" title={`${name}${company ? ` · ${company}` : ""}`}>
                              {name}
                              {company && <span className="font-normal text-muted-foreground"> · {company}</span>}
                            </span>
                          </Link>
                        }
                        badges={c.sample && <SampleBadge />}
                        meta={
                          <>
                            {/* Two lines at most; long words (a pasted link) wrap, rather than running out of the row. */}
                            <span className="line-clamp-2 wrap-anywhere">
                              <span className="text-foreground">{c.subject}</span>
                              {line && ` · ${line}`}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                              {needsReply && view !== "open" && <Badge variant="highlight">Needs reply</Badge>}
                              <span>
                                #{c.number}
                                {c.assignee && ` · ${c.assignee.name}`}
                                {view === "snoozed" && c.snoozedUntil && ` · back ${timeAgo(c.snoozedUntil)}`}
                              </span>
                            </span>
                          </>
                        }
                        actions={
                          // Short to the eye, in words to the ear (and on hover: over the row's link, opening it too).
                          <time dateTime={since.toISOString()} title={age} className="text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
                            <Link href={inboxHref(slug, view, c.number, pages)} scroll={false} tabIndex={-1} aria-hidden className="relative">
                              {shortDuration(since)}
                            </Link>
                            <span className="sr-only">{age}</span>
                          </time>
                        }
                      />
                    );
                  })}
                </ItemList>
              </CardContent>
            </Card>
          )}
          <LoadMore
            href={inboxHref(slug, view, open, pages + 1, messages)}
            last={conversations.at(-1)?.number ?? 0}
            more={counts[views.indexOf(view)]! > conversations.length}
          />
        </ListKeys>
      </div>

      {stats ? (
        // Until a conversation opens (from laptop width up: on a phone the list is alone), how the Inbox is doing.
        <ConversationPane open={false}>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              value={stats.waiting}
              label="Waiting for a reply"
              detail={stats.oldest ? `Longest ${longDuration(stats.oldest)}` : "Nobody's waiting"}
              href={inboxHref(slug, "open")}
            />
            <StatTile
              value={stats.replyMs === null ? "Not enough yet" : replyTime(stats.replyMs).replace(/^./, (c) => c.toUpperCase())}
              label="Usual first reply"
              detail="Last 30 days"
            />
            <StatTile value={stats.newThisWeek} label="New conversations this week" />
          </div>
          <p className="text-sm text-muted-foreground">{none ? whereFrom : "Open a conversation to reply here: click it, or press J."}</p>
        </ConversationPane>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * Where the conversation goes, beside the list: its page's, or, with none open, the Inbox's numbers. `detailsHidden`: the
 * column beside its messages hidden, as the page read it from this browser's cookie (ConversationDetails).
 */
export function ConversationPane({ open, detailsHidden = false, children }: { open: boolean; detailsHidden?: boolean; children: ReactNode }) {
  return (
    <section
      aria-label="Conversation"
      data-inbox-conversation
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-6 p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-hidden lg:pb-0",
        !open && "max-lg:hidden",
      )}
    >
      <ConversationDetails hidden={detailsHidden}>{children}</ConversationDetails>
    </section>
  );
}
