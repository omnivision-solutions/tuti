import { type PostStatus, prisma } from "@tuti/db";
import { historySince, visibleConversations } from "@tuti/jobs";
import Link from "next/link";
import { UserIcon, MessagesSquareIcon } from "lucide-react";
import { DetailSection } from "@/components/inbox/detail-section";
import type { ReactNode } from "react";

import { inboxHref, inInboxView, type View } from "@/components/inbox/inbox-panes";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Badge } from "@/components/ui/badge";
import { ConversationStatusText } from "./conversation-status";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_STYLES, type ConversationStatusName } from "@/lib/conversation-statuses";
import { cn } from "@/lib/utils";
import { formatProperty, propertyHeadings, storedPropertyFormats } from "@/lib/property-formats";
import type { PropertyValue } from "@tuti/shared/user-properties";
import { viewsOf } from "@/server/operations/users";
import { latestMessages } from "@/server/operations/conversations";
import { ViewerDate } from "@/components/inbox/viewer-date";
import { firstLine } from "@/lib/format";

/** Beside a conversation; their own page lists them all (up to 500). */
const SHOWN = 5;

/** A part of what they did. `card`: on their own page (a pane), a part of its own with a heading. */
function Section({ title, count, card = false, big = false, children }: { title: string; count?: number; card?: boolean; big?: boolean; children: ReactNode }) {
  if (card) {
    return (
      <section aria-label={title} className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-[1rem] font-semibold">
          {title}
          {count !== undefined && <span className="rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {children}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h2 className={big ? "mb-1 text-[1rem] font-semibold" : "text-xs font-medium text-muted-foreground"}>
        {title}
        {count !== undefined && count > 0 && <span className="tabular-nums"> · {count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** Links to what they did; `rows`: on their own page, rows with lines between them. */
function Links({ items, empty, rows = false }: { items: { href: string; title: string; meta: ReactNode }[]; empty: string; rows?: boolean }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className={rows ? "-my-2 flex flex-col divide-y" : "flex flex-col gap-1"}>
      {items.map((item) => (
        <li key={item.href} className={cn("flex min-w-0 items-baseline justify-between gap-2 text-sm", rows && "items-center py-2.5")}>
          <Link href={item.href} className="min-w-0 break-words hover:underline">
            {item.title}
          </Link>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">{item.meta}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One of the project's users with this address, as a hint for the team: someone writing signed out
 * may be them, or may only have typed their address, so it's never linked and the visitor sees
 * nothing of theirs. Someone from the project's app, else an account with that address verified
 * that has posted, voted or commented here (never just any account, which would tell the team who
 * has one).
 */
export async function maybeUser(projectId: string, email: string) {
  const sso = await prisma.ssoIdentity.findFirst({
    // Case-insensitive: emails older instances saved kept their capitals.
    where: { projectId, email: { equals: email, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    select: { externalId: true, user: { select: { name: true } } },
  });
  if (sso) {
    return { name: sso.user.name, id: sso.externalId };
  }
  const account = await prisma.user.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      emailVerified: true,
      ssoIdentity: null,
      OR: [{ posts: { some: { projectId } } }, { votes: { some: { projectId } } }, { comments: { some: { projectId } } }],
    },
    select: { name: true },
  });
  return account && { name: account.name, id: null };
}

/**
 * Who the conversation is with, beside it: someone Tuti knows (their app's id, properties, groups,
 * posts and votes) or just an email address, and their other conversations.
 */
export async function PersonPanel({
  projectId,
  slug,
  person,
  besides,
  inbox,
  page = false,
}: {
  projectId: string;
  slug: string;
  /**
   * Someone Tuti knows (their account; with `accounts`, every account that is them, theirs first, as Users counts
   * them), or only their address (verified or not), with the name its email came from.
   */
  person: { userId: string | null; email: string | null; name?: string | null; emailVerified: boolean; accounts?: string[] };
  /** The conversation it's beside, left out of theirs. */
  besides?: number;
  /**
   * Beside a conversation in the Inbox: the view its list shows, and who's looking. Their conversations in that view
   * open beside it there; the others in the Inbox's first view (one without them would have no row for it).
   */
  inbox?: { view: View; pages: number; userId: string };
  /** On their own page (Users): their avatar and name as its heading, the profile beside the activity, all of it. */
  page?: boolean;
}) {
  // ponytail: all of them up to 500 on their own page (the count says how many), pages of them if anyone has more.
  const take = page ? 500 : SHOWN;
  const { userId, email } = person;
  const accounts = userId ? (person.accounts ?? [userId]) : [];
  // Theirs: with one of their accounts, or (known or not) started by email from their address, verified. Not spam, nor
  // past the plan's history.
  const theirs = {
    projectId,
    spam: false,
    AND: [visibleConversations(await historySince(projectId))],
    ...(besides !== undefined && { number: { not: besides } }),
    OR: [
      ...(accounts.length > 0 ? [{ userId: { in: accounts } }] : [{ userId: null, email }]),
      ...(accounts.length > 0 && email && person.emailVerified ? [{ userId: null, emailVerified: true, email }] : []),
    ],
  };
  const [user, groups, others, otherCount, { propertyFormats }] = await Promise.all([
    userId
      ? prisma.user.findUnique({
          where: { id: userId },
          select: {
            name: true,
            email: true,
            emailVerified: true,
            image: true,
            ssoIdentity: { select: { externalId: true, email: true, properties: true, createdAt: true, updatedAt: true } },
          },
        })
      : null,
    prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, name: true } }),
    prisma.conversation.findMany({
      where: theirs,
      orderBy: { lastMessageAt: "desc" },
      take,
      select: { id: true, number: true, subject: true, status: true, lastMessageAt: true },
    }),
    prisma.conversation.count({ where: theirs }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { propertyFormats: true } }),
  ]);
  const formats = storedPropertyFormats(propertyFormats);
  const otherMessages = page ? new Map() : await latestMessages(others.map((c) => c.id));
  const inView = inbox
    ? await inInboxView(
        projectId,
        inbox.userId,
        inbox.view,
        others.map((c) => c.id),
      )
    : new Set<number>();
  const lookalike = !userId && email ? await maybeUser(projectId, email) : null;
  const sso = user?.ssoIdentity;
  const view = sso && user ? (await viewsOf(projectId, [{ ...sso, user: { name: user.name, image: user.image } }]))[0]! : null;
  const [posts, postCount, votes, voteCount] = userId
    ? await Promise.all([
        prisma.post.findMany({
          where: { projectId, authorId: { in: accounts }, duplicateOfId: null },
          orderBy: { createdAt: "desc" },
          take,
          select: { number: true, title: true, status: true },
        }),
        prisma.post.count({ where: { projectId, authorId: { in: accounts }, duplicateOfId: null } }),
        // Votes on others' posts: everyone votes for their own.
        prisma.vote.findMany({
          where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } },
          orderBy: { createdAt: "desc" },
          take,
          select: { post: { select: { number: true, title: true, status: true } } },
        }),
        prisma.vote.count({ where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } } }),
      ])
    : [[], 0, [], 0];
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const headings = propertyHeadings(formats, Object.keys(view?.properties ?? {}));
  const shownEmail = sso ? sso.email : (user?.email ?? email);
  const verified = sso ? true : user ? user.emailVerified : person.emailVerified;
  // They marked an email from the project as spam (SES's complaint): replies aren't emailed to that address any more.
  const blocked = shownEmail
    ? await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId, email: shownEmail.toLowerCase() } }, select: { email: true } })
    : null;
  const postLink = (p: { number: number; title: string; status: PostStatus }) => ({
    href: `/app/${slug}/p/${p.number}`,
    title: p.title,
    meta: <PostStatusBadge status={p.status} />,
  });

  // Beside a conversation, under Details (on their own page, the header has the id).
  const identity = view && !page && <p className="text-xs break-all text-muted-foreground">id {view.id}</p>;
  const groupBadges = view && view.groups.length > 0 && (
    <div className="mt-1 flex flex-wrap gap-1">
      {view.groups.map((key) => (
        <Badge key={key} variant="secondary" className="h-auto max-w-full shrink whitespace-normal break-words">
          {names.get(key) ?? key}
        </Badge>
      ))}
    </div>
  );
  const properties = (entries: [string, PropertyValue][], title?: string) => {
    if (entries.length === 0) {
      return null;
    }
    const list = (
      <dl aria-label={title ? undefined : "Properties"} className="grid grid-cols-[fit-content(50%)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
        {entries.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="break-all text-muted-foreground">{headings.get(name)}</dt>
            <dd className="min-w-0 break-words">{formatProperty(formats, name, value)}</dd>
          </div>
        ))}
      </dl>
    );
    return title ? (
      <Section title={title} big={page}>
        {list}
      </Section>
    ) : (
      list
    );
  };
  const allProperties = Object.entries(view?.properties ?? {});

  const profile = (
    <>
      <section className="flex flex-col gap-1 empty:hidden" aria-label="Who">
        {page && user ? null : ( // On their own page the header has their face, name, address and id.
          <p className="font-medium break-words">{user?.name ?? person.name ?? shownEmail ?? "Unknown"}</p>
        )}
        {shownEmail && !(page && user) && (
          // A long address breaks anywhere; "(not verified)" only between its words.
          <p className="text-sm break-words text-muted-foreground">
            <span className="break-all">{shownEmail}</span>
            {!verified && " (not verified)"}
          </p>
        )}
        {blocked && <p className="text-xs text-muted-foreground">Marked your email as spam, so replies aren&apos;t emailed to them any more.</p>}
        {!user && <p className="text-xs text-muted-foreground">Known only by this address.</p>}
        {lookalike && (
          <p className="text-xs break-words text-muted-foreground">
            Maybe {lookalike.name} (not signed in){lookalike.id && <span className="break-all">, id {lookalike.id}</span>}
          </p>
        )}
        {page && groupBadges}
      </section>

      {page ? properties(allProperties, "Properties") : null}
    </>
  );
  const activity = (
    <>
      {user && (
        <>
          {!(page && postCount === 0) && (
            <Section title="Posts" count={postCount} card={page}>
              <Links items={posts.map(postLink)} empty="No posts." rows={page} />
            </Section>
          )}
          {/* On their own page, a part they have nothing in is left out (the others say it). */}
          {!(page && voteCount === 0) && (
            <Section title="Votes" count={voteCount} card={page}>
              <Links items={votes.map((v) => postLink(v.post))} empty="No votes on others' posts." rows={page} />
            </Section>
          )}
        </>
      )}

      <Section title={besides === undefined ? "Conversations" : "Other conversations"} count={otherCount} card={page}>
        <Links
          rows={page}
          items={others.map((c) => ({
            href: inView.has(c.number) && inbox ? inboxHref(slug, inbox.view, c.number, inbox.pages) : `/app/${slug}/inbox/${c.number}`,
            title: c.subject,
            meta: (
              <>
                #{c.number}
                <ConversationStatusText status={c.status} />
              </>
            ),
          }))}
          empty="None."
        />
      </Section>
    </>
  );

  // Their own page: what they did in numbers, then who they are beside it in full.
  // Their page's card beside what they did, when it has something (their properties, groups, a note); else what they
  // did takes the width.
  const hasProfile = !user || !!blocked || !!lookalike || (!!view && (view.groups.length > 0 || Object.keys(view.properties).length > 0));
  return page ? (
    <div className="flex flex-col gap-6">
      <div className={cn("grid gap-6 lg:items-start", hasProfile && "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]")}>
        {hasProfile && (
          // On a muted fill, not a card: their page is a pane (no card in a card).
          <div className="flex flex-col gap-5 rounded-xl bg-muted/60 p-4">{profile}</div>
        )}
        <div className="flex flex-col gap-8">{activity}</div>
      </div>
    </div>
  ) : (
    <aside aria-label="About them">
      <DetailSection
        title="Customer details"
        count={
          Number(!!(user?.name ?? person.name)) +
          Number(!!shownEmail) +
          Number(!!view) +
          allProperties.length +
          (view?.groups.length ?? 0) +
          postCount +
          voteCount
        }
        icon={UserIcon}
        open
      >
        <div className="flex flex-col gap-3">
          {profile}
          {identity}
          {groupBadges}
          {properties(allProperties, "Properties")}
          {user && (
            <>
              <Section title="Posts" count={postCount}>
                <Links items={posts.map(postLink)} empty="No posts." />
              </Section>
              <Section title="Votes" count={voteCount}>
                <Links items={votes.map((v) => postLink(v.post))} empty="No votes on others' posts." />
              </Section>
            </>
          )}
        </div>
      </DetailSection>
      <DetailSection title="Other conversations" count={otherCount} icon={MessagesSquareIcon}>
        <section aria-label="Other conversations" className="inbox-other-conversations">
          {others.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            // Their history with you, newest first: on a line, each a dot in its status's colour.
            <ol className="flex min-w-0 flex-col">
              {others.map((c) => (
                <li
                  key={c.number}
                  className="relative flex min-w-0 flex-col items-start gap-0.5 pb-3 pl-4 text-xs after:absolute after:top-4 after:bottom-0 after:left-[0.1875rem] after:w-px after:bg-border last:after:hidden"
                >
                  <span aria-hidden className={cn("absolute top-1.25 left-0 size-[0.4375rem] rounded-full", CONVERSATION_STATUS_STYLES[c.status].dot)} />
                  <p className="text-muted-foreground">
                    <ViewerDate at={c.lastMessageAt.toISOString()} /> · {CONVERSATION_STATUS_LABELS[c.status.toLowerCase() as ConversationStatusName]} · #{c.number}
                  </p>
                  <Link
                    href={inView.has(c.number) && inbox ? inboxHref(slug, inbox.view, c.number, inbox.pages) : `/app/${slug}/inbox/${c.number}`}
                    className="max-w-full text-[0.8125rem] leading-snug font-[550] wrap-anywhere hover:underline"
                  >
                    {c.subject}
                  </Link>
                  <p className="max-w-full truncate text-muted-foreground">{firstLine(otherMessages.get(c.id)?.body ?? "")}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </DetailSection>
    </aside>
  );
}
