import { prisma } from "@tuti/db";

import { githubConfig } from "@/lib/github";

/** Home's numbers, what needs the team (oldest first), what's left to set up and the trending ideas. */
export type HomeOverview = Awaited<ReturnType<typeof homeOverview>>;

/** How much "Needs your attention" lists; past it, "N more". */
const ATTENTION = 20;
const DAY = 86_400_000;

/** One thing waiting for the team, with what to do about it. */
export type AttentionItem = { key: string; at: Date; kind: string; title: string; action: string; href: string };

/**
 * A project's Home (docs/plan.md, the redesign's step 3): four numbers that each open their list; what
 * needs the team, oldest first (conversations needing a reply, posts to triage, possible duplicates,
 * Autopilot's updates, docs searches that found nothing), each with its action; "Get set up" while
 * something's left (`emailVerified`: the person's own); and the ideas with the most votes this week.
 */
export async function homeOverview(projectId: string, slug: string, { emailVerified }: { emailVerified: boolean }) {
  const now = Date.now();
  const week = new Date(now - 7 * DAY);
  const month = new Date(now - 30 * DAY);
  const base = `/app/${slug}`;
  // What waits for a reply: the Inbox's Open view (and the sidebar's count).
  const needsReply = { projectId, spam: false, status: "OPEN" as const };
  const toTriage = { projectId, duplicateOfId: null, status: "OPEN" as const };
  // As Feedback's Possible duplicates lists them: neither post merged since.
  const duplicate = { projectId, status: "PENDING" as const, post: { duplicateOfId: null }, original: { duplicateOfId: null } };
  // As the sidebar and Autopilot's list: updates waiting, whatever the change's analysis is doing now.
  const updateWaits = { status: { in: ["PENDING" as const, "STALE" as const] } };
  const changeWaits = { projectId, actions: { some: updateWaits } };
  // Each list's oldest, as many as Home shows: merged and cut below; the totals come from counts.
  const [newPosts, replies, replyCount, triage, triageCount, duplicates, duplicateCount, changes, changeCount, updatesWaiting, failedSearches, failedQueries, failedTotal, setup, trendingVotes] =
    await Promise.all([
    prisma.post.count({ where: { projectId, duplicateOfId: null, createdAt: { gte: week } } }),
    // Set back to Open by hand, one has no `waitingSince`: its last message says how long.
    prisma.conversation.findMany({
      where: needsReply,
      orderBy: [{ waitingSince: { sort: "asc", nulls: "last" } }, { lastMessageAt: "asc" }],
      take: ATTENTION,
      select: { number: true, subject: true, waitingSince: true, lastMessageAt: true },
    }),
    prisma.conversation.count({ where: needsReply }),
    prisma.post.findMany({ where: toTriage, orderBy: { createdAt: "asc" }, take: ATTENTION, select: { number: true, title: true, createdAt: true } }),
    prisma.post.count({ where: toTriage }),
    prisma.duplicateSuggestion.findMany({
      where: duplicate,
      orderBy: { createdAt: "asc" },
      take: ATTENTION,
      select: { id: true, createdAt: true, post: { select: { number: true, title: true } }, original: { select: { title: true } } },
    }),
    prisma.duplicateSuggestion.count({ where: duplicate }),
    prisma.codeChange.findMany({
      where: changeWaits,
      orderBy: { mergedAt: "asc" },
      take: ATTENTION,
      select: { id: true, title: true, mergedAt: true, _count: { select: { actions: { where: updateWaits } } } },
    }),
    prisma.codeChange.count({ where: changeWaits }),
    prisma.codeChangeAction.count({ where: { ...updateWaits, codeChange: { projectId } } }),
    // The queries that found nothing in the last 30 days, the one first seen longest ago first.
    prisma.docsFailedSearchDay.groupBy({ by: ["query"], where: { projectId, day: { gte: month } }, _sum: { count: true }, _min: { day: true }, orderBy: { _min: { day: "asc" } }, take: ATTENTION }),
    prisma.$queryRaw<[{ count: number }]>`SELECT COUNT(DISTINCT query)::int AS count FROM docs_failed_search_day WHERE "projectId" = ${projectId} AND day >= ${month}`,
    // Every search that found nothing, as Docs → Insights counts them (past the queries kept each day).
    prisma.docsSearchDay.aggregate({ where: { projectId, day: { gte: month } }, _sum: { failed: true } }),
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        widgetSeenAt: true,
        ssoSecret: true,
        githubInstallation: { select: { projectId: true } },
        _count: { select: { team: true, invitations: { where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date(now) } } }, articles: { where: { publishedAt: { not: null }, deletedAt: null } } } },
      },
    }),
    prisma.vote.groupBy({ by: ["postId"], where: { projectId, createdAt: { gte: week } }, _count: { postId: true }, orderBy: { _count: { postId: "desc" } }, take: 5 }),
  ]);

  const attention: AttentionItem[] = [
    ...replies.map((c) => ({ key: `c${c.number}`, at: c.waitingSince ?? c.lastMessageAt, kind: "Conversation", title: c.subject, action: "Reply", href: `${base}/inbox/${c.number}` })),
    ...triage.map((p) => ({ key: `p${p.number}`, at: p.createdAt, kind: "New post", title: p.title, action: "Triage", href: `${base}/p/${p.number}` })),
    ...duplicates.map((d) => ({
      key: `d${d.id}`,
      at: d.createdAt,
      kind: "Possible duplicate",
      title: `${d.post.title} → ${d.original.title}`,
      action: "Merge",
      href: `${base}/feedback?show=duplicates`,
    })),
    ...changes.map((c) => ({
      key: `a${c.id}`,
      at: c.mergedAt,
      kind: "Autopilot",
      title: `${c.title} · ${c._count.actions} ${c._count.actions === 1 ? "update" : "updates"}`,
      action: "Review",
      href: `${base}/autopilot/${c.id}`,
    })),
    ...failedSearches.map((s) => ({
      key: `s${s.query}`,
      at: s._min.day!,
      kind: "Docs search",
      title: `“${s.query}” found nothing (${s._sum.count ?? 0} ${s._sum.count === 1 ? "time" : "times"})`,
      action: "Write it",
      href: `${base}/docs/new?title=${encodeURIComponent(s.query)}`,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const trendingPosts = await prisma.post.findMany({
    where: { id: { in: trendingVotes.map((v) => v.postId) }, duplicateOfId: null },
    select: { id: true, number: true, title: true, voteCount: true },
  });
  const trending = trendingVotes.flatMap((v) => {
    const post = trendingPosts.find((p) => p.id === v.postId);
    return post ? [{ ...post, thisWeek: v._count.postId }] : [];
  });

  const steps = [
    { key: "verify", title: "Verify your email", done: emailVerified, href: "/app/account" },
    { key: "widget", title: "Add the widget to your site", done: setup.widgetSeenAt !== null, href: `${base}/customize/widget` },
    // Only where the server can connect it.
    ...(githubConfig() ? [{ key: "github", title: "Connect GitHub", done: setup.githubInstallation !== null, href: `${base}/settings/integrations` }] : []),
    { key: "sso", title: "Set up single sign-on", done: setup.ssoSecret !== null, href: `${base}/settings/sso` },
    { key: "article", title: "Publish an article", done: setup._count.articles > 0, href: `${base}/docs/new` },
    { key: "team", title: "Invite your team", done: setup._count.team > 1 || setup._count.invitations > 0, href: `${base}/settings/team` },
  ];

  return {
    numbers: {
      newPosts,
      needReply: replyCount,
      updatesWaiting,
      searchesFailed: failedTotal._sum.failed ?? 0,
    },
    attention: attention.slice(0, ATTENTION),
    // Everything waiting, not just what was read: the counts, Autopilot's changes and the searches.
    moreAttention: Math.max(replyCount + triageCount + duplicateCount + changeCount + failedQueries[0].count - ATTENTION, 0),
    setup: steps.every((step) => step.done) ? null : steps,
    trending,
  };
}
