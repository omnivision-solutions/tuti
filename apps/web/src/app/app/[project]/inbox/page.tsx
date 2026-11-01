import { type Prisma, prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { NewConversationEmailsButton } from "@/components/inbox/conversation-controls";
import { ListKeys } from "@/components/inbox/list-keys";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { shortDuration, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { awake, conversationPerson } from "@/server/operations/conversations";
import { getSession } from "@/server/session";

/** The inbox's views: what needs an answer first, then the rest. */
const VIEWS = {
  open: { title: "Open", empty: "Nothing waits for an answer." },
  mine: { title: "Mine", empty: "Nothing's assigned to you." },
  unassigned: { title: "Unassigned", empty: "Every open conversation has someone on it." },
  waiting: { title: "Waiting on user", empty: "No conversations wait on a user." },
  snoozed: { title: "Snoozed", empty: "Nothing's snoozed." },
  closed: { title: "Closed", empty: "No closed conversations yet." },
  spam: { title: "Spam", empty: "No spam." },
} as const;
type View = keyof typeof VIEWS;

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

export default async function InboxPage(props: PageProps<"/app/[project]/inbox">) {
  const { project: slug } = await props.params;
  const { view: param } = await props.searchParams;
  // Own keys only: `in` would also take inherited names like "constructor".
  const view: View = typeof param === "string" && Object.hasOwn(VIEWS, param) ? (param as View) : "open";
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const projectId = membership.project.id;
  const userId = session.user.id;
  const member = await prisma.teamMember.findUniqueOrThrow({
    where: { projectId_userId: { projectId, userId } },
    select: { emailNewConversations: true },
  });

  const views = Object.keys(VIEWS) as View[];
  const [counts, conversations] = await Promise.all([
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
        assignee: { select: { name: true } },
        user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
      },
    }),
  ]);
  const base = `/app/${slug}/inbox`;
  const href = (v: View) => (v === "open" ? base : `${base}?view=${v}`);

  return (
    <>
      <PageHeader
        title="Inbox"
        more={<NewConversationEmailsButton projectSlug={slug} on={member.emailNewConversations} />}
      />
      <SubNav
        label="Views"
        current={href(view)}
        items={views.map((v, i) => ({
          href: href(v),
          title: (
            <>
              {VIEWS[v].title} <span className="text-muted-foreground tabular-nums">{counts[i]}</span>
            </>
          ),
        }))}
      />

      {conversations.length === 0 ? (
        <EmptyState title={VIEWS[view].empty} description="Conversations come from the API for now." />
      ) : (
        <ListKeys>
          <Card size="sm">
            <CardContent>
              <ItemList>
                {conversations.map((c) => {
                  const person = conversationPerson(c);
                  return (
                    <ItemRow
                      key={c.number}
                      title={
                        <Link href={`${base}/${c.number}`} data-row-link className="hover:underline">
                          {c.subject}
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
                          #{c.number} · {person.name ?? person.email ?? "Unknown"}
                          {c.assignee && ` · ${c.assignee.name}`} · {timeAgo(c.lastMessageAt)}
                          {view === "snoozed" && c.snoozedUntil && ` · back ${timeAgo(c.snoozedUntil)}`}
                        </>
                      }
                    />
                  );
                })}
              </ItemList>
            </CardContent>
          </Card>
        </ListKeys>
      )}
    </>
  );
}
