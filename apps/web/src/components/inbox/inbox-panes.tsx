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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { initial, rowLine, shortDuration, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { conversationCompanies } from "@/server/inbox-companies";
import { awake, conversationPerson } from "@/server/operations/conversations";
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
  // Each listed conversation's latest message (not a note; by id where two share a time), its start only: one read each,
  // from the newest back along the (conversation, time) index, not its whole history.
  const latest = conversations.length
    ? await prisma.$queryRaw<{ conversationId: string; body: string }[]>`
        SELECT c.id AS "conversationId", m.body FROM unnest(${conversations.map((c) => c.id)}::text[]) AS c(id)
        CROSS JOIN LATERAL (
          SELECT left(body, 1000) AS body FROM conversation_message
          WHERE "conversationId" = c.id AND NOT note ORDER BY "createdAt" DESC, id DESC LIMIT 1
        ) m`
    : [];
  const bodies = new Map(latest.map((m) => [m.conversationId, m.body]));
  const companies = await conversationCompanies(projectId, conversations);

  return (
    // From laptop width up, the rest of the window under the header and any banners (-mt-6 etc.: over the page's own padding).
    <div
      data-slot="pane-layout"
      data-fills-window
      className={cn(
        "-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:grid lg:min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]",
        "min-[90rem]:grid-cols-[10rem_22rem_minmax(0,1fr)] min-[90rem]:grid-rows-1",
      )}
    >
      {member && <PageHeader title="Inbox" className="px-6 pt-6" more={<NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />} />}
      {/* On a phone, the list or the conversation (its Back is to the list). */}
      <nav
        aria-label="Views"
        className={cn(
          "mx-6 mt-4 flex flex-wrap gap-1 border-b lg:mx-0 lg:mt-0 lg:border-r lg:px-3",
          "min-[90rem]:flex-col min-[90rem]:flex-nowrap min-[90rem]:gap-0.5 min-[90rem]:overflow-y-auto min-[90rem]:border-b-0 min-[90rem]:p-3",
          open !== null && "max-lg:hidden",
        )}
      >
        {views.map((v, i) => (
          <Link
            key={v}
            href={inboxHref(slug, v)}
            // The view the list shows: the page itself, or, with a conversation open, the one beside it.
            aria-current={v === view ? (open === null ? "page" : "true") : undefined}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-2 text-sm transition-colors",
              "min-[90rem]:mb-0 min-[90rem]:flex min-[90rem]:justify-between min-[90rem]:rounded-md min-[90rem]:border-b-0 min-[90rem]:py-1.5 min-[90rem]:hover:bg-muted",
              v === view
                ? "border-primary font-medium text-foreground min-[90rem]:bg-muted"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {VIEWS[v].title} <span className="text-muted-foreground tabular-nums">{counts[i]}</span>
          </Link>
        ))}
      </nav>

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
                  const body = bodies.get(c.id);
                  const line = body === undefined ? undefined : rowLine(c.subject, body);
                  return (
                    <ItemRow
                      key={c.number}
                      selected={c.number === open}
                      leading={
                        <Avatar className="size-8">
                          {c.user?.image && <AvatarImage src={c.user.image} alt="" />}
                          <AvatarFallback>{initial(name)}</AvatarFallback>
                        </Avatar>
                      }
                      title={
                        // Named for screen readers by whom, what and which: one person's conversations told apart.
                        <Link
                          href={inboxHref(slug, view, c.number)}
                          scroll={false}
                          data-row-link={c.number}
                          aria-current={c.number === open ? "page" : undefined}
                          aria-label={`${name}${company ? `, ${company}` : ""}: ${c.subject} (#${c.number})`}
                          className="hover:underline"
                        >
                          {name}
                          {company && <span className="font-normal text-muted-foreground"> · {company}</span>}
                        </Link>
                      }
                      badges={
                        // Spam waits on nobody, however it came in.
                        view !== "spam" &&
                        c.status === "OPEN" &&
                        c.waitingSince && <Badge variant="highlight">Needs reply · {shortDuration(c.waitingSince)}</Badge>
                      }
                      meta={
                        <>
                          {/* Long words (a pasted link) wrap, rather than running out of the row. */}
                          <span className="wrap-anywhere">
                            <span className="text-foreground">{c.subject}</span>
                            {line && ` · ${line}`}
                          </span>
                          <span className="block">
                            #{c.number}
                            {c.assignee && ` · ${c.assignee.name}`}
                            {view === "snoozed" && c.snoozedUntil && ` · back ${timeAgo(c.snoozedUntil)}`}
                          </span>
                        </>
                      }
                      actions={<span className="text-xs whitespace-nowrap text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>}
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
