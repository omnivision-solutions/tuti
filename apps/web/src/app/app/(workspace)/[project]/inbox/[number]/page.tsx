import type { Metadata } from "next";
import { type EmailStatus, prisma } from "@tuti/db";
import { aiPaused, cappedProjects, sameLanguage, translationSettings, emailsThisMonth, historySince, inSomePlansHistory, NEW_PROJECT_EMAILS_PER_DAY, replyRecipient, UNUSED_UPLOAD_HOURS, visibleConversations } from "@tuti/jobs";
import { aiEnabled, historyDays, plansEnabled } from "@tuti/shared";
import { cn } from "cn";
import { ListIcon, LockKeyholeIcon, MailIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConversationPane, inboxPages, InboxPanes, inboxHref, inboxQuery, inboxView } from "@/components/inbox/inbox-panes";
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
  SpamNotice,
  SummarizeButton,
} from "@/components/inbox/conversation-controls";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import { MessageDay } from "@/components/inbox/message-day";
import { MessageText } from "@/components/inbox/message-text";
import { MessageTranslation } from "@/components/inbox/message-translation";
import { DetailSection } from "@/components/inbox/detail-section";
import { ConversationActivity } from "@/components/inbox/conversation-activity";
import { ConversationMore } from "@/components/inbox/more-actions";
import { PersonPanel } from "@/components/inbox/person-panel";
import { RefreshAt } from "@/components/inbox/refresh-at";
import { ReplyForm } from "@/components/inbox/reply-form";
import { ScrollToEnd } from "@/components/scroll-to-end";
import { Pane, PaneBody, PaneHeader } from "@/components/pane";
import { SampleBadge } from "@/components/sample-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_STYLES, type ConversationStatusName } from "@/lib/conversation-statuses";
import { formatDay, initial, timeAgo } from "@/lib/format";
import { DETAILS_HIDDEN_COOKIE } from "@/lib/inbox-details";
import { IMPORT_SOURCES, type ImportSourceKey } from "@/lib/import-parts";
import { isAdminRole } from "@/lib/roles";
import { spamWhy } from "@/lib/spam-reasons";
import { conversationReads } from "@/server/conversation-reads";
import { attachmentLinks } from "@/server/attachments";
import { anyArticleToSend, readerToSend } from "@/server/docs-search";
import { supportDomain } from "@/server/inbound";
import { getMembership } from "@/server/membership";
import { answersEnabled } from "@/server/operations/docs-ask";
import { onlineUntil, presenceKey } from "@/server/presence";
import { assignableTeam, conversationPerson } from "@/server/operations/conversations";
import { conversationActivity } from "@/server/operations/conversation-activity";
import { postsLikeConversation } from "@/server/post-lists";
import { spamChoices } from "@/server/spam";
import { pageTitle } from "@/lib/page-title";

const ORIGINS = { WIDGET: "the widget", EMAIL: "email", ESCALATION: "an AI answer", API: "the API" } as const;
/** A team message's email, as its page says it (bounces and complaints from Amazon SES's events). */
const EMAIL_STATUS: Record<EmailStatus, (error: string | null) => string> = {
  SENT: () => "Emailed",
  DELIVERED: () => "Emailed and delivered",
  BOUNCED: (error) => `The email bounced${error ? `: ${error}` : ""}`,
  COMPLAINED: () => "They marked the email as spam, so replies aren't emailed to them any more",
  FAILED: (error) => `Couldn't email it${error ? `: ${error}` : ""}`,
};

/** The way back to the inbox, hidden where its list is beside the conversation (it would only close the conversation's pane). */
const INBOX_BACK = "@min-[52.5rem]/inbox:hidden";
/** The title there, with nothing before it: a pane title again (20px, heading font), as PaneHeader styles one without a way back. */
const INBOX_TITLE = "@min-[52.5rem]/inbox:font-heading @min-[52.5rem]/inbox:text-xl @min-[52.5rem]/inbox:tracking-[-0.015em]";

/** Messages from one sender this close together read as a run: one avatar, and their name and time once, under the last. */
const RUN_MS = 5 * 60_000;

/** A conversation shows its latest this many messages, and this many earlier ones with each "Show earlier messages" (`?messages=`). */
const MESSAGES_PER_PAGE = 50;

