import { type Prisma, prisma } from "@tuti/db";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { NewConversationEmailsButton } from "@/components/inbox/conversation-controls";
import { ListKeys } from "@/components/inbox/list-keys";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { SampleBadge } from "@/components/sample-badge";
import { SubNav } from "@/components/sub-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { initial, longDuration, rowLine, shortDuration, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { conversationCompanies } from "@/server/inbox-companies";
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

/** The inbox's address in a view, with a conversation open in it (`/inbox/<number>`) or none. */
export function inboxHref(slug: string, view: View, number: number | null = null) {
  return `/app/${slug}/inbox${number === null ? "" : `/${number}`}${view === "open" ? "" : `?view=${view}`}`;
}

/** A view's conversations: always this project's, whatever the view; snoozed ones only in Snoozed (till it passes). */
function viewWhere(view: View, projectId: string, userId: string): Prisma.ConversationWhereInput {
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
  return { ...filters[view], projectId };
}

/** Which of these conversations (ids) are in the view, by the list's own filter: their numbers. */
export async function inInboxView(projectId: string, userId: string, view: View, ids: string[]): Promise<Set<number>> {
  if (ids.length === 0) {
    return new Set();
  }
  const listed = await prisma.conversation.findMany({ where: { AND: [viewWhere(view, projectId, userId), { id: { in: ids } }] }, select: { number: true } });
  return new Set(listed.map((c) => c.number));
}

/**
 * The Inbox: its views, the list, and the conversation open beside it (`children`, the `open` one's), each
 * scrolling on its own under the header from laptop width up (the page itself doesn't); narrower, one at a time. From
 * 1440px wide the views are a pane of their own; narrower, they're above the list.
 */
