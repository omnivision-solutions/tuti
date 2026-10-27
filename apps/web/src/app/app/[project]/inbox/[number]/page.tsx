import { prisma } from "@tuti/db";
import { cn } from "cn";
import { notFound } from "next/navigation";

import { ConversationAssigneeSelect, ConversationStatusSelect, SpamButton } from "@/components/inbox/conversation-controls";
import { PersonDetails } from "@/components/inbox/person-details";
import { PersonPanel } from "@/components/inbox/person-panel";
import { ReplyForm } from "@/components/inbox/reply-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { isOnline, presenceKey } from "@/server/presence";
import { conversationPerson } from "@/server/operations/conversations";

const ORIGINS = { WIDGET: "the widget", EMAIL: "email", ESCALATION: "an AI answer", API: "the API" } as const;

/** One conversation: its messages, the reply box, status, assignee and spam. */
export default async function ConversationPage(props: PageProps<"/app/[project]/inbox/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const membership = await getMembership(slug);
  if (!membership || !Number.isInteger(number) || number < 1) {
    notFound();
  }
  const projectId = membership.project.id;

  const [conversation, team] = await Promise.all([
    prisma.conversation.findUnique({
      where: { projectId_number: { projectId, number } },
      select: {
        number: true,
        subject: true,
        status: true,
        origin: true,
        spam: true,
        email: true,
        emailVerified: true,
        assigneeId: true,
        userId: true,
        visitorHash: true,
        createdAt: true,
        user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true, author: true, body: true, note: true, createdAt: true, authorUser: { select: { name: true } } },
        },
      },
    }),
    prisma.teamMember.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  if (!conversation) {
    notFound();
  }
  const person = conversationPerson(conversation);
  const online =
    (conversation.userId || conversation.visitorHash) &&
    (await isOnline(projectId, presenceKey({ userId: conversation.userId, visitorHash: conversation.visitorHash })));
  const personName = person.name ?? person.email ?? "Unknown";

  return (
    <>
      <PageHeader
        back={{ href: `/app/${slug}/inbox`, label: "Inbox" }}
        title={conversation.subject}
        description={
          <>
            {online && (
              <>
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <span aria-hidden className="size-2 rounded-full bg-primary" />
                  Online
                </span>{" "}
                ·{" "}
              </>
            )}
            #{conversation.number} · {personName}
            {person.email && person.name && ` (${person.email}${person.verified ? "" : ", not verified"})`}
            {!person.name && person.email && !person.verified && " (not verified)"} · started from {ORIGINS[conversation.origin]}{" "}
            {timeAgo(conversation.createdAt)}
          </>
        }
        actions={
          <>
            <ConversationAssigneeSelect
              projectSlug={slug}
              number={conversation.number}
              assigneeId={conversation.assigneeId}
              team={team.map((m) => ({ userId: m.userId, name: m.user.name }))}
            />
            <ConversationStatusSelect
              projectSlug={slug}
              number={conversation.number}
              status={conversation.status.toLowerCase() as "open" | "waiting" | "closed"}
            />
          </>
        }
        more={<SpamButton projectSlug={slug} number={conversation.number} spam={conversation.spam} />}
      />

      {conversation.spam && <Badge variant="outline">Spam</Badge>}

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-6">
        <PersonDetails name={personName}>
          <PersonPanel projectId={projectId} slug={slug} conversation={conversation} />
        </PersonDetails>
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <ol className="flex flex-col gap-3" aria-label="Messages">
            {conversation.messages.map((message) => {
              const fromTeam = message.author !== "USER";
              const name = message.author === "USER" ? personName : (message.authorUser?.name ?? (message.author === "AI" ? "AI" : "Tuti"));
              return (
                <li key={message.id} className={cn("flex", fromTeam && "justify-end", message.note && "justify-center")}>
                  <Card size="sm" className={cn("max-w-[85%]", fromTeam && "bg-muted", message.note && "border-dashed bg-highlight/40")}>
                    <CardContent className="flex flex-col gap-1">
                      <p className="text-xs text-muted-foreground">
                        {message.note && <span className="font-medium text-foreground">Note · </span>}
                        <span className="font-medium text-foreground">{name}</span> · {timeAgo(message.createdAt)}
                      </p>
                      <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ol>

          <ReplyForm projectSlug={slug} number={conversation.number} />
        </div>
      </div>
    </>
  );
}
