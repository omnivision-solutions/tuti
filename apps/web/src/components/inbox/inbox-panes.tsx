import { type Prisma, prisma } from "@tuti/db";
import { historySince, pastConversations, visibleConversations } from "@tuti/jobs";
import { cn } from "cn";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, CircleCheckIcon, ClockIcon, HourglassIcon, InboxIcon, ShieldAlertIcon, UserIcon, UserXIcon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ConversationMore, InboxSearchButton } from "@/components/inbox/more-actions";
import { ConversationDetails } from "@/components/inbox/conversation-details";
import { NewConversationEmailsButton } from "@/components/inbox/conversation-controls";
import { ListKeys } from "@/components/inbox/list-keys";
import { LoadMore } from "@/components/inbox/load-more";
import { MessagesOffNotice } from "@/components/inbox/messages-off";
import { PastHistoryNotice } from "@/components/inbox/past-history-notice";
import { Pane, PaneBody, PaneHeader, PaneLayout, SectionGroup, SectionLink, SectionPane } from "@/components/pane";
import { PaneResize } from "@/components/pane-resize";
import { ItemList, ItemRow } from "@/components/item-list";
import { SampleBadge } from "@/components/sample-badge";
import { StatStrip } from "@/components/stat-tile";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { initial, longDuration, replyTime, rowBy, rowLine, shortDuration, timeAgo } from "@/lib/format";
import { isAdminRole } from "@/lib/roles";
import { getMembership } from "@/server/membership";
import { conversationCompanies } from "@/server/inbox-companies";
import { conversationReads } from "@/server/conversation-reads";
import { inboxStats } from "@/server/inbox-stats";
import { awake, conversationPerson, latestMessages } from "@/server/operations/conversations";
import { getSession } from "@/server/session";

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

export type View = keyof typeof VIEWS;

