import { type EmailStatus, prisma } from "@tuti/db";
import { aiPaused, cappedProjects, historySince, inSomePlansHistory, NEW_PROJECT_EMAILS_PER_DAY, replyRecipient, UNUSED_UPLOAD_HOURS, visibleConversations } from "@tuti/jobs";
import { aiEnabled, historyDays, plansEnabled } from "@tuti/shared";
import { cn } from "cn";
import { EyeIcon, ClockIcon, ListIcon, LockKeyholeIcon, MailIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConversationPane, inboxPages, InboxPanes, inboxHref, inboxView } from "@/components/inbox/inbox-panes";
import { MarkRead } from "@/components/inbox/mark-read";
import { EarlierMessages } from "@/components/inbox/load-more";
import { DetailsToggle, DetailsPanel } from "@/components/inbox/conversation-details";
import { ViewerDate } from "@/components/inbox/viewer-date";
import { ConversationPosts, LinkPostButton } from "@/components/inbox/conversation-posts";
import {
  AssignMenu,
  ConversationStatusMenu,
  CloseButton,
  MarkStatusButton,
  SnoozeMenu,
  SpamButton,
  SummarizeButton,
} from "@/components/inbox/conversation-controls";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { MessageDay } from "@/components/inbox/message-day";
import { MessageText } from "@/components/inbox/message-text";
import { DetailSection } from "@/components/inbox/detail-section";
import { ConversationMore } from "@/components/inbox/more-actions";
import { BackLink } from "@/components/back-link";
import { PersonPanel } from "@/components/inbox/person-panel";
import { RefreshAt } from "@/components/inbox/refresh-at";
import { ReplyForm } from "@/components/inbox/reply-form";
import { ScrollToEnd } from "@/components/scroll-to-end";
import { PageHeader } from "@/components/page-header";
import { SampleBadge } from "@/components/sample-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_STYLES, type ConversationStatusName } from "@/lib/conversation-statuses";
import { initial, timeAgo } from "@/lib/format";
import { DETAILS_HIDDEN_COOKIE } from "@/lib/inbox-details";
import { isAdminRole } from "@/lib/roles";
import { conversationReads } from "@/server/conversation-reads";
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

/** A conversation shows its latest this many messages, and this many earlier ones with each "Show earlier messages" (`?messages=`). */
const MESSAGES_PER_PAGE = 50;

/**
 * One conversation: its latest messages, the reply box, status, assignee and spam; beside the inbox's list, in its view
 * (`?view=`), as long as it's been loaded (`?page=`).
 */
