import { prisma } from "@tuti/db";

import { githubConfig } from "@/lib/github";
import { treeOrder } from "@/lib/autopilot-words";
import { autopilotTargets, emailedOnCompletion } from "@/server/operations/code-changes";
import { awake } from "@/server/operations/conversations";
import { failedSearchesSql, insightsSince } from "@/server/operations/docs-insights";
import { supportDomain } from "@/server/inbound";
import { hasOwnContent } from "@/server/sample-content";

/** Home's numbers, what needs the team (by kind, oldest first), what's left to set up and the trending feedback. */
export type HomeOverview = Awaited<ReturnType<typeof homeOverview>>;

/** How much each of "Needs your attention"'s groups lists; past it, "See all" opens its list. */
const ATTENTION = 5;
const DAY = 86_400_000;

/** One thing waiting for the team, with what to do about it. */
export type AttentionItem = {
  key: string;
  at: Date;
  title: string;
  action: string;
  href: string;
  /** Autopilot's updates going out by themselves, with when the first goes (Publish now, Stop). */
  scheduled?: { ids: string[]; dueAt: string; emails: number; posts: number };
};

/**
 * A project's Home (docs/plan.md, the redesign's step 3): four numbers that each open their list; what
 * needs the team, by kind in the order it matters (conversations needing a reply, Autopilot's posts and articles to review,
 * posts to triage, possible duplicates, docs searches that found nothing), each kind's oldest few (the
 * searches: the most searched) with their action and its list; "Get set up" while something's left (verifying the person's own email
 * isn't a step: the strip above every page in /app asks for it), with sample content offered until the project has content of its own; and the ideas with the most
 * votes this week.
 * Sample content (server/sample-content.ts) is left out of all of it.
 */
