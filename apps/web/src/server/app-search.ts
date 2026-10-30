"use server";

import { prisma } from "@tuti/db";

import { MAX_QUERY } from "@/lib/command-menu-event";

import { getMembership } from "./membership";
import { listUsers } from "./operations/users";
import { call } from "./operations/run";
import { getSession } from "./session";

export type AppSearchResult = { kind: "post" | "conversation" | "article" | "user"; title: string; meta: string; href: string };

/** How many of each kind ⌘K lists. */
const EACH = 5;

/**
 * ⌘K's search in the app: posts, conversations, articles and users whose name has `q`, for the project's
 * team (what each of them may see on those pages). Settings pages and actions are matched in the menu itself.
 */
export async function searchApp(projectSlug: string, q: string): Promise<{ error?: string; results?: AppSearchResult[] }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: "Only the project's team can search it" };
  }
  const query = q.trim();
  // Too short to search, or longer than anything worth searching for (the box takes 200): nothing.
  if (query.length < 2 || query.length > MAX_QUERY) {
    return { results: [] };
  }
  const projectId = membership.project.id;
  const base = `/app/${projectSlug}`;
  // `contains` is a LIKE: its wildcards (and the escape) typed as themselves.
  const has = { contains: query.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const };
  // "#12" or "12": a number as posts and conversations have them (a 32-bit integer).
  const asNumber = /^#?\d{1,10}$/.test(query) ? Number(query.replace("#", "")) : null;
  const number = asNumber !== null && asNumber <= 2_147_483_647 ? asNumber : null;
  const [posts, conversations, articles, { users }] = await Promise.all([
    prisma.post.findMany({
      where: { projectId, duplicateOfId: null, OR: [{ title: has }, ...(number ? [{ number }] : [])] },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
      take: EACH,
      select: { number: true, title: true, voteCount: true },
    }),
    prisma.conversation.findMany({
      where: { projectId, spam: false, OR: [{ subject: has }, ...(number ? [{ number }] : [])] },
      orderBy: { lastMessageAt: "desc" },
      take: EACH,
      select: { number: true, subject: true, status: true },
    }),
    prisma.article.findMany({
      where: { projectId, deletedAt: null, title: has },
      orderBy: { updatedAt: "desc" },
      take: EACH,
      select: { slug: true, title: true, publishedAt: true },
    }),
    call(listUsers, { actor: { kind: "user", userId: session.user.id }, projectId }, { q: query, limit: EACH }),
  ]);
  return {
    results: [
      ...posts.map((post) => ({
        kind: "post" as const,
        title: post.title,
        meta: `#${post.number} · ${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`,
        href: `${base}/p/${post.number}`,
      })),
      ...conversations.map((c) => ({ kind: "conversation" as const, title: c.subject, meta: `#${c.number} · ${c.status.toLowerCase()}`, href: `${base}/inbox/${c.number}` })),
      ...articles.map((a) => ({ kind: "article" as const, title: a.title, meta: a.publishedAt ? "Published" : "Draft", href: `${base}/docs/${a.slug}` })),
      ...users.map((user) => ({
        kind: "user" as const,
        title: user.name ?? user.email ?? user.id,
        meta: user.email ?? user.id,
        // Their id in the team's app: Users finds exactly them by it.
        href: `${base}/users?${new URLSearchParams({ q: user.id })}`,
      })),
    ],
  };
}