export async function InboxPanes({ slug, view, open, children }: { slug: string; view: View; open: number | null; children: ReactNode }) {
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const projectId = membership.project.id;
  const userId = session.user.id;

  const views = Object.keys(VIEWS) as View[];
  const [counts, conversations, member] = await Promise.all([
    Promise.all(views.map((v) => prisma.conversation.count({ where: viewWhere(v, projectId, userId) }))),
    prisma.conversation.findMany({
      where: viewWhere(view, projectId, userId),
      orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }],
      take: 100,
      select: {
        number: true,
        subject: true,
        status: true,
        email: true,
        emailVerified: true,
        lastMessageAt: true,
        waitingSince: true,
        snoozedUntil: true,
        sample: true,
        id: true,
        assignee: { select: { name: true } },
        userId: true,
        user: { select: { name: true, email: true, emailVerified: true, image: true, ssoIdentity: { select: { externalId: true, email: true, properties: true } } } },
      },
    }),
    // The list's own header, with no conversation open (one that is has its own).
    open === null
      ? prisma.teamMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId } }, select: { emailNewConversations: true } })
      : null,
  ]);
  const latest = await latestMessages(conversations.map((c) => c.id));
  const companies = await conversationCompanies(projectId, conversations);

  return (
    // From laptop width up, the rest of the window under the header and any banners (-mt-6 etc.: over the page's own padding).
    // The list a third of the width (22–25rem): rows that read in a few lines, the conversation's pane still wide enough
    // for the person beside it at 1280 and 1440px.
    <div
      data-slot="pane-layout"
      data-fills-window
      className={cn(
        "-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:grid lg:min-h-0 lg:grid-cols-[clamp(22rem,33%,25rem)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]",
        "min-[90rem]:grid-cols-[10rem_25rem_minmax(0,1fr)] min-[90rem]:grid-rows-1",
      )}
    >
      {member && <PageHeader title="Inbox" className="px-6 pt-6" more={<NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />} />}
      {/* On a phone, the list or the conversation (its Back is to the list). */}
      <SubNav
        label="Views"
        current={inboxHref(slug, view)}
        // The view the list shows: the page itself, or, with a conversation open, the one beside it.
        currentIs={open === null ? "page" : "true"}
        className={cn(
          "mx-6 mt-4 lg:mx-0 lg:mt-0 lg:border-r lg:px-3",
          "min-[90rem]:flex-col min-[90rem]:gap-0.5 min-[90rem]:overflow-y-auto min-[90rem]:p-3 min-[90rem]:shadow-none",
          open !== null && "max-lg:hidden",
        )}
        // In the column, a long view wraps beside its count ("Waiting on / user  123"); the row never does.
        itemClassName="min-[90rem]:flex min-[90rem]:justify-between min-[90rem]:gap-2 min-[90rem]:rounded-md min-[90rem]:border-b-0 min-[90rem]:py-1.5 min-[90rem]:whitespace-normal min-[90rem]:hover:bg-muted min-[90rem]:data-active:bg-muted"
        items={views.map((v, i) => ({
          href: inboxHref(slug, v),
          title: (
            <>
              <span className="min-w-0">{VIEWS[v].title}</span> <span className="shrink-0 text-muted-foreground tabular-nums">{counts[i]}</span>
            </>
          ),
        }))}
      />

      <ListKeys
        place={`${slug}:${view}`}
        open={open}
        aria-label="Conversations"
        // Relative: what's placed absolutely in it (a label for screen readers) stays in it, not past the page's end.
        className={cn("p-6 lg:relative lg:row-start-2 lg:overflow-y-auto lg:border-r lg:p-3", "min-[90rem]:col-start-2 min-[90rem]:row-start-1", open !== null && "max-lg:hidden")}
      >
        {conversations.length === 0 ? (
          <EmptyState title={VIEWS[view].empty} description="Conversations come from the API for now." />
        ) : (
          <Card size="sm">
            <CardContent>
              <ItemList>
                {conversations.map((c) => {
                  const person = conversationPerson(c);
                  const name = person.name ?? person.email ?? "Unknown";
                  // Their company, as the team's app says (Users' company property), when it says one.
                  const company = companies.get(c.id);
                  const body = latest.get(c.id)?.body;
                  const line = body === undefined ? undefined : rowLine(c.subject, body);
                  // Spam waits on nobody, however it came in.
                  const needsReply = view !== "spam" && c.status === "OPEN" && c.waitingSince !== null;
                  // One age per row: how long they've waited for the team, or since the latest message.
                  const since = needsReply && c.waitingSince ? c.waitingSince : c.lastMessageAt;
                  const age = needsReply ? `Waiting ${longDuration(since)}` : `Latest message ${longDuration(since)} ago`;
                  return (
                    <ItemRow
                      key={c.number}
                      selected={c.number === open}
                      className="items-start"
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
                          href={inboxHref(slug, view, c.number)}
                          scroll={false}
                          data-row-link={c.number}
                          aria-current={c.number === open ? "page" : undefined}
                          aria-label={`${name}${company ? `, ${company}` : ""}: ${c.subject} (#${c.number})`}
                          className="block truncate hover:underline"
                        >
                          {/* In full on hover; not read out again after the link's name. */}
                          <span aria-hidden title={`${name}${company ? ` · ${company}` : ""}`}>
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
                            {needsReply && <Badge variant="highlight">Needs reply</Badge>}
                            <span>
                              #{c.number}
                              {c.assignee && ` · ${c.assignee.name}`}
                              {view === "snoozed" && c.snoozedUntil && ` · back ${timeAgo(c.snoozedUntil)}`}
                            </span>
                          </span>
                        </>
                      }
                      actions={
                        // Short to the eye, in words to the ear (and on hover).
                        <time dateTime={since.toISOString()} title={age} className="text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
                          <span aria-hidden>{shortDuration(since)}</span>
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
      </ListKeys>

      {children}
    </div>
  );
}

/** Where the conversation goes, beside the list: its page's, or, with none open, how to open one. */
export function ConversationPane({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <section
      aria-label="Conversation"
      data-inbox-conversation
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-6 p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-hidden lg:pb-0",
        "min-[90rem]:col-start-3 min-[90rem]:row-span-1",
        !open && "max-lg:hidden",
      )}
    >
      {children}
    </section>
  );
}
