import { prisma } from "@tuti/db";
import Link from "next/link";
import type { ReactNode } from "react";

import { STATUS_LABELS } from "@/components/post-status-badge";
import { Badge } from "@/components/ui/badge";
import { CONVERSATION_STATUS_LABELS, type ConversationStatusName } from "@/lib/conversation-statuses";
import type { PropertyValue } from "@/lib/user-properties";
import { viewsOf } from "@/server/operations/users";

const text = (value: PropertyValue) => (Array.isArray(value) ? value.join(", ") : String(value));
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
          <Link href={item.href} className="min-w-0 truncate hover:underline">
            {item.title}
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">{item.meta}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Who the conversation is with, beside it: someone Tuti knows (their app's id, properties, groups,
 * posts and votes) or just an email address, and their other conversations.
 */
export async function PersonPanel({
  projectId,
  slug,
  conversation,
}: {
  projectId: string;
  slug: string;
  conversation: { number: number; userId: string | null; email: string | null; emailVerified: boolean };
}) {
  const { userId, email } = conversation;
  const [user, groups, others, otherCount] = await Promise.all([
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
      where: { projectId, number: { not: conversation.number }, ...(userId ? { userId } : { userId: null, email }) },
      orderBy: { lastMessageAt: "desc" },
      take: SHOWN,
      select: { number: true, subject: true, status: true },
    }),
    prisma.conversation.count({
      where: { projectId, number: { not: conversation.number }, ...(userId ? { userId } : { userId: null, email }) },
    }),
  ]);
  const sso = user?.ssoIdentity;
  const view = sso && user ? (await viewsOf(projectId, [{ ...sso, user: { name: user.name, image: user.image } }]))[0]! : null;
  const [posts, postCount, votes, voteCount] = userId
    ? await Promise.all([
        prisma.post.findMany({
          where: { projectId, authorId: userId, duplicateOfId: null },
          orderBy: { createdAt: "desc" },
          take: SHOWN,
          select: { number: true, title: true, status: true },
        }),
        prisma.post.count({ where: { projectId, authorId: userId, duplicateOfId: null } }),
        // Votes on others' posts: everyone votes for their own.
        prisma.vote.findMany({
          where: { projectId, userId, post: { authorId: { not: userId }, duplicateOfId: null } },
          orderBy: { createdAt: "desc" },
          take: SHOWN,
          select: { post: { select: { number: true, title: true, status: true } } },
        }),
        prisma.vote.count({ where: { projectId, userId, post: { authorId: { not: userId }, duplicateOfId: null } } }),
      ])
    : [[], 0, [], 0];
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const shownEmail = sso ? sso.email : (user?.email ?? email);
  const verified = sso ? true : user ? user.emailVerified : conversation.emailVerified;
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
        {view && view.groups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {view.groups.map((key) => (
              <Badge key={key} variant="secondary">
                {names.get(key) ?? key}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {view && Object.keys(view.properties).length > 0 && (
        <Section title="Properties">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            {Object.entries(view.properties).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="min-w-0 break-words">{text(value)}</dd>
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

      <Section title="Other conversations" count={otherCount}>
        <Links
          items={others.map((c) => ({
            href: `/app/${slug}/inbox/${c.number}`,
            title: c.subject,
            meta: `#${c.number} · ${CONVERSATION_STATUS_LABELS[c.status.toLowerCase() as ConversationStatusName]}`,
          }))}
          empty="None."
        />
      </Section>
    </div>
  );
}