export async function homeOverview(projectId: string, slug: string) {
  const now = Date.now();
  const week = new Date(now - 7 * DAY);
  // Searches as Reporting → Searches counts them (the page their number opens): its days.
  const month = insightsSince(new Date(now));
  const base = `/app/${slug}`;
  // What waits for a reply: the Inbox's Open view (and the sidebar's count).
  const needsReply = { projectId, spam: false, sample: false, status: "OPEN" as const, ...awake() };
  const conversationSelect = { number: true, subject: true, waitingSince: true, lastMessageAt: true } as const;
  const toTriage = { projectId, sample: false, duplicateOfId: null, status: "OPEN" as const };
  // As Feedback's Possible duplicates lists them: neither post merged since.
  const duplicate = { projectId, status: "PENDING" as const, post: { duplicateOfId: null }, original: { duplicateOfId: null } };
  const [newPosts, replies, replyCount, triage, triageCount, duplicates, duplicateCount, targets, failedSearches, failedQueries, failedTotal, setup, trendingVotes, started] =
    await Promise.all([
    prisma.post.count({ where: { projectId, sample: false, duplicateOfId: null, createdAt: { gte: week } } }),
    // Set back to Open by hand, one has no `waitingSince`: its last message says how long. Both kinds' oldest, merged below.
    Promise.all([
      prisma.conversation.findMany({ where: { ...needsReply, waitingSince: { not: null } }, orderBy: { waitingSince: "asc" }, take: ATTENTION, select: conversationSelect }),
      prisma.conversation.findMany({ where: { ...needsReply, waitingSince: null }, orderBy: { lastMessageAt: "asc" }, take: ATTENTION, select: conversationSelect }),
    ]).then((lists) => lists.flat()),
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
    // Autopilot's To review (posts and articles, the sidebar's count too), sample content left out.
    // In To review's order first, then without sample content: a sample row leading its board keeps the board's place.
    autopilotTargets(projectId).then(({ feedback, helpCenter }) => treeOrder([...feedback, ...helpCenter]).filter((target) => !target.sample)),
    // The queries that found nothing in the last 30 days and weren't dismissed since, the one first seen longest ago first.
    // The most searched first, as Reporting → Searches lists them (the page its link opens).
    prisma.$queryRaw<{ query: string; count: number; firstDay: Date }[]>`SELECT * FROM (${failedSearchesSql(projectId, month)}) s ORDER BY count DESC, query LIMIT ${ATTENTION}`,
    prisma.$queryRaw<[{ count: number }]>`SELECT count(*)::int AS count FROM (${failedSearchesSql(projectId, month)}) s`,
    // Every search that found nothing, as Reporting → Searches counts them (past the queries kept each day).
    prisma.docsSearchDay.aggregate({ where: { projectId, day: { gte: month } }, _sum: { failed: true } }),
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        name: true,
        widgetSeenAt: true,
        ssoSecret: true,
        supportInbox: true,
        uses: true,
        githubInstallation: { select: { projectId: true } },
        // Whether any email has come in: one is enough.
        inboundEmails: { take: 1, select: { id: true } },
        _count: {
          select: {
            team: true,
            // Sent ones: an import's invitations waiting to be sent aren't the team invited yet.
            invitations: { where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date(now) }, sentAt: { not: null } } },
            articles: { where: { publishedAt: { not: null }, deletedAt: null, sample: false } },
            changelogEntries: { where: { publishedAt: { not: null }, sample: false } },
          },
        },
      },
    }),
    prisma.vote.groupBy({ by: ["postId"], where: { projectId, createdAt: { gte: week }, post: { sample: false } }, _count: { postId: true }, orderBy: { _count: { postId: "desc" } }, take: 5 }),
    hasOwnContent(projectId),
  ]);

  // Publish now on what completes a post emails people: Home asks first, saying how many.
  const shown = targets.slice(0, ATTENTION);
  const completions = await prisma.codeChangeAction.findMany({
    where: { id: { in: shown.flatMap((target) => target.scheduled) }, kind: "RESOLVES", post: { status: { not: "COMPLETED" }, duplicateOfId: null } },
    select: { postId: true },
  });
  const completing = new Set(completions.flatMap((action) => (action.postId ? [action.postId] : [])));
  const emails = await emailedOnCompletion(projectId, [...completing]);

  // Each kind with the list that has them all (`link`: "See all" unless it says otherwise); kinds with nothing waiting are left out.
  const attention: { key: string; title: string; total: number; href: string; link?: string; items: AttentionItem[] }[] = [
    {
      key: "replies",
      title: "Need a reply",
      total: replyCount,
      href: `${base}/inbox`,
      items: replies
        .map((c) => ({ key: `c${c.number}`, at: c.waitingSince ?? c.lastMessageAt, title: c.subject, action: "Reply", href: `${base}/inbox/${c.number}` }))
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(0, ATTENTION),
    },
    {
      // To review's rows, in its order: a post or article each (whatever pull requests and Verify runs are behind it), opening its review.
      key: "autopilot",
      title: "To review in Autopilot",
      total: targets.length,
      href: `${base}/autopilot`,
      items: shown.map((target): AttentionItem => {
        // A post's path is `feedback/<its id>`.
        const completes = completing.has(target.path.slice("feedback/".length));
        return {
          key: `t${target.path}`,
          at: new Date(target.since),
          title: target.title,
          action: "Review",
          href: `${base}/autopilot/${target.path}`,
          ...(target.nextDueAt && {
            scheduled: { ids: target.scheduled, dueAt: target.nextDueAt, emails: completes ? (emails.get(target.path.slice("feedback/".length)) ?? 0) : 0, posts: completes ? 1 : 0 },
          }),
        };
      }),
    },
    {
      key: "triage",
      title: "New posts to triage",
      total: triageCount,
      href: `${base}/feedback`,
      items: triage.map((p) => ({ key: `p${p.number}`, at: p.createdAt, title: p.title, action: "Triage", href: `${base}/p/${p.number}` })),
    },
    {
      key: "duplicates",
      title: "Possible duplicates",
      total: duplicateCount,
      href: `${base}/feedback?show=duplicates`,
      items: duplicates.map((d) => ({ key: `d${d.id}`, at: d.createdAt, title: `${d.post.title} → ${d.original.title}`, action: "Merge", href: `${base}/feedback?show=duplicates` })),
    },
    {
      key: "searches",
      title: "Queries that found nothing",
      total: failedQueries[0].count,
      href: `${base}/reporting/searches`,
      link: "Open Searches",
      items: failedSearches.map((s) => ({
        key: `s${s.query}`,
        at: s.firstDay,
        title: `“${s.query}” found nothing (${s.count} ${s.count === 1 ? "time" : "times"})`,
        action: "Write it",
        href: `${base}/docs/new?title=${encodeURIComponent(s.query)}`,
      })),
    },
  ].filter((group) => group.items.length > 0);

  const trendingPosts = await prisma.post.findMany({
    where: { id: { in: trendingVotes.map((v) => v.postId) }, duplicateOfId: null },
    select: { id: true, number: true, title: true, voteCount: true },
  });
  const trending = trendingVotes.flatMap((v) => {
    const post = trendingPosts.find((p) => p.id === v.postId);
    return post ? [{ ...post, thisWeek: v._count.postId }] : [];
  });

  // What the team said it will use after "Create project" picks the steps; nothing picked (projects from before, or skipped), today's five.
  const picked = new Set(setup.uses);
  const uses = (...any: string[]) => picked.size === 0 || any.some((use) => picked.has(use));
  // Each with what it's for, in a line under its title: what the step gets a team using every part of Tuti, the same
  // whatever the server or the project has turned on (a product choice: most teams will use it all).
  // Support is set up once its first email is in (the address forwarded), or once the inbox is on where the server takes no email.
  const supportSet = setup.supportInbox && (setup.inboundEmails.length > 0 || supportDomain() === null);
  const steps = [
    { key: "widget", title: "Add the widget to your site", description: `Users give feedback, get help and see what's new right inside ${setup.name}.`, action: "Get snippet", done: setup.widgetSeenAt !== null, href: `${base}/setup?step=widget`, shown: true },
    // Only where the server can connect it; Autopilot updates feedback, docs and the changelog from merges.
    { key: "github", title: "Connect GitHub", description: "Autopilot reads your merged pull requests and suggests updates to your posts, docs and changelog.", action: "Connect", done: setup.githubInstallation !== null, href: `${base}/settings/integrations`, shown: githubConfig() !== null && uses("feedback", "docs", "changelog") },
    // Who's posting and who's writing in, signed in from the team's own app.
    { key: "sso", title: "Set up single sign-on", description: `Users sign in with their ${setup.name} account, so every post and message says who it's from.`, action: "Set up", done: setup.ssoSecret !== null, href: `${base}/settings/sso`, shown: uses("feedback", "support") },
    // Steps of their own only once picked.
    { key: "support", title: "Set up your support inbox", description: "Answer messages from the widget and your support email together, in one shared inbox.", action: "Set up", done: supportSet, waiting: setup.supportInbox && !supportSet ? "Waiting for your first email" : undefined, href: `${base}/settings/support`, shown: picked.has("support") },
    { key: "article", title: "Publish an article", description: "Start your help center, so people find answers before they write in.", action: "New article", done: setup._count.articles > 0, href: `${base}/docs/new`, shown: uses("docs") },
    { key: "changelog", title: "Publish an update", description: "Show users what shipped, on your portal and in the widget.", action: "New entry", done: setup._count.changelogEntries > 0, href: `${base}/changelog/new`, shown: picked.has("changelog") },
    { key: "team", title: "Invite your team", description: "Share triage and replies with your teammates.", action: "Invite", done: setup._count.team > 1 || setup._count.invitations > 0, href: `${base}/settings/team`, shown: true },
  ]
    .flatMap(({ shown, ...step }) => (shown ? [step] : []))
    // What's left first, in this order; done ones last.
    .sort((a, b) => Number(a.done) - Number(b.done));

  return {
    numbers: {
      newPosts,
      needReply: replyCount,
      toReview: targets.length,
      searchesFailed: failedTotal._sum.failed ?? 0,
    },
    attention,
    // Nothing of its own yet (sample content aside): Home offers sample content, and says how to start rather than "all caught up".
    started,
    setup: steps.every((step) => step.done) ? null : steps,
    trending,
  };
}
