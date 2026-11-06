import { type EmailStatus, prisma } from "@tuti/db";
import { aiPaused, cappedProjects, historySince, inSomePlansHistory, NEW_PROJECT_EMAILS_PER_DAY, UNUSED_UPLOAD_HOURS, visibleConversations } from "@tuti/jobs";
import { aiEnabled, historyDays, plansEnabled } from "@tuti/shared";
import { cn } from "cn";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConversationPane, InboxPanes, inboxHref, inboxView } from "@/components/inbox/inbox-panes";
import { DetailsToggle } from "@/components/inbox/conversation-details";
import { ConversationPosts } from "@/components/inbox/conversation-posts";
import { AssignMenu, CloseButton, MarkStatusButton, SnoozeMenu, SpamButton, SummarizeButton } from "@/components/inbox/conversation-controls";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { MessageText } from "@/components/inbox/message-text";
import { AboutButton, PersonDetails } from "@/components/inbox/person-details";
import { PersonPanel } from "@/components/inbox/person-panel";
import { RefreshAt } from "@/components/inbox/refresh-at";
import { ReplyForm } from "@/components/inbox/reply-form";
import { ScrollToEnd } from "@/components/scroll-to-end";
import { PageHeader } from "@/components/page-header";
import { SampleBadge } from "@/components/sample-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName } from "@/lib/conversation-statuses";
import { timeAgo } from "@/lib/format";
import { DETAILS_HIDDEN_COOKIE } from "@/lib/inbox-details";
import { isAdminRole } from "@/lib/roles";
import { attachmentLinks } from "@/server/attachments";
import { anyArticleToSend, readerToSend } from "@/server/docs-search";
import { supportDomain } from "@/server/inbound";
import { getMembership } from "@/server/membership";
import { answersEnabled } from "@/server/operations/docs-ask";
import { onlineUntil, presenceKey } from "@/server/presence";
import { conversationPerson } from "@/server/operations/conversations";
import { postsLikeConversation } from "@/server/post-lists";

const ORIGINS = { WIDGET: "the widget", EMAIL: "email", ESCALATION: "an AI answer", API: "the API" } as const;
/** A team message's email, as its page says it (bounces and complaints from Amazon SES's events). */
const EMAIL_STATUS: Record<EmailStatus, (error: string | null) => string> = {
  SENT: () => "Emailed",
  DELIVERED: () => "Emailed and delivered",
  BOUNCED: (error) => `The email bounced${error ? `: ${error}` : ""}`,
  COMPLAINED: () => "They marked the email as spam, so replies aren't emailed to them any more",
  FAILED: (error) => `Couldn't email it${error ? `: ${error}` : ""}`,
};