const VIEW_ICONS: Record<View, ReactNode> = {
  open: <InboxIcon />,
  mine: <UserIcon />,
  unassigned: <UserXIcon />,
  waiting: <HourglassIcon />,
  snoozed: <ClockIcon />,
  closed: <CircleCheckIcon />,
  spam: <ShieldAlertIcon />,
};

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
 * The Inbox, in panes: its views (a section pane, with their counts), the list, and the conversation open beside it
 * (`children`, the `open` one's), each scrolling on its own (the page itself doesn't); narrower, one at a time.
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
  const reads = await conversationReads(conversations.map((c) => c.id), userId);

  return (
    <PaneLayout>
      <SectionPane title="Inbox">
        <SectionGroup>
          {views.map((v, i) => (
            <SectionLink key={v} href={inboxHref(slug, v)} icon={VIEW_ICONS[v]} count={counts[i]} active={v === view}>
              {VIEWS[v].title}
            </SectionLink>
          ))}
        </SectionGroup>
      </SectionPane>
      {/* The list and the conversation beside it from 52.5rem of their own (22rem of list, 480px of conversation), each
          scrolling on its own; narrower, one at a time. The conversation's details beside it too from 38rem more. */}
      <div data-fills-window className="@container/inbox flex min-h-0 min-w-0 flex-1">
        <div
          data-open={open !== null}
          className="inbox-workspace group/inbox grid min-h-0 min-w-0 flex-1 grid-cols-[clamp(22rem,var(--inbox-list-width,22rem),var(--inbox-list-max))_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-x-2 [--inbox-details-beside:0] [--inbox-list-max:clamp(22rem,calc(100%_-_480px_-_0.5rem_-_var(--inbox-details-space,0px)),520px)] @max-[52.5rem]/inbox:flex @max-[52.5rem]/inbox:flex-col @min-[calc(480px_+_38rem)]/inbox:[--inbox-details-beside:1] @min-[calc(480px_+_38rem)]/inbox:has-[.inbox-thread[data-details=shown]>.inbox-details]:[--inbox-details-space:calc(18.75rem_+_0.5rem)]"
        >
          {/* The list's pane: its view and count, a note above the list when there's one, the list scrolling under it. */}
          <Pane className={cn("inbox-list-body col-start-1 row-start-1 @max-[52.5rem]/inbox:flex-1", open !== null && "@max-[52.5rem]/inbox:hidden")}>
            <PaneHeader
              // The page's heading while no conversation is open; beside one, the conversation's is.
              level={open === null ? 1 : 2}
              title={
                <>
                  {VIEWS[view].title} <span className="font-sans text-base font-normal text-muted-foreground tabular-nums">{counts[views.indexOf(view)]}</span>
                </>
              }
              actions={
                <>
                  <InboxSearchButton />
                  <ConversationMore label="Inbox options">
                    <NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />
                  </ConversationMore>
                </>
              }
            />
            {/* Off, the widget offers no way to write in: said above the list (outside it: the list is only its conversations), whatever is in it. */}
            {!supportInbox && (
              <div className="px-4.5 pt-4 pb-1">
                <MessagesOffNotice projectSlug={slug} admin={isAdminRole(membership.role)} compact />
              </div>
            )}
            {hidden > 0 && (
              <div className="px-3 pt-3">
                <PastHistoryNotice
                  what={view === "spam" ? "Spam conversations" : "Closed conversations"}
                  plan={plan}
                  projectSlug={slug}
                  admin={isAdminRole(membership.role)}
                />
              </div>
            )}
            <ListKeys
              place={`${slug}:${view}`}
              open={open}
              none={inboxHref(slug, view, null, pages)}
              aria-label="Conversations"
              // Relative: what's placed absolutely in it (a label for screen readers) stays in it, not past the page's end.
              className="inbox-list-scroll relative min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-4.5"
            >
              {conversations.length === 0 ? (
                // With room for both panes, an empty Inbox says new conversations show up here, beside the list, with its numbers.
                <div className="inbox-list-empty mt-18 mx-5 flex flex-col items-center gap-2 text-center max-md:mt-37.5 [&>svg]:size-6.25 [&>svg]:text-primary [&>p]:text-sm [&>p]:leading-normal [&>p]:font-[550] [&>span]:text-xs [&>span]:leading-normal [&>span]:text-muted-foreground">
                  <CheckIcon aria-hidden />
                  <p>{VIEWS[view].empty}</p>
                  <span className={cn(none && view !== "open" && "@min-[57rem]/app:hidden")}>{view === "open" ? "You’re up to date." : whereFrom}</span>
                </div>
              ) : (
                <div className="inbox-rows [&>ul]:m-0">
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
                      const unread = reads.get(c.id)?.unread ?? false;
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
                          className={cn("inbox-row relative isolate items-start my-0.75 mx-0 rounded-xl border-0 px-2.5 py-3.75 first:mt-0.75 first:pt-3.75 last:mb-0.75 last:pb-3.75 data-selected:bg-secondary [&>div:first-child]:items-start [&>div:first-child]:gap-2.5 [&>div:last-child]:self-stretch", unread ? "inbox-unread" : "inbox-read")}
                          leading={
                            <Avatar className="mt-0.5 size-7.5 text-xs">
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
                              aria-label={`${unread ? "Unread, " : ""}${name}${company ? `, ${company}` : ""}: ${c.subject} (#${c.number})${c.assignee ? `, assigned to ${c.assignee.name}` : ""}`}
                              className={cn("block truncate text-[0.875rem] after:absolute after:inset-0 hover:underline", unread ? "font-[650] text-foreground" : "font-normal text-foreground/70")}
                            >
                              {/* In full on hover (over the link's cover, still inside the link); not read out again after the link's name. */}
                              <span aria-hidden className="relative z-10" title={`${name}${company ? ` · ${company}` : ""}`}>
                                {name}
                                {company && <span className="inbox-row-company font-normal text-muted-foreground ml-0.75 text-xs"> {company}</span>}
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
                              <span className={cn("inbox-row-subject block overflow-hidden text-ellipsis text-sm leading-5.5", unread ? "font-[650] text-foreground" : "font-normal text-foreground/70")}>{c.subject}</span>
                              {line && (
                                <span className={cn(c.assignee && "pr-6", "inbox-row-preview block overflow-hidden text-ellipsis text-xs leading-5 text-muted-foreground")}>
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
                                className="relative flex h-full items-start gap-1.5"
                              >
                                {c.assignee && (
                                  <Avatar title={c.assignee.name} data-assignee className="absolute right-0 bottom-px size-4.5">
                                    {c.assignee.image && <AvatarImage src={c.assignee.image} alt="" />}
                                    <AvatarFallback className="text-[0.625rem]">{initial(c.assignee.name)}</AvatarFallback>
                                  </Avatar>
                                )}
                                <time dateTime={since.toISOString()} title={age} className="text-xs leading-5 font-normal whitespace-nowrap text-muted-foreground tabular-nums">
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
            <div className="inbox-list-footer leading-normal mt-auto flex items-center gap-1.75 px-4.5 py-4 text-xs text-muted-foreground [&>svg]:size-3.5 [&>span]:ml-auto @max-[52.5rem]/inbox:[&>span]:hidden [&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:px-1 [&_kbd]:text-xs [&_kbd]:leading-4">
              <InboxIcon aria-hidden />
              All conversations stay here.
              <span>
                <kbd>J</kbd> <kbd>K</kbd>
              </span>
            </div>
          </Pane>

          <PaneResize pane="inbox" className="col-start-1 row-start-1 translate-x-[9px] justify-self-end" />

          {stats ? (
            // Until a conversation opens (with room for both panes; otherwise the list is alone), how the Inbox is doing.
            <ConversationPane open={false}>
              <Pane className="inbox-overview">
                <PaneHeader level={2} title="Inbox overview" description={membership.project.name} />
                <PaneBody className="flex flex-col px-5 pb-5">
                  <div className="inbox-all-clear m-auto max-w-104 py-15 text-center [&>h2]:mb-3.5 [&>h2]:font-heading [&>h2]:text-[2rem] [&>h2]:font-[650] [&>h2]:tracking-[-0.03em] [&>p]:mb-6 [&>p]:text-sm [&>p]:leading-[1.65] [&>p]:text-muted-foreground">
                    {none && (
                      <div className="inbox-empty-mark relative mx-auto mb-5.5 grid size-17 place-items-center rounded-4xl bg-soft text-primary [&>svg]:size-7.5 [&>span]:absolute [&>span]:-right-1.25 [&>span]:-bottom-1 [&>span]:grid [&>span]:size-5.75 [&>span]:place-items-center [&>span]:rounded-full [&>span]:bg-primary [&>span]:text-primary-foreground [&>span]:ring-4 [&>span]:ring-card [&>span>svg]:size-3.5">
                        <InboxIcon aria-hidden />
                        <span>
                          <CheckIcon aria-hidden />
                        </span>
                      </div>
                    )}
                    <h2>{none ? "You’re all caught up." : "Open a conversation"}</h2>
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
                  <StatStrip
                    className="inbox-overview-stats"
                    items={[
                      {
                        label: "Waiting for a reply",
                        value: stats.waiting,
                        detail: stats.oldest ? `Longest ${longDuration(stats.oldest)}` : "Nobody's waiting",
                      },
                      {
                        label: "Usual first reply",
                        value: stats.replyMs === null ? "—" : replyTime(stats.replyMs).replace(/^./, (c) => c.toUpperCase()),
                        detail: stats.replyMs === null ? "Not enough yet" : "Last 30 days",
                      },
                      { label: "New conversations this week", value: stats.newThisWeek, detail: "Conversations started" },
                    ]}
                  />
                </PaneBody>
              </Pane>
            </ConversationPane>
          ) : (
            children
          )}
        </div>
      </div>
    </PaneLayout>
  );
}

/**
 * Where the conversation goes, beside the list: its page's panes, or, with none open, the Inbox's numbers. `detailsHidden`:
 * the pane beside its messages hidden, as the page read it from this browser's cookie (ConversationDetails).
 */
export function ConversationPane({ open, detailsHidden = false, children }: { open: boolean; detailsHidden?: boolean; children: ReactNode }) {
  return (
    <section aria-label="Conversation" data-inbox-conversation className={cn("inbox-conversation-pane col-start-2 row-start-1 flex min-h-0 min-w-0 @max-[52.5rem]/inbox:flex-1", !open && "@max-[52.5rem]/inbox:hidden")}>
      <ConversationDetails hidden={detailsHidden}>{children}</ConversationDetails>
    </section>
  );
}