export default async function ConversationPage(props: PageProps<"/app/[project]/inbox/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const searchParams = await props.searchParams;
  const view = inboxView(searchParams.view);
  const pages = inboxPages(searchParams.page);
  const messagePages = inboxPages(searchParams.messages);
  const shown = MESSAGES_PER_PAGE * messagePages;
  const membership = await getMembership(slug);
  if (!membership || !Number.isInteger(number) || number < 1) {
    notFound();
  }
  const projectId = membership.project.id;

  // Replies wait to be emailed while the project's email is paused.
  const emailPaused =
    plansEnabled() &&
    !!supportDomain() &&
    !!(await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } })).emailPausedAt;
  const history = await historySince(projectId);
  const [conversation, team, said] = await Promise.all([
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
        _count: { select: { messages: true } },
        // The latest ones, newest first (put in order below).
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: shown,
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
    // Who wrote last, past the messages shown too (a run of notes can fill them).
    prisma.conversationMessage.findFirst({
      where: { conversation: { projectId, number }, note: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { author: true },
    }),
  ]);
  if (!conversation) {
    // Closed before the plan's history starts: kept (for a while), and back with a plan that reaches it.
    const past =
      history && (await prisma.conversation.findUnique({ where: { projectId_number: { projectId, number } }, select: { activeAt: true, updatedAt: true } }));
    if (past) {
      const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
      return (
        <InboxPanes slug={slug} view={view} open={number} pages={pages}>
          <PastHistory
            slug={slug}
            view={view}
            pages={pages}
            number={number}
            days={historyDays(plan)!}
            admin={isAdminRole(membership.role)}
            upgrade={inSomePlansHistory(past)}
          />
        </InboxPanes>
      );
    }
    notFound();
  }
  const read = (await conversationReads([conversation.id], membership.userId)).get(conversation.id);
  conversation.messages.reverse();
  // Signed as the page renders: an image is shown, any other file is saved under its name.
  // Out of AI credits: the AI's buttons show, disabled (the layout says why).
  const paused = aiEnabled() && (await aiPaused(projectId));
  const [signed, related] = await Promise.all([
    attachmentLinks(conversation.messages.flatMap((m) => m.attachments)),
    postsLikeConversation(projectId, conversation),
  ]);
  const links = new Map(signed.map((a) => [a.id, a]));

  const person = conversationPerson(conversation);
  // Where replies would be emailed at all: they wait while the project's email is paused, and in its
  // first week past its daily cap, until tomorrow.
  const blocked = person.email
    ? await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId, email: person.email.toLowerCase() } }, select: { email: true } })
    : null;
  const emailable = !conversation.spam && !!person.email && !blocked;
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
  const answered = said?.author === "TEAM";
  // The column beside the messages, hidden or not as this browser left it (DetailsToggle).
  const detailsHidden = (await cookies()).get(DETAILS_HIDDEN_COOKIE)?.value === "1";
  const canSnooze = !conversation.spam && conversation.status !== "CLOSED";
  const snoozedUntil = canSnooze && conversation.snoozedUntil && conversation.snoozedUntil > new Date() ? conversation.snoozedUntil.toISOString() : null;
  const posts = conversation.posts.map((link) => link.post);

  return (
    <InboxPanes slug={slug} view={view} open={conversation.number} pages={pages} messages={messagePages}>
      <MarkRead slug={slug} number={number} seen={conversation.messages.at(-1)?.createdAt.toISOString() ?? null} unread={read?.unread ?? false} />
      <ConversationPane open detailsHidden={detailsHidden}>
        <header data-slot="page-header" data-inbox-header className="@container/conversation-head inbox-conversation-head inbox-surface col-start-1 row-start-1 rounded-b-none px-6 py-3 shadow-none @max-[57rem]/app:px-3.5 @max-[57rem]/app:pt-3.5 @min-[77rem]/app:group-data-[details=hidden]/thread:px-8 [&>a]:mb-2.25 [&>a]:text-xs [&>a]:leading-5 max-md:[&>a]:mb-3 min-w-0 min-h-0 bg-card rounded-t-2xl max-md:rounded-t-xl">
          <BackLink href={inboxHref(slug, view, null, pages)}>Inbox</BackLink>
          <div className="inbox-title-row flex items-start justify-between gap-3 @max-[57rem]/app:gap-2 [&>h1]:min-w-0 [&>h1]:flex-1 [&>h1]:text-[1.5625rem] [&>h1]:leading-[1.2] [&>h1]:font-[650] [&>h1]:tracking-[-0.025em] [&>h1]:wrap-anywhere @max-[57rem]/app:[&>h1]:text-[1.4375rem] @max-[57rem]/app:[&>h1]:leading-[1.18] @min-[77rem]/app:group-data-[details=hidden]/thread:[&>h1]:text-[1.6875rem]">
            <h1 title={conversation.subject}>{conversation.subject}</h1>
            <div className="inbox-title-actions flex flex-none items-center gap-0.5 @max-[57rem]/app:gap-px [&>button]:h-8 [&>button:first-child]:gap-1 [&>button:first-child]:px-2.25 max-md:[&>button:first-child]:px-1.75 [&>button:first-child>svg]:size-3.5">
              <CloseButton projectSlug={slug} number={conversation.number} closed={conversation.status === "CLOSED"} />
              <ConversationMore>
                <LinkPostButton projectSlug={slug} number={conversation.number} linked={posts.map((post) => post.number)} />
                {conversation.status === "OPEN" && answered && <MarkStatusButton projectSlug={slug} number={conversation.number} status="waiting" />}
                {conversation.status === "WAITING" && <MarkStatusButton projectSlug={slug} number={conversation.number} status="open" />}
                {aiEnabled() && <SummarizeButton projectSlug={slug} number={conversation.number} paused={paused} />}
                <SpamButton projectSlug={slug} number={conversation.number} spam={conversation.spam} />
              </ConversationMore>
              <DetailsToggle hidden={detailsHidden} />
            </div>
          </div>
          <p className="inbox-conversation-meta mt-2.25 flex flex-wrap items-center gap-1.5 text-xs leading-5 text-muted-foreground wrap-anywhere max-md:mt-2.5">
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
              <span className={cn("inbox-conversation-state inline-flex items-center gap-1.25 rounded-full px-1.75 [&>span]:size-1.25 [&>span]:rounded-full", CONVERSATION_STATUS_STYLES[conversation.status].pill)}>
                <span aria-hidden className={CONVERSATION_STATUS_STYLES[conversation.status].dot} />
                {conversation.status === "OPEN" ? "Needs reply" : CONVERSATION_STATUS_LABELS[conversation.status.toLowerCase() as ConversationStatusName]}
              </span>{" "}
              <span>
                #{conversation.number} · {personName}{person.email && !person.verified && " (not verified)"}
              </span>
              <span className={cn("inbox-origin", conversation.origin !== "ESCALATION" && "max-md:hidden")}>
                {conversation.origin === "ESCALATION" ? " · started from an AI answer" : ` · via ${ORIGINS[conversation.origin].replace(/^the /, "")}`}
              </span>
            </>
          </p>
          {conversation.spam && <Badge variant="outline">Spam</Badge>}
        </header>
        <div id="conversation" className="inbox-conversation-body inbox-surface relative col-start-1 row-start-2 overflow-y-auto rounded-t-none shadow-none [scrollbar-width:thin] max-md:[mask-image:linear-gradient(to_bottom,transparent_0,black_1.25rem,black_100%)] min-w-0 min-h-0 bg-card rounded-b-2xl max-md:rounded-b-xl">
          <div className="inbox-messages-and-composer flex min-h-full flex-col gap-2.5 px-6 pt-1.5 @max-[57rem]/app:px-3 @min-[77rem]/app:group-data-[details=hidden]/thread:px-9">
            <EarlierMessages
              href={inboxHref(slug, view, conversation.number, pages, messagePages + 1)}
              first={conversation.messages[0]?.id ?? ""}
              more={conversation._count.messages > shown}
            />
            <ol className="inbox-messages flex flex-col gap-3 pb-2" aria-label="Messages">
              {conversation.messages.map((message, index) => {
                const fromTeam = message.author !== "USER";
                // Someone else on the email (in Cc) shows as their address.
                const name =
                  message.author === "USER" ? (message.fromAddress ?? personName) : (message.authorUser?.name ?? (message.author === "AI" ? "AI" : "Tuti"));
                return (
                  <li key={message.id} data-message={message.id}>
                    <MessageDay at={message.createdAt.toISOString()} previous={conversation.messages[index - 1]?.createdAt.toISOString()} />
                    <div className={cn("inbox-message flex items-end gap-2", fromTeam && "team flex-row-reverse justify-start", message.note && "note mx-5 flex-row justify-center @max-[57rem]/app:mx-3.75 @min-[77rem]/app:group-data-[details=hidden]/thread:mx-17.5")}>
                      <Avatar className={cn("inbox-chat-avatar mb-5.75 size-6.5 flex-none text-xs max-md:size-6", message.note && "hidden")}>
                        <AvatarFallback>{initial(name)}</AvatarFallback>
                      </Avatar>
                      <div className={cn("inbox-message-body min-w-0 max-w-[min(65ch,calc(100%_-_3.75rem))] max-md:max-w-[calc(100%_-_2.8125rem)]", message.note && "max-w-full max-md:max-w-full")}>
                        <div className={cn("inbox-bubble rounded-xl rounded-bl-sm bg-inbox-customer px-3.25 py-2.25 wrap-anywhere max-md:px-2.75 [&_p]:text-sm [&>p:not(.inbox-message-by)]:leading-normal", fromTeam && "rounded-bl-xl rounded-br-sm bg-inbox-team", message.note && "rounded-lg border border-dashed border-highlight-foreground/40 bg-inbox-note px-3 py-2 max-md:px-3 max-md:py-2 [&_.inbox-note-by]:text-xs [&_.inbox-note-by]:leading-4.5")}>
                          {message.note && (
                            <p className="inbox-note-by mb-0.5 flex items-center gap-1.25 text-xs leading-4.5 font-semibold text-highlight-foreground [&>svg]:size-3.25 [&>svg]:flex-none">
                              <LockKeyholeIcon aria-hidden />
                              Internal note · {name}
                            </p>
                          )}
                          <p className="text-sm break-words whitespace-pre-wrap">
                            <MessageText text={message.body} ugc={message.author === "USER"} />
                          </p>
                          <MessageAttachments
                            cards
                            attachments={message.attachments.map((a) => links.get(a.id)!)}
                            dropped={message.attachmentsDropped}
                            imported={!!message.importId}
                          />
                          {message.original && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer">Show the whole email</summary>
                              <p className="mt-1 break-words whitespace-pre-wrap">
                                <MessageText text={message.original} ugc={message.author === "USER"} />
                              </p>
                            </details>
                          )}
                        </div>
                        <p className={cn("inbox-message-by m-0 flex items-center gap-1.25 px-0.5 pt-0.75 text-xs leading-4.5 text-muted-foreground [&>svg]:size-3.25 [&>svg]:flex-none", fromTeam && "justify-end text-right", message.note && "justify-center text-center")}>
                          {message.note ? <LockKeyholeIcon aria-hidden /> : <MailIcon aria-hidden />}
                          {!message.note && `${name} · `}
                          {timeAgo(message.createdAt)}{" "}
                          {message.author === "TEAM" && !message.note && (message.seenAt || message.importId || message.emailStatus || waits) && (
                            <span>
                              {/* Imported history was never emailed: no email status for it (docs/plan.md, Switching from Featurebase). */}
                              {message.seenAt
                                ? "Seen"
                                : message.importId
                                  ? "Imported from Featurebase"
                                  : message.emailStatus
                                    ? EMAIL_STATUS[message.emailStatus](message.emailError)
                                    : waits}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Opens at the newest message, and follows new ones. */}
            <ScrollToEnd count={conversation._count.messages} within="conversation" />
            {/* Stays at the bottom of the screen as the messages scroll under it (-mb-6 and pb-6: over the pane's own padding).
                  Tuti's chat launcher isn't in the Inbox (AppWidget), so nothing sits over its buttons. */}
            <div className="inbox-composer-wrap sticky bottom-0 mt-auto -mx-1.5 bg-card pt-1.25 pb-2.5 @max-[57rem]/app:-mx-0.5 @min-[77rem]/app:group-data-[details=hidden]/thread:-mx-2">
              <ReplyForm
                recipient={personName}
                // Not for widget conversations: they're emailed only if unseen there for a minute, too fiddly to say here.
                emailed={!conversation.userId && !conversation.visitorHash && !waitsForPause && "to" in (await replyRecipient(conversation.id))}
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
        <DetailsPanel key={conversation.number}>
          <div className="inbox-triage leading-normal grid grid-cols-[5.125rem_minmax(0,1fr)] items-center gap-x-1 gap-y-0.75 pb-4 text-xs [&>span]:text-muted-foreground group-[.inbox-details-sheet]/details:grid-cols-[6.5rem_minmax(0,1fr)] group-[.inbox-details-sheet]/details:text-[0.875rem]">
            <span>Assignee</span>
            <AssignMenu
              projectSlug={slug}
              number={conversation.number}
              assigneeId={conversation.assigneeId}
              me={membership.userId}
              team={team.map((m) => ({ userId: m.userId, name: m.user.name, image: m.user.image }))}
            />
            <span>Status</span>
            <ConversationStatusMenu projectSlug={slug} number={conversation.number} status={conversation.status} answered={answered} />
            <span>{snoozedUntil ? "Waiting until" : "Snooze"}</span>
            {canSnooze ? (
              <SnoozeMenu
                projectSlug={slug}
                number={conversation.number}
                snoozedUntil={snoozedUntil}
              />
            ) : (
              <span>Not snoozed</span>
            )}
          </div>
          <ConversationPosts projectSlug={slug} number={conversation.number} posts={posts} related={related} />
          <PersonPanel
            projectId={projectId}
            slug={slug}
            person={{ ...conversation, name: person.name }}
            besides={conversation.number}
            inbox={{ view, pages, userId: membership.userId }}
          />
          <DetailSection title="Recent page visits" count={0} icon={EyeIcon}>
            <p className="text-sm text-muted-foreground">No page visits recorded.</p>
          </DetailSection>
          <DetailSection title="Events" count={0} icon={ClockIcon}>
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          </DetailSection>
          <DetailSection title="Conversation attributes" count={3} icon={ListIcon}>
            <dl className="grid grid-cols-[auto_1fr] gap-2 text-sm">
              <dt>Channel</dt>
              <dd>{ORIGINS[conversation.origin]}</dd>
              <dt>Started</dt>
              <dd><ViewerDate at={conversation.createdAt.toISOString()} year /></dd>
              <dt>Email verified</dt>
              <dd>{person.verified ? "Yes" : "No"}</dd>
            </dl>
          </DetailSection>
          <p className="inbox-detail-foot mt-4.5 text-xs leading-normal text-muted-foreground">
            Started from {ORIGINS[conversation.origin]} · {timeAgo(conversation.createdAt)}
          </p>
        </DetailsPanel>
      </ConversationPane>
    </InboxPanes>
  );
}

/**
 * A conversation with nothing done in it for longer than the plan's history (`days`): what happened to it, and how to see it
 * again. `upgrade`: it's in some plan's history (inSomePlansHistory), so an upgrade shows it; past every plan's, nothing does.
 */
function PastHistory({
  slug,
  view,
  pages,
  number,
  days,
  admin,
  upgrade,
}: {
  slug: string;
  view: ReturnType<typeof inboxView>;
  pages: number;
  number: number;
  days: number;
  admin: boolean;
  upgrade: boolean;
}) {
  return (
    <ConversationPane open>
      <div className="col-span-full row-span-2 flex min-w-0 flex-col gap-6 overflow-y-auto rounded-2xl bg-card p-6 shadow-inbox">
        <PageHeader className="bg-card!" back={{ href: inboxHref(slug, view, null, pages), label: "Inbox" }} title={`Conversation #${number}`} />
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
      </div>
    </ConversationPane>
  );
}
