import { prisma } from "@tuti/db";

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
  const [newPosts, replies, triage, duplicates, changes, failedSearches, failedTotal, setup, trendingVotes] = await Promise.all([
    prisma.post.count({ where: { projectId, duplicateOfId: null, createdAt: { gte: week } } }),
    prisma.conversation.findMany({
      where: { projectId, spam: false, waitingSince: { not: null } },
      orderBy: { waitingSince: "asc" },
      select: { number: true, subject: true, waitingSince: true },
    }),
    prisma.post.findMany({ where: { projectId, duplicateOfId: null, status: "OPEN" }, orderBy: { createdAt: "asc" }, select: { number: true, title: true, createdAt: true } }),
    prisma.duplicateSuggestion.findMany({
      where: { projectId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, post: { select: { number: true, title: true } }, original: { select: { title: true } } },
    }),
    prisma.codeChange.findMany({
      where: { projectId, state: "READY", actions: { some: { status: { in: ["PENDING", "STALE"] } } } },
      orderBy: { mergedAt: "asc" },
      select: { id: true, title: true, mergedAt: true, _count: { select: { actions: { where: { status: { in: ["PENDING", "STALE"] } } } } } },
    }),
    prisma.docsFailedSearchDay.groupBy({ by: ["query"], where: { projectId, day: { gte: month } }, _sum: { count: true }, _min: { day: true }, orderBy: { _sum: { count: "desc" } }, take: 5 }),
    prisma.docsFailedSearchDay.aggregate({ where: { projectId, day: { gte: month } }, _sum: { count: true } }),
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        widgetSeenAt: true,
        ssoSecret: true,
        githubInstallation: { select: { projectId: true } },
        _count: { select: { team: true, invitations: true, articles: { where: { publishedAt: { not: null }, deletedAt: null } } } },
      },
    }),
    prisma.vote.groupBy({ by: ["postId"], where: { projectId, createdAt: { gte: week } }, _count: { postId: true }, orderBy: { _count: { postId: "desc" } }, take: 5 }),
  ]);

  const attention: AttentionItem[] = [
    ...replies.map((c) => ({ key: `c${c.number}`, at: c.waitingSince!, kind: "Conversation", title: c.subject, action: "Reply", href: `${base}/inbox/${c.number}` })),
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
    { key: "github", title: "Connect GitHub", done: setup.githubInstallation !== null, href: `${base}/settings/integrations` },
    { key: "sso", title: "Set up single sign-on", done: setup.ssoSecret !== null, href: `${base}/settings/sso` },
    { key: "article", title: "Publish an article", done: setup._count.articles > 0, href: `${base}/docs/new` },
    { key: "team", title: "Invite your team", done: setup._count.team > 1 || setup._count.invitations > 0, href: `${base}/settings/team` },
  ];

  return {
    numbers: {
      newPosts,
      needReply: replies.length,
      updatesWaiting: changes.reduce((sum, c) => sum + c._count.actions, 0),
      searchesFailed: failedTotal._sum.count ?? 0,
    },
    attention: attention.slice(0, ATTENTION),
    moreAttention: Math.max(attention.length - ATTENTION, 0),
    setup: steps.every((step) => step.done) ? null : steps,
    trending,
  };
}
