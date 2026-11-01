import { prisma } from "@tuti/db";
import Link from "next/link";
import type { ReactNode } from "react";

import { STATUS_LABELS } from "@/components/post-status-badge";
import { Badge } from "@/components/ui/badge";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName } from "@/lib/conversation-statuses";
import { formatProperty, propertyLabel, storedPropertyFormats } from "@/lib/property-formats";
import { viewsOf } from "@/server/operations/users";

const SHOWN = 5;

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h2 className="text-xs font-medium text-muted-foreground">
        {title}
        {count !== undefined && count > 0 && <span className="tabular-nums"> · {count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Links({ items, empty }: { items: { href: string; title: string; meta: string }[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.href} className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
          <Link href={item.href} className="min-w-0 break-words hover:underline">
            {item.title}
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">{item.meta}</span>
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
  conversationHref = (number) => `/app/${slug}/inbox/${number}`,
}: {
  projectId: string;
  slug: string;
  /**
   * Someone Tuti knows (their account; with `accounts`, every account that is them, theirs first, as Users counts
   * them), or only their address (verified or not).
   */
  person: { userId: string | null; email: string | null; emailVerified: boolean; accounts?: string[] };
  /** The conversation it's beside, left out of theirs. */
  besides?: number;
  /** Where one of their conversations opens: in the Inbox beside it, in the view the list shows. */
  conversationHref?: (number: number) => string;
}) {
  const { userId, email } = person;
  const accounts = userId ? (person.accounts ?? [userId]) : [];
  // Theirs: with one of their accounts, or (known or not) started by email from their address, verified. Not spam.
  const theirs = {
    projectId,
    spam: false,
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
      take: SHOWN,
      select: { number: true, subject: true, status: true },
    }),
    prisma.conversation.count({ where: theirs }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { propertyFormats: true } }),
  ]);
  const formats = storedPropertyFormats(propertyFormats);
  const lookalike = !userId && email ? await maybeUser(projectId, email) : null;
  const sso = user?.ssoIdentity;
  const view = sso && user ? (await viewsOf(projectId, [{ ...sso, user: { name: user.name, image: user.image } }]))[0]! : null;
  const [posts, postCount, votes, voteCount] = userId
    ? await Promise.all([
        prisma.post.findMany({
          where: { projectId, authorId: { in: accounts }, duplicateOfId: null },
          orderBy: { createdAt: "desc" },
          take: SHOWN,
          select: { number: true, title: true, status: true },
        }),
        prisma.post.count({ where: { projectId, authorId: { in: accounts }, duplicateOfId: null } }),
        // Votes on others' posts: everyone votes for their own.
        prisma.vote.findMany({
          where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } },
          orderBy: { createdAt: "desc" },
          take: SHOWN,
          select: { post: { select: { number: true, title: true, status: true } } },
        }),
        prisma.vote.count({ where: { projectId, userId: { in: accounts }, post: { authorId: { notIn: accounts }, duplicateOfId: null } } }),
      ])
    : [[], 0, [], 0];
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const shownEmail = sso ? sso.email : (user?.email ?? email);
  const verified = sso ? true : user ? user.emailVerified : person.emailVerified;
  const postLink = (p: { number: number; title: string; status: keyof typeof STATUS_LABELS }) => ({
    href: `/app/${slug}/p/${p.number}`,
    title: p.title,
    meta: STATUS_LABELS[p.status],
  });

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1" aria-label="Who">
        <p className="font-medium break-words">{user?.name ?? shownEmail ?? "Unknown"}</p>
        {shownEmail && (
          <p className="text-sm break-all text-muted-foreground">
            {shownEmail}
            {!verified && " (not verified)"}
          </p>
        )}
        {view && <p className="text-xs break-all text-muted-foreground">id {view.id}</p>}
        {!user && <p className="text-xs text-muted-foreground">Known only by this address.</p>}
        {lookalike && (
          <p className="text-xs break-words text-muted-foreground">
            Maybe {lookalike.name} (not signed in){lookalike.id && <span className="break-all">, id {lookalike.id}</span>}
          </p>
        )}
        {view && view.groups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {view.groups.map((key) => (
              <Badge key={key} variant="secondary" className="h-auto max-w-full shrink whitespace-normal break-words">
                {names.get(key) ?? key}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {view && Object.keys(view.properties).length > 0 && (
        <Section title="Properties">
          <dl className="grid grid-cols-[fit-content(50%)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
            {Object.entries(view.properties).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="break-all text-muted-foreground">{propertyLabel(formats, name)}</dt>
                <dd className="min-w-0 break-words">{formatProperty(formats, name, value)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

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

      <Section title={besides === undefined ? "Conversations" : "Other conversations"} count={otherCount}>
        <Links
          items={others.map((c) => ({
            href: conversationHref(c.number),
            title: c.subject,
            meta: `#${c.number} · ${CONVERSATION_STATUS_LABELS[c.status.toLowerCase() as ConversationStatusName]}`,
          }))}
          empty="None."
        />
      </Section>
    </div>
  );
}
