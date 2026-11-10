import "./inbox.css";
import { type Prisma, prisma } from "@tuti/db";
import { historySince, pastConversations, visibleConversations } from "@tuti/jobs";
import { cn } from "cn";
import Link from "next/link";
import { InboxIcon, CheckIcon, ArrowRightIcon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { ConversationMore, InboxSearchButton } from "@/components/inbox/more-actions";
import { ConversationDetails } from "@/components/inbox/conversation-details";
import { NewConversationEmailsButton } from "@/components/inbox/conversation-controls";
import { ListKeys } from "@/components/inbox/list-keys";
import { LoadMore } from "@/components/inbox/load-more";
import { MessagesOffNotice } from "@/components/inbox/messages-off";
import { PastHistoryNotice } from "@/components/inbox/past-history-notice";
import { ItemList, ItemRow } from "@/components/item-list";
import { SampleBadge } from "@/components/sample-badge";
import { StatTile } from "@/components/stat-tile";
import { SubNav } from "@/components/sub-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { initial, longDuration, replyTime, rowBy, rowLine, shortDuration, timeAgo } from "@/lib/format";
import { isAdminRole } from "@/lib/roles";
import { getMembership } from "@/server/membership";
import { conversationCompanies } from "@/server/inbox-companies";
import { inboxStats } from "@/server/inbox-stats";
import { awake, conversationPerson, latestMessages } from "@/server/operations/conversations";
import { getSession } from "@/server/session";

/** How many of the views (the first) are tabs of their own; the rest are under More. */
const TABS = 3;

/** The inbox's views: what needs an answer first, then the rest. */
const VIEWS = {
  open: { title: "Needs reply", empty: "No replies waiting" },
  mine: { title: "Mine", empty: "Nothing's assigned to you." },
  unassigned: { title: "Unassigned", empty: "Every open conversation has someone on it." },
  waiting: { title: "Waiting on user", empty: "No conversations wait on a user." },
  snoozed: { title: "Snoozed", empty: "Nothing's snoozed." },
  closed: { title: "Closed", empty: "No closed conversations yet." },
  spam: { title: "Spam", empty: "No spam." },
} as const;
/** The list column's title row (the Inbox's heading, or its copy while a conversation is open). */
const LIST_TITLE = "inbox-list-title px-6 pt-6 lg:col-start-1 lg:row-start-1 lg:px-3 lg:pt-4 lg:pb-2";

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
  assignee: { select: { name: true, image: true } },
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
  const tab = (v: View) => ({
    href: inboxHref(slug, v),
    title: (
      <>
        <span className="min-w-0">{VIEWS[v].title}</span> <span className="shrink-0 text-muted-foreground tabular-nums">{counts[views.indexOf(v)]}</span>
      </>
    ),
    // Open under More, its tab is its name alone, short ("Waiting"), so the row still fits; in full to the ear.
    short: { title: v === "waiting" ? "Waiting" : VIEWS[v].title, name: `${VIEWS[v].title} ${counts[views.indexOf(v)]}` },
  });
  const history = await historySince(projectId);
  const [counts, conversations, member, { supportInbox, plan }, stats] = await Promise.all([
    Promise.all(views.map((v) => prisma.conversation.count({ where: viewWhere(v, projectId, userId, history) }))),
    listed(view, projectId, userId, history, pages),
    prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId } }, select: { emailNewConversations: true } }),
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
    // Rounded panes fill the available window under any account banners.
    <div data-slot="pane-layout" data-fills-window data-open={open !== null} className="inbox-workspace">
      <div className="inbox-phone-project">
        <SidebarTrigger />
        <span>{membership.project.name}</span>
      </div>
      <div data-slot="page-header" className={LIST_TITLE}>
        <div className="inbox-list-title-row">
          {open === null ? (
            <h1>Inbox</h1>
          ) : (
            <p aria-hidden className="font-heading inbox-list-heading">
              Inbox
            </p>
          )}
          <div className="flex items-center gap-1">
            <InboxSearchButton />
            <ConversationMore label="Inbox options">
              <NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />
            </ConversationMore>
          </div>
        </div>
      </div>
      {/* On a phone, the list or the conversation (its Back is to the list). */}
      <SubNav
        label="Views"
        current={inboxHref(slug, view)}
        // The view the list shows: the page itself, or, with a conversation open, the one beside it.
        currentIs={open === null ? "page" : "true"}
        className={cn("inbox-views", open !== null && "max-lg:hidden")}
        // The three worked through most as tabs; the rest under More, which fits the list's third of the window.
        items={views.slice(0, TABS).map(tab)}
        more={{ label: "More", items: views.slice(TABS).map(tab) }}
        // A little smaller and closer than other pages' tabs: four of them fit the list's third of the window (22rem at
        // its narrowest), a phone's width too, with two-digit counts.
        itemClassName="px-1.5 text-[0.8125rem]"
      />

      {/* The list's pane: a note above the list when there's one, the list scrolling under it. */}
      <div className={cn("inbox-list-body", open !== null && "max-lg:hidden")}>
        {/* Off, the widget offers no way to write in: said above the list (outside it: the list is only its conversations), whatever is in it. */}
        {!supportInbox && (
          <div className="px-6 pt-6 lg:px-3 lg:pt-3">
            <MessagesOffNotice projectSlug={slug} admin={isAdminRole(membership.role)} />
          </div>
        )}
        {hidden > 0 && (
          <div className="px-6 pt-6 lg:px-3 lg:pt-3">
            <PastHistoryNotice
              what={view === "spam" ? "Spam conversations" : "Closed conversations"}
              plan={plan}
              projectSlug={slug}
              admin={isAdminRole(membership.role)}
            />
          </div>
        )}
        {conversations.length > 0 && (
          <div className="inbox-list-context">
            Latest message first
            <span>
              {counts[views.indexOf(view)]} {counts[views.indexOf(view)] === 1 ? "conversation" : "conversations"}
            </span>
          </div>
        )}
        <ListKeys
          place={`${slug}:${view}`}
          open={open}
          none={inboxHref(slug, view, null, pages)}
          aria-label="Conversations"
          // Relative: what's placed absolutely in it (a label for screen readers) stays in it, not past the page's end.
          className="inbox-list-scroll"
        >
          {conversations.length === 0 ? (
            // From laptop width up, an empty Inbox says new conversations show up here, beside the list, with its numbers.
            <div className="inbox-list-empty">
              <CheckIcon aria-hidden />
              <p>{VIEWS[view].empty}</p>
              <span className={cn(none && view !== "open" && "lg:hidden")}>{view === "open" ? "You’re up to date." : whereFrom}</span>
            </div>
          ) : (
            <div className="inbox-rows">
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
                      // A dense list: rows a little tighter than other lists', so twice as many fit.
                      className={cn("inbox-row relative isolate items-start", needsReply && "inbox-needs-reply")}
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
                          aria-label={`${name}${company ? `, ${company}` : ""}: ${c.subject} (#${c.number})${c.assignee ? `, assigned to ${c.assignee.name}` : ""}`}
                          className="block truncate after:absolute after:inset-0 hover:underline"
                        >
                          {/* In full on hover (over the link's cover, still inside the link); not read out again after the link's name. */}
                          <span aria-hidden className="relative z-10" title={`${name}${company ? ` · ${company}` : ""}`}>
                            {name}
                            {company && <span className="inbox-row-company font-normal text-muted-foreground"> {company}</span>}
                          </span>
                        </Link>
                      }
                      badges={c.sample && <SampleBadge />}
                      meta={
                        // One line, cut short (in full in the conversation): what it's about, then the latest message.
                        // Snoozed, when it's back first.
                        <span className="block truncate">
                          {/* Waiting for the team, where the view doesn't already say so: small, so it stays one line. */}
                          {needsReply && view !== "open" && (
                            <Badge variant="highlight" className="mr-1.5 h-4 px-1.5 align-top text-xs leading-none">
                              Needs reply
                            </Badge>
                          )}
                          {view === "snoozed" && c.snoozedUntil && `Back ${timeAgo(c.snoozedUntil)} · `}
                          <span className="inbox-row-subject text-foreground">{c.subject}</span>
                          {line && (
                            <span className="inbox-row-preview">
                              <span className="sr-only"> · </span>
                              {line}
                            </span>
                          )}
                        </span>
                      }
                      actions={
                        // Who has it, as their face (their name on hover, and in the row's link to the ear), and the age,
                        // short to the eye, in words to the ear (and on hover). A link of the row's own over its link, so
                        // the hover reaches them and a click opens it too; not a stop of its own for the keyboard.
                        <>
                          <Link
                            href={inboxHref(slug, view, c.number, pages)}
                            scroll={false}
                            tabIndex={-1}
                            aria-hidden
                            className="relative flex items-center gap-1.5"
                          >
                            {c.assignee && (
                              <Avatar title={c.assignee.name} data-assignee className="size-5">
                                {c.assignee.image && <AvatarImage src={c.assignee.image} alt="" />}
                                <AvatarFallback className="text-[0.625rem]">{initial(c.assignee.name)}</AvatarFallback>
                              </Avatar>
                            )}
                            <time dateTime={since.toISOString()} title={age} className="text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
                              {shortDuration(since)}
                            </time>
                          </Link>
                          <span className="sr-only">{age}</span>
                        </>
                      }
                    />
                  );
                })}
              </ItemList>
            </div>
          )}
          <LoadMore
            href={inboxHref(slug, view, open, pages + 1, messages)}
            pages={pages}
            last={conversations.at(-1)?.number ?? 0}
            more={counts[views.indexOf(view)]! > conversations.length}
          />
        </ListKeys>
        <div className="inbox-list-footer">
          <InboxIcon aria-hidden />
          All conversations stay here.
          <span>
            <kbd>J</kbd> <kbd>K</kbd>
          </span>
        </div>
      </div>

      {stats ? (
        // Until a conversation opens (from laptop width up: on a phone the list is alone), how the Inbox is doing.
        <ConversationPane open={false}>
          <div className="inbox-overview inbox-surface">
            <div className="inbox-overview-title">
              <h2>Inbox overview</h2>
              <span>{membership.project.name}</span>
            </div>
            <div className="inbox-all-clear">
              {none && (
                <div className="inbox-empty-mark">
                  <InboxIcon aria-hidden />
                  <span>
                    <CheckIcon aria-hidden />
                  </span>
                </div>
              )}
              <h1>{none ? "You’re all caught up." : "Open a conversation"}</h1>
              <p>
                {none ? (
                  <>
                    Nothing needs a reply. New conversations <br />
                    from your widget, email and API will appear here.
                  </>
                ) : (
                  "Open a conversation to reply here: click it, or press J."
                )}
              </p>
              {none && (
                <Link href={inboxHref(slug, "waiting")} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  See waiting conversations <ArrowRightIcon aria-hidden />
                </Link>
              )}
            </div>
            <div className="inbox-overview-stats grid gap-5 sm:grid-cols-3">
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
          </div>
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
    <section aria-label="Conversation" data-inbox-conversation className={cn("inbox-conversation-pane", !open && "max-lg:hidden")}>
      <ConversationDetails hidden={detailsHidden}>{children}</ConversationDetails>
    </section>
  );
}