/** One conversation: its messages, the reply box, status, assignee and spam; beside the inbox's list, in its view (`?view=`). */
export default async function ConversationPage(props: PageProps<"/app/[project]/inbox/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const view = inboxView((await props.searchParams).view);
  const membership = await getMembership(slug);
  if (!membership || !Number.isInteger(number) || number < 1) {
    notFound();
  }
  const projectId = membership.project.id;

  // Replies wait to be emailed while the project's email is paused.
  const emailPaused =
    plansEnabled() && !!supportDomain() && !!(await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } })).emailPausedAt;
  const history = await historySince(projectId);
  const [conversation, team] = await Promise.all([
    prisma.conversation.findUnique({
      where: { projectId_number: { projectId, number }, AND: [visibleConversations(history)] },
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        origin: true,
        spam: true,
        sample: true,
        email: true,
        name: true,
        emailVerified: true,
        snoozedUntil: true,
        assigneeId: true,
        userId: true,
        visitorHash: true,
        createdAt: true,
        user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
        posts: { orderBy: { createdAt: "asc" }, select: { post: { select: { number: true, title: true, status: true } } } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            author: true,
            body: true,
            note: true,
            fromAddress: true,
            original: true,
            seenAt: true,
            importId: true,
            emailStatus: true,
            emailError: true,
            createdAt: true,
            authorUser: { select: { name: true } },
            attachments: { orderBy: { createdAt: "asc" }, select: { id: true, key: true, filename: true, contentType: true, size: true } },
            attachmentsDropped: true,
          },
        },
      },
    }),
    prisma.teamMember.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { userId: true, user: { select: { name: true, image: true } } },
    }),
  ]);
  if (!conversation) {
    // Closed before the plan's history starts: kept (for a while), and back with a plan that reaches it.
    const past = history && (await prisma.conversation.findUnique({ where: { projectId_number: { projectId, number } }, select: { activeAt: true, updatedAt: true } }));
    if (past) {
      const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
      return (
        <InboxPanes slug={slug} view={view} open={number}>
          <PastHistory slug={slug} view={view} number={number} days={historyDays(plan)!} admin={isAdminRole(membership.role)} upgrade={inSomePlansHistory(past)} />
        </InboxPanes>
      );
    }
    notFound();
  }
  // Signed as the page renders: an image is shown, any other file is saved under its name.
  // Out of AI credits: the AI's buttons show, disabled (the layout says why).
  const paused = aiEnabled() && (await aiPaused(projectId));
  const [signed, related] = await Promise.all([attachmentLinks(conversation.messages.flatMap((m) => m.attachments)), postsLikeConversation(projectId, conversation)]);
  const links = new Map(signed.map((a) => [a.id, a]));

  const person = conversationPerson(conversation);
  // Where replies would be emailed at all: they wait while the project's email is paused, and in its
  // first week past its daily cap, until tomorrow.
  const emailable = !conversation.spam && !!person.email;
  const waitsForPause = emailPaused && emailable;
  const capped = !emailPaused && emailable && (await cappedProjects()).includes(projectId);
  const waits = waitsForPause
    ? "Not emailed while your project's email is paused (Settings → Inbox and email)"
    : capped
      ? `Emailed tomorrow: in its first week, a project sends up to ${NEW_PROJECT_EMAILS_PER_DAY} emails a day`
      : undefined;
  const online =
    conversation.userId || conversation.visitorHash
      ? await onlineUntil(projectId, presenceKey({ userId: conversation.userId, visitorHash: conversation.visitorHash }))
      : null;
  const personName = person.name ?? person.email ?? "Unknown";
  // Waiting is the team having replied last: replying sets it; by hand, only once their reply is the latest.
  const answered = conversation.messages.findLast((m) => !m.note)?.author === "TEAM";
  // What's done with every conversation: in the top bar, and on phones under the title as well as in its menu.
  const actions = (
    <>
      <AssignMenu
        projectSlug={slug}
        number={conversation.number}
        assigneeId={conversation.assigneeId}
        me={membership.userId}
        team={team.map((m) => ({ userId: m.userId, name: m.user.name, image: m.user.image }))}
      />
      {!conversation.spam && conversation.status !== "CLOSED" && (
        <SnoozeMenu
          projectSlug={slug}
          number={conversation.number}
          // Till then; once it's passed, not snoozed (the wake job opens it).
          snoozedUntil={conversation.snoozedUntil && conversation.snoozedUntil > new Date() ? conversation.snoozedUntil.toISOString() : null}
        />
      )}
      <CloseButton projectSlug={slug} number={conversation.number} closed={conversation.status === "CLOSED"} />
    </>
  );

  // The column beside the messages, hidden or not as this browser left it (DetailsToggle).
  const detailsHidden = (await cookies()).get(DETAILS_HIDDEN_COOKIE)?.value === "1";

  return (
    <InboxPanes slug={slug} view={view} open={conversation.number}>
      <ConversationPane open detailsHidden={detailsHidden}>
        <PageHeader
          back={{ href: inboxHref(slug, view), label: "Inbox" }}
          title={conversation.subject}
          meta={
            <>
              {conversation.sample && <SampleBadge />}
              {online && (
                <>
                  {/* Shown until it runs out; coming online refreshes the page through its live stream. */}
                  <RefreshAt at={online.toISOString()} />
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <span aria-hidden className="size-2 rounded-full bg-primary" />
                    Online
                  </span>{" "}
                  ·{" "}
                </>
              )}
              {CONVERSATION_STATUS_LABELS[conversation.status.toLowerCase() as ConversationStatusName]} · #{conversation.number} · {personName}
              {person.email && person.name && ` (${person.email}${person.verified ? "" : ", not verified"})`}
              {!person.name && person.email && !person.verified && " (not verified)"} · started from {ORIGINS[conversation.origin]}{" "}
              {timeAgo(conversation.createdAt)}
            </>
          }
          // On phones in the top bar's menu too, for when the row under the title has scrolled away.
          actions={
            <>
              {actions}
              <DetailsToggle hidden={detailsHidden} />
            </>
          }
          more={
            <>
              <AboutButton name={personName} />
              {conversation.status === "OPEN" && answered && <MarkStatusButton projectSlug={slug} number={conversation.number} status="waiting" />}
              {conversation.status === "WAITING" && <MarkStatusButton projectSlug={slug} number={conversation.number} status="open" />}
              {aiEnabled() && <SummarizeButton projectSlug={slug} number={conversation.number} paused={paused} />}
              <SpamButton projectSlug={slug} number={conversation.number} spam={conversation.spam} />
            </>
          }
        />

        <div className="-mt-3 hidden flex-wrap gap-2 phonebar:flex">{actions}</div>
        {conversation.spam && <Badge variant="outline">Spam</Badge>}

        {/* The pane's height at least, so the reply box is at the bottom of the screen with few messages too. Laid out by
            the pane's width (the list beside it takes some), not the window's. From laptop width up it's what scrolls in
            the pane, under its meta line (-mx-6 px-6: its scrollbar at the pane's edge), and its height (100cqh) is what
            beside the messages is held to, whatever is above it; relative, so what's placed absolutely in it (a file
            input, labels for screen readers) stays in it, not past the page's end. */}
        <div id="conversation" className="@container flex flex-1 flex-col lg:relative lg:-mx-6 lg:min-h-0 lg:overflow-y-auto lg:px-6 lg:pb-6 lg:[container-type:size]">
          <div className="flex flex-1 flex-col gap-4 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_18rem] @3xl:gap-6 @3xl:in-data-[details=hidden]:grid-cols-1">
            {/* Beside it: the posts it's about, then the person (a sheet where the pane is narrow, the posts staying in it). Held
                in view as the messages scroll (the page's scroll on phones, the pane's beside the list), scrolling on its own when
                taller than the screen (so it never makes the row taller). Hidden by DetailsToggle, the messages take its room. */}
            <div
              id="conversation-details"
              className="flex flex-col gap-4 *:shrink-0 @3xl:sticky @3xl:top-16 @3xl:col-start-2 @3xl:row-start-1 @3xl:max-h-[calc(100svh-5.5rem)] @3xl:self-start @3xl:overflow-y-auto lg:@3xl:top-0 lg:@3xl:max-h-[100cqh] @3xl:in-data-[details=hidden]:hidden"
            >
              <Card size="sm">
                <CardContent>
                  <ConversationPosts projectSlug={slug} number={conversation.number} posts={conversation.posts.map((link) => link.post)} related={related} />
                </CardContent>
              </Card>
              <PersonDetails name={personName}>
                <PersonPanel
                  projectId={projectId}
                  slug={slug}
                  // Its name as the page shows it: an emailed name only once the address is verified.
                  person={{ ...conversation, name: person.name }}
                  besides={conversation.number}
                  inbox={{ view, userId: membership.userId }}
                />
              </PersonDetails>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-4 @3xl:col-start-1 @3xl:row-start-1">
              <ol className="flex flex-col gap-3" aria-label="Messages">
                {conversation.messages.map((message) => {
                  const fromTeam = message.author !== "USER";
                  // Someone else on the email (in Cc) shows as their address.
                  const name =
                    message.author === "USER"
                      ? (message.fromAddress ?? personName)
                      : (message.authorUser?.name ?? (message.author === "AI" ? "AI" : "Tuti"));
                  return (
                    <li key={message.id} className={cn("flex", fromTeam && "justify-end", message.note && "justify-center")}>
                      <Card size="sm" className={cn("max-w-[85%]", fromTeam && "bg-muted", message.note && "border-dashed bg-highlight/40")}>
                        <CardContent className="flex flex-col gap-1">
                          <p className="text-xs text-muted-foreground">
                            {message.note && <span className="font-medium text-foreground">Note · </span>}
                            <span className="font-medium text-foreground">{name}</span> · {timeAgo(message.createdAt)}
                          </p>
                          <p className="text-sm break-words whitespace-pre-wrap">
                            <MessageText text={message.body} ugc={message.author === "USER"} />
                          </p>
                          <MessageAttachments attachments={message.attachments.map((a) => links.get(a.id)!)} dropped={message.attachmentsDropped} imported={!!message.importId} />
                          {message.author === "TEAM" && !message.note && (message.seenAt || message.importId || message.emailStatus || waits) && (
                            <p className="text-xs text-muted-foreground">
                              {/* Imported history was never emailed: no email status for it (docs/plan.md, Switching from Featurebase). */}
                              {message.seenAt
                                ? "Seen"
                                : message.importId
                                  ? "Imported from Featurebase"
                                  : message.emailStatus
                                    ? EMAIL_STATUS[message.emailStatus](message.emailError)
                                    : waits}
                            </p>
                          )}
                          {message.original && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer">Show the whole email</summary>
                              <p className="mt-1 break-words whitespace-pre-wrap">
                                <MessageText text={message.original} ugc={message.author === "USER"} />
                              </p>
                            </details>
                          )}
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ol>

              {/* Opens at the newest message, and follows new ones. */}
              <ScrollToEnd count={conversation.messages.length} within="conversation" />
              {/* Stays at the bottom of the screen as the messages scroll under it (-mb-6 and pb-6: over the pane's own padding).
                  Tuti's chat launcher isn't in the Inbox (AppWidget), so nothing sits over its buttons. */}
              <div className="sticky bottom-0 -mb-6 mt-auto bg-background pt-2 pb-6">
                <ReplyForm
                  projectSlug={slug}
                  number={conversation.number}
                  userId={membership.userId}
                  // An hour short of when the hourly cleanup may delete a file never sent.
                  filesLastFor={(UNUSED_UPLOAD_HOURS - 1) * 60 * 60 * 1000}
                  draftWithAi={answersEnabled() ? (paused ? "paused" : "on") : "off"}
                  // "Insert article": once there's an article they can be sent (what its search finds).
                  articles={await anyArticleToSend(projectId, await readerToSend(projectId, conversation.userId))}
                  seen={conversation.messages.at(-1)?.createdAt.toISOString()}
                  emailWaits={waits}
                />
              </div>
            </div>
          </div>
        </div>
      </ConversationPane>
    </InboxPanes>
  );
}

/**
 * A conversation with nothing done in it for longer than the plan's history (`days`): what happened to it, and how to see it
 * again. `upgrade`: it's in some plan's history (inSomePlansHistory), so an upgrade shows it; past every plan's, nothing does.
 */
function PastHistory({ slug, view, number, days, admin, upgrade }: { slug: string; view: ReturnType<typeof inboxView>; number: number; days: number; admin: boolean; upgrade: boolean }) {
  return (
    <ConversationPane open>
      <PageHeader back={{ href: inboxHref(slug, view), label: "Inbox" }} title={`Conversation #${number}`} />
      <EmptyState
        title="Past your plan's history"
        description={`Nothing has happened in it for more than ${days} days, longer than your plan keeps inbox history. ${
          !upgrade ? "" : admin ? "Upgrade to see it again." : "An owner or admin can upgrade to see it again."
        }`.trim()}
        action={
          admin &&
          upgrade && (
            <Link href={`/app/${slug}/settings/billing`} className={buttonVariants()}>
              See plans
            </Link>
          )
        }
      />
    </ConversationPane>
  );
}