/** The tab: the conversation's subject (one past the plan's history, or not this person's project: the Inbox's). */
export async function generateMetadata(props: PageProps<"/app/[project]/inbox/[number]">): Promise<Metadata> {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const membership = await getMembership(slug);
  const projectId = membership?.project.id;
  const conversation =
    projectId && Number.isInteger(number) && number > 0
      ? await prisma.conversation.findUnique({
          where: { projectId_number: { projectId, number }, AND: [visibleConversations(await historySince(projectId))] },
          select: { subject: true },
        })
      : null;
  return { title: conversation?.subject ? pageTitle(conversation.subject) : "Inbox" };
}

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
  const q = inboxQuery(searchParams.q);
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
        spamReason: true,
        spamPhrase: true,
        spamMarkedAt: true,
        sample: true,
        // The customer's language: replies are previewed and sent in it while the project translates (docs/plan.md L22).
        language: true,
        email: true,
        name: true,
        emailVerified: true,
        snoozedUntil: true,
        assigneeId: true,
        userId: true,
        visitorHash: true,
        createdAt: true,
        user: { select: { name: true, email: true, deletedAt: true, ssoIdentity: { select: { externalId: true, email: true } } } },
        posts: { orderBy: { createdAt: "asc" }, select: { post: { select: { number: true, title: true, status: true } } } },
        _count: { select: { messages: true } },
        // The latest ones, newest first (put in order below).
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: shown,
          select: {
            id: true,
            author: true,
            authorId: true,
            body: true,
            note: true,
            fromAddress: true,
            original: true,
            seenAt: true,
            importId: true,
            import: { select: { source: true } },
            emailStatus: true,
            emailError: true,
            createdAt: true,
            authorUser: { select: { name: true } },
            attachments: { orderBy: { createdAt: "asc" }, select: { id: true, key: true, filename: true, contentType: true, size: true } },
            attachmentsDropped: true,
            teamText: true,
            language: true,
            translationError: true,
          },
        },
      },
    }),
    // Who it can be assigned to, as conversations.assignees lists them.
    assignableTeam(projectId),
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
        <InboxPanes slug={slug} view={view} open={number} pages={pages} q={q}>
          <PastHistory
            slug={slug}
            view={view}
            pages={pages}
            q={q}
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
  // Out of credits: the AI's buttons show, disabled (the layout says why).
  const paused = aiEnabled() && (await aiPaused(projectId));
  const [signed, related, marking] = await Promise.all([
    attachmentLinks(conversation.messages.flatMap((m) => m.attachments)),
    postsLikeConversation(projectId, conversation),
    // What marking it as spam, or not, would do beyond it: for owners and admins, whose the blocked list is.
    spamChoices(prisma, { ...conversation, projectId }, isAdminRole(membership.role)),
  ]);
  const links = new Map(signed.map((a) => [a.id, a]));

  const person = conversationPerson(conversation);
  // Where replies would be emailed at all: they wait while the project's email is paused, and in its
  // first week past its daily cap, until tomorrow, and past its plan's monthly limit, until next month.
  const blocked = person.email
    ? await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId, email: person.email.toLowerCase() } }, select: { email: true } })
    : null;
  // A sample conversation's replies are never emailed (its person's address goes nowhere): nothing waits.
  const emailable = !conversation.spam && !conversation.sample && !!person.email && !blocked;
  const waitsForPause = emailPaused && emailable;
  const month = !emailPaused && emailable ? await emailsThisMonth(projectId) : null;
  // Past what the plan includes, emails a paid plan's credits pay for still go: only those it can't wait.
  const monthFull = month?.held === true;
  // On a license, its emails come with its next month, not the calendar's.
  const licenseMonth = month?.until && formatDay(month.until);
  const capped = !emailPaused && emailable && !monthFull && (await cappedProjects()).includes(projectId);
  // Why: in the toast as a reply is sent, and as the title of its held message's short status. Warning: over the reply box, before Send,
  // with where to see more (for owners and admins: nobody else can open Settings).
  const admin = isAdminRole(membership.role);
  const wait = waitsForPause
    ? {
        status: "Not emailed yet",
        why: "Not emailed while your project's email is paused (Settings → Inbox and email)",
        warning: "Your project's email is paused: replies are emailed once it's on again.",
        link: admin ? { label: "Settings", href: `/app/${slug}/settings/support` } : undefined,
      }
    : monthFull && month?.perEmail != null
      ? // Past the included ones, credits pay for more (claimProjectEmail): it's credits that are missing, and buying them sends it now.
        // Only owners and admins can buy them (Billing is theirs): everyone else is told who can.
        admin
        ? {
            status: `Emailed ${licenseMonth ?? "next month"}`,
            why: `Emailed ${licenseMonth ?? "next month"} unless you buy credits: this month's included emails are used and not enough credits are left (Settings → Billing)`,
            warning: `This month's included emails are used and not enough credits are left: buy credits to email replies now, or they go ${licenseMonth ? `on ${licenseMonth}` : "next month"}.`,
            link: { label: "Billing", href: `/app/${slug}/settings/billing` },
          }
        : {
            status: `Emailed ${licenseMonth ?? "next month"}`,
            why: `Emailed ${licenseMonth ?? "next month"} unless an owner or admin buys credits: this month's included emails are used and not enough credits are left`,
            warning: `This month's included emails are used and not enough credits are left: replies are emailed ${licenseMonth ? `on ${licenseMonth}` : "next month"} unless an owner or admin buys credits.`,
          }
    : monthFull && licenseMonth
      ? {
          status: `Emailed ${licenseMonth}`,
          why: `Emailed ${licenseMonth}: your license's emails for this month are used (Settings → Billing)`,
          warning: `This month's emails from your license are used: replies are emailed on ${licenseMonth}.`,
          link: admin ? { label: "Billing", href: `/app/${slug}/settings/billing` } : undefined,
        }
    : monthFull
      ? {
          status: "Emailed next month",
          why: "Emailed next month: your plan's emails for this month are used (Settings → Billing)",
          warning: "This month's emails are used: replies are emailed next month.",
          link: admin ? { label: "Billing", href: `/app/${slug}/settings/billing` } : undefined,
        }
      : capped
        ? {
            status: "Emailed tomorrow",
            why: `Emailed tomorrow: in its first week, a project sends up to ${NEW_PROJECT_EMAILS_PER_DAY} emails a day`,
            warning: `Today's emails are used (a project's first week sends up to ${NEW_PROJECT_EMAILS_PER_DAY} a day): replies are emailed tomorrow.`,
          }
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
  // Replies go out in the customer's language, previewed under the composer (docs/plan.md L22).
  const { teamLanguage, translate } = await translationSettings(projectId);
  const translated = translate && conversation.language && !sameLanguage(conversation.language, teamLanguage) ? { language: conversation.language, teamLanguage } : undefined;
  type Message = (typeof conversation.messages)[number];
  // Someone else on the email (in Cc) shows as their address.
  const byName = (message: Message) =>
    message.author === "USER" ? (message.fromAddress ?? personName) : (message.authorUser?.name ?? (message.author === "AI" ? "AI" : "Tuti"));
  // The tool an imported message came from, by name.
  const importedFrom = (message: Message) => (message.import ? IMPORT_SOURCES[message.import.source.toLowerCase() as ImportSourceKey].name : null);
  // A team reply's email, under it. Imported history was never emailed: no email status for it (docs/plan.md, Switching
  // from Featurebase), but the tool it came from.
  const emailed = (message: Message) =>
    message.author !== "TEAM" || message.note
      ? undefined
      : message.seenAt
        ? "Seen"
        : message.import
          ? `Imported from ${importedFrom(message)}`
          : message.emailStatus
            ? EMAIL_STATUS[message.emailStatus](message.emailError)
            : wait?.status;

  return (
    <InboxPanes slug={slug} view={view} open={conversation.number} pages={pages} messages={messagePages} q={q}>
      <MarkRead slug={slug} number={number} seen={conversation.messages.at(-1)?.createdAt.toISOString() ?? null} unread={read?.unread ?? false} />
      <ConversationPane open detailsHidden={detailsHidden}>
        <Pane className="inbox-conversation col-start-1 row-start-1">
          <PaneHeader
            back={{ href: inboxHref(slug, view, null, pages, 1, q), label: "Inbox", className: INBOX_BACK }}
            title={<span title={conversation.subject} className={INBOX_TITLE}>{conversation.subject}</span>}
            actions={
              <>
                <CloseButton projectSlug={slug} number={conversation.number} closed={conversation.status === "CLOSED"} />
                <ConversationMore>
                  <LinkPostButton projectSlug={slug} number={conversation.number} linked={posts.map((post) => post.number)} />
                  {conversation.status === "OPEN" && answered && <MarkStatusButton projectSlug={slug} number={conversation.number} status="waiting" />}
                  {conversation.status === "WAITING" && <MarkStatusButton projectSlug={slug} number={conversation.number} status="open" />}
                  {aiEnabled() && <SummarizeButton projectSlug={slug} number={conversation.number} paused={paused} />}
                  <SpamButton projectSlug={slug} number={conversation.number} spam={conversation.spam} {...marking} />
                </ConversationMore>
                <DetailsToggle hidden={detailsHidden} />
              </>
            }
          />
          {/* On phones the header has the way back, the subject under it (to the eye: the header's heading is for screen readers). */}
          <p aria-hidden className="inbox-conversation-subject shrink-0 px-5 wrap-anywhere pt-2.5 font-semibold @min-[48rem]/app:hidden">
            {conversation.subject}
          </p>
          <p className="inbox-conversation-meta flex shrink-0 flex-wrap items-center gap-1.5 border-b px-5 py-2 text-xs leading-5 text-muted-foreground wrap-anywhere">
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
          {conversation.spam && (
            <SpamNotice
              projectSlug={slug}
              number={conversation.number}
              // Why the filter filed it; else a teammate marked it (one from before the two were told apart says neither).
              why={spamWhy(conversation.spamReason, conversation.spamPhrase) ?? (conversation.spamMarkedAt ? "a teammate marked it" : null)}
              unblocks={marking.unblocks}
            />
          )}
          <div id="conversation" className="inbox-conversation-body relative min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            <div className="inbox-messages-and-composer flex min-h-full flex-col gap-2.5 px-6 pt-3 @max-[52.5rem]/inbox:px-3 @min-[77rem]/app:group-data-[details=hidden]/thread:px-9">
              <EarlierMessages
                href={inboxHref(slug, view, conversation.number, pages, messagePages + 1, q)}
                first={conversation.messages[0]?.id ?? ""}
                more={conversation._count.messages > shown}
              />
              <ol className="inbox-messages flex flex-col gap-1 pb-2" aria-label="Messages">
                {conversation.messages.map((message, index) => {
                  const fromTeam = message.author !== "USER";
                  const name = byName(message);
                  const status = emailed(message);
                  // A run from one sender, as in a messaging app: the next message from them within minutes, by the same name with the
                  // same email status, carries the avatar and that line for both (this one's line folded to no height, said to screen readers from a copy). A run ends where the
                  // next message starts a new day in the viewer's time zone: its divider, shown in the browser, brings them back.
                  const next = conversation.messages[index + 1];
                  const runs =
                    !!next &&
                    !message.note &&
                    !next.note &&
                    next.author === message.author &&
                    // Two teammates of one name are two senders (a customer's id differs by channel: their name decides).
                    (message.author !== "TEAM" || next.authorId === message.authorId) &&
                    byName(next) === name &&
                    next.createdAt.getTime() - message.createdAt.getTime() < RUN_MS &&
                    emailed(next) === status;
                  return (
                    <li key={message.id} data-message={message.id}>
                      <MessageDay at={message.createdAt.toISOString()} previous={conversation.messages[index - 1]?.createdAt.toISOString()} />
                      <div className={cn("inbox-message flex items-end gap-2", fromTeam && "team flex-row-reverse justify-start", message.note && "note mx-5 flex-row justify-center @max-[57rem]/app:mx-3.75 @min-[77rem]/app:group-data-[details=hidden]/thread:mx-17.5")}>
                        <Avatar className={cn("inbox-chat-avatar mb-7.75 size-6.5 flex-none text-xs max-md:size-6", message.note && "hidden", runs && "invisible mb-0 in-[li:has(+li_.inbox-day)]:visible in-[li:has(+li_.inbox-day)]:mb-7.75")}>
                          <AvatarFallback>{initial(name)}</AvatarFallback>
                        </Avatar>
                        <div className={cn("inbox-message-body min-w-0 max-w-[min(30rem,72%)] max-md:max-w-[82%]", message.note && "max-w-full max-md:max-w-full")}>
                          <div className={cn("inbox-bubble rounded-2xl bg-inbox-customer px-3.25 py-2.25 wrap-anywhere max-md:px-2.75 [&_p]:text-sm [&>p:not(.inbox-message-by)]:leading-normal", fromTeam ? (runs ? "in-[li:has(+li_.inbox-day)]:rounded-br-sm" : "rounded-br-sm") : runs ? "in-[li:has(+li_.inbox-day)]:rounded-bl-sm" : "rounded-bl-sm", message.attachments.length === 0 && "w-fit max-w-full", fromTeam && !message.note && "ml-auto bg-primary text-primary-foreground [&_:focus-visible]:outline-primary-foreground [&_[aria-label=Attachments]_:focus-visible]:outline-ring [&_details]:text-primary-foreground [&>div>p.text-muted-foreground]:text-primary-foreground [&_[aria-label=Attachments]>li]:text-card-foreground", message.note && "mx-auto rounded-lg border border-dashed border-highlight-foreground/40 bg-inbox-note px-3 py-2 max-md:px-3 max-md:py-2 [&_.inbox-note-by]:text-xs [&_.inbox-note-by]:leading-4.5")}>
                            {message.note && (
                              <p className="inbox-note-by mb-0.5 flex items-center gap-1.25 text-xs leading-4.5 font-semibold text-highlight-foreground [&>svg]:size-3.25 [&>svg]:flex-none">
                                <LockKeyholeIcon aria-hidden />
                                Internal note · {name}
                              </p>
                            )}
                            {message.note ? (
                              <p className="text-sm break-words whitespace-pre-wrap">
                                <MessageText text={message.body} ugc={false} />
                              </p>
                            ) : (
                              <MessageTranslation
                                body={message.body}
                                teamText={message.teamText}
                                language={message.language}
                                error={message.translationError}
                                fromTeam={fromTeam}
                                // Try again runs only where it can: translation on, and AI on the server.
                                canRetry={translate && aiEnabled()}
                                projectSlug={slug}
                                number={conversation.number}
                              />
                            )}
                            <MessageAttachments
                              cards
                              attachments={message.attachments.map((a) => links.get(a.id)!)}
                              dropped={message.attachmentsDropped}
                              imported={importedFrom(message) ?? false}
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
                          <p className={cn("inbox-message-by m-0 mb-2 flex flex-wrap items-center gap-x-1.25 px-0.5 pt-0.75 text-xs leading-4.5 text-muted-foreground [&>svg]:size-3.25 [&>svg]:flex-none", fromTeam && "justify-end text-right", message.note && "justify-center text-center", runs && "h-0 overflow-hidden pt-0 mb-0 in-[li:has(+li_.inbox-day)]:h-auto in-[li:has(+li_.inbox-day)]:pt-0.75 in-[li:has(+li_.inbox-day)]:mb-2")}
                            // Folded, it's said from the copy below instead (a line of no height can be skipped).
                            aria-hidden={runs || undefined}
                          >
                            {/* The icon, who and when as one, the status after it, wrapping as a whole onto a line of its own where they don't fit. */}
                            <span className="inline-flex min-w-0 items-center gap-x-1.25">
                              {message.note ? <LockKeyholeIcon aria-hidden className="size-3.25 flex-none" /> : <MailIcon aria-hidden className="size-3.25 flex-none" />}
                              <span className="min-w-0">
                                {!message.note && `${name} · `}
                                {timeAgo(message.createdAt)}
                              </span>
                            </span>
                            {/* Held: the short status shows whole, and the full reason is its tooltip and what screen readers hear. */}
                            {status && (status === wait?.status ? (
                              <span className="whitespace-nowrap" title={wait.why}>
                                <span aria-hidden>{status}</span>
                                <span className="sr-only">{wait.why}</span>
                              </span>
                            ) : (
                              // Others (a bounce's error, a complaint) can be long: they wrap, inside the column.
                              <span className="min-w-0 wrap-anywhere">{status}</span>
                            ))}
                          </p>
                          {runs && (
                            <p className="sr-only">
                              {name} · {timeAgo(message.createdAt)} {wait && status === wait.status ? wait.why : status}
                            </p>
                          )}
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
                  emailWaits={wait && { why: wait.why, warning: wait.warning, link: wait.link }}
                  translated={translated}
                />
              </div>
            </div>
          </div>
        </Pane>
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
          <PersonPanel
            projectId={projectId}
            slug={slug}
            person={{ ...conversation, name: person.name }}
            besides={conversation.number}
            inbox={{ view, pages, userId: membership.userId, q }}
          />
          <ConversationActivity
            projectSlug={slug}
            number={conversation.number}
            count={await prisma.conversationEvent.count({ where: { conversationId: conversation.id } })}
            first={await conversationActivity(conversation.id)}
          />
          <ConversationPosts projectSlug={slug} number={conversation.number} posts={posts} related={related} />
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
          <p className="inbox-detail-foot border-t pt-3 text-xs leading-normal text-muted-foreground">
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
  q,
  number,
  days,
  admin,
  upgrade,
}: {
  slug: string;
  view: ReturnType<typeof inboxView>;
  pages: number;
  q: string;
  number: number;
  days: number;
  admin: boolean;
  upgrade: boolean;
}) {
  return (
    <ConversationPane open>
      {/* The whole thread's grid: there are no details beside it. */}
      <Pane className="col-span-full">
        <PaneHeader back={{ href: inboxHref(slug, view, null, pages, 1, q), label: "Inbox", className: INBOX_BACK }} title={<span className={INBOX_TITLE}>{`Conversation #${number}`}</span>} />
        <PaneBody className="p-6">
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
        </PaneBody>
      </Pane>
    </ConversationPane>
  );
}
