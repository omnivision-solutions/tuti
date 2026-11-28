import { prisma, type Prisma } from "@tuti/db";
import { analysisOn, articlesViews, continueVerifyAll, creditBalance, enqueue, lockProject, newestRevision, noAi, NO_REPOSITORY, settleStale, type Statement, VERIFY_OFF, verifyAllRunSelect, verifyAllStuck, WAITING_FIX } from "@tuti/jobs";
import { codeChangesEnabled, creditsEnabled, creditsPerUsageDollar, log } from "@tuti/shared";
import { cache } from "react";
import { z } from "zod";

import { aiOrRefuse } from "./credits";
import { actingUserId, defineOperation, OperationError } from "./define";

/**
 * Verify (docs/plan.md, V5): an article checked against the project's repository, the default branch at its latest
 * commit, by hand. The run is the `verify-article` job (inline, it's done as this returns); its fix for what's out of
 * date is an Autopilot update, reviewed on the article's review like a pull request's edit.
 */

const slug = z.string().trim().min(1).max(80).describe("The article's slug: the end of its address, /docs/<slug>").meta({ examples: ["getting-started"] });

const isoTime = (what: string) => z.string().describe(`${what} (ISO 8601)`).meta({ examples: ["2026-11-02T09:30:00.000Z"] });
const nullableTime = (what: string) => z.string().nullable().describe(`${what} (ISO 8601)`).meta({ examples: ["2026-11-02T09:31:12.000Z"] });

/** verificationView's result. */
const verificationOutput = z
  .object({
    id: z.string().describe("The run's id").meta({ examples: ["cm3v1a2b3c4d5e6f7g8h9i0j1"] }),
    state: z
      .enum(["running", "done", "changed", "failed", "skipped"])
      .describe("`running`, `done`, `changed` (another edit landed while it ran: no fix written), `failed`, or `skipped` (verified at this commit already, on the same version)")
      .meta({ examples: ["done"] }),
    reason: z.string().describe("Why it failed, was skipped, or wrote no fix; empty otherwise").meta({ examples: [""] }),
    repo: z.string().describe("The GitHub repository it read (owner/name)").meta({ examples: ["acme/app"] }),
    commit: z.string().describe("The commit of the repository's default branch it read, its latest when it ran").meta({ examples: ["4f2c9e1b7a3d"] }),
    revision: z.string().nullable().describe("The article's version it checked: its newest, unpublished changes and every edit waiting in them included").meta({ examples: ["cm3x9a1b2c3d4e5f6g7h8i9j0"] }),
    counts: z
      .object({
        current: z.number().int().describe("Statements still true").meta({ examples: [11] }),
        outdated: z.number().int().describe("Statements out of date").meta({ examples: [1] }),
        unclear: z.number().int().describe("Statements the files can't tell").meta({ examples: [2] }),
      })
      .describe("How many statements it found of each kind"),
    statements: z
      .array(
        z.object({
          statement: z.string().describe("What the article says, in short").meta({ examples: ["Invites expire after 7 days."] }),
          source: z.string().optional().describe("The sentence it's in, quoted from the article").meta({ examples: ["An invite link expires after 7 days."] }),
          verdict: z.enum(["current", "outdated", "unclear"]).describe("Whether it's still true (`current`), out of date (`outdated`), or can't be told (`unclear`)").meta({ examples: ["outdated"] }),
          evidence: z.array(z.string()).describe("The repository's files that show it").meta({ examples: [["src/invites.ts"]] }),
          note: z.string().describe("For the team: what the code says").meta({ examples: ["Invites now expire after 14 days."] }),
        }),
      )
      .describe("What it found per statement"),
    fix: z
      .object({
        id: z.string().describe("The fix's id: an Autopilot update (codeChangeActions.dismiss, .undo)").meta({ examples: ["cm3f1x2y3z4a5b6c7d8e9f0g1"] }),
        status: z
          .enum(["waiting", "approved", "dismissed", "undone"])
          .describe("`waiting`: it waits for the team on the article's review (codeChanges.target), `approved` (with the article's changes), `dismissed` or `undone`")
          .meta({ examples: ["waiting"] }),
        revision: z.string().nullable().describe("The article's version the fix made").meta({ examples: ["cm3x9a1b2c3d4e5f6g7h8i9j2"] }),
        decidedBy: z.string().nullable().describe("Who approved, dismissed or undid it").meta({ examples: [null] }),
        decidedAt: z.string().nullable().describe("When (ISO 8601)").meta({ examples: [null] }),
        dismissReason: z.string().describe("Why it was dismissed; empty otherwise").meta({ examples: [""] }),
      })
      .nullable()
      .describe("Its fix for what's out of date, and what became of it; null when it wrote none"),
    startedBy: z.string().nullable().describe("Who started it; null for Autopilot").meta({ examples: ["Ada Admin"] }),
    startedReason: z
      .string()
      .describe("Why Autopilot started it, after pull requests' edits piled up on the article; empty when someone did")
      .meta({ examples: [""] }),
    createdAt: isoTime("When it started"),
    finishedAt: nullableTime("When it finished; null while it runs"),
  })
  .meta({ id: "ArticleVerification", description: "One Verify run on a docs article: what it found, and its fix" });

/** verifyAllView's result. */
const verifyAllOutput = z
  .object({
    id: z.string().describe("Its id").meta({ examples: ["cm3a1l2l3v4e5r6i7f8y9a0b1"] }),
    state: z
      .enum(["running", "done", "stopped"])
      .describe("`running`, `done`, or `stopped` (`reason` says why: out of credits, or the next article couldn't start)")
      .meta({ examples: ["running"] }),
    reason: z.string().describe("Why it stopped, saying how far it got; empty otherwise").meta({ examples: [""] }),
    total: z.number().int().describe("The published articles when it started").meta({ examples: [24] }),
    checked: z.number().int().describe("How many it has checked (done, skipped or failed)").meta({ examples: [9] }),
    leftOut: z.number().int().describe("How many it left out: unpublished or deleted since it started, or being verified by hand when their turn came").meta({ examples: [0] }),
    done: z.number().int().describe("How many are behind it, checked or left out: its progress").meta({ examples: [9] }),
    fixed: z.number().int().describe("Articles whose run wrote a fix").meta({ examples: [2] }),
    waiting: z.number().int().describe("How many of those fixes still wait on their review in Autopilot").meta({ examples: [2] }),
    failed: z.number().int().describe("Articles whose run failed").meta({ examples: [0] }),
    startedBy: z.string().nullable().describe("Who started it").meta({ examples: ["Ada Admin"] }),
    createdAt: isoTime("When it started"),
    finishedAt: nullableTime("When it finished; null while it runs"),
  })
  .describe("The Verify all run, with its progress");

const verificationSelect = {
  id: true,
  state: true,
  reason: true,
  repo: true,
  commit: true,
  revisionId: true,
  current: true,
  outdated: true,
  unclear: true,
  statements: true,
  createdAt: true,
  finishedAt: true,
  startedBy: { select: { name: true } },
  startedReason: true,
  fixes: { select: { id: true, status: true, dismissReason: true, decidedAt: true, decidedBy: { select: { name: true } }, revisions: { select: { id: true }, take: 1 } }, take: 1 },
} satisfies Prisma.ArticleVerificationSelect;

const FIX_STATUSES = { PENDING: "waiting", SCHEDULED: "waiting", STALE: "waiting", APPLIED: "approved", DISMISSED: "dismissed", UNDONE: "undone" } as const;

/** A run as the API and the app show it. */
export function verificationView(run: Prisma.ArticleVerificationGetPayload<{ select: typeof verificationSelect }>) {
  const fix = run.fixes[0];
  return {
    id: run.id,
    /** running, done, changed (another edit landed while it ran: no fix written), failed, or skipped (verified at this commit already). */
    state: run.state.toLowerCase() as "running" | "done" | "changed" | "failed" | "skipped",
    /** Why it failed, was skipped, or wrote no fix. */
    reason: run.reason,
    repo: run.repo,
    commit: run.commit,
    /** The article's revision it checked. */
    revision: run.revisionId,
    counts: { current: run.current, outdated: run.outdated, unclear: run.unclear },
    /** Per statement: what the article says, whether it's still true, out of date or can't be told, and the files that show it. */
    statements: run.statements as Statement[],
    /** Its fix, an Autopilot update (codeChangeActions.dismiss, .undo; approved with the article's changes), and what became of it. */
    fix: fix
      ? {
          id: fix.id,
          status: FIX_STATUSES[fix.status],
          revision: fix.revisions[0]?.id ?? null,
          decidedBy: fix.decidedBy?.name ?? null,
          decidedAt: fix.decidedAt?.toISOString() ?? null,
          dismissReason: fix.dismissReason,
        }
      : null,
    startedBy: run.startedBy?.name ?? null,
    /** Why Autopilot started it, after pull requests' edits piled up on the article (empty: someone did). */
    startedReason: run.startedReason,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export type VerificationView = ReturnType<typeof verificationView>;

/** An article's verification history, newest first. ponytail: the latest 20; page when teams need older ones. */
export const articleVerifications = cache(async (articleId: string) => {
  await settleStale(articleId);
  const runs = await prisma.articleVerification.findMany({ where: { articleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: verificationSelect });
  return runs.map(verificationView);
});

const teamArticle = async (projectId: string, articleSlug: string) => {
  const article = await prisma.article.findFirst({ where: { projectId, slug: articleSlug, deletedAt: null }, select: { id: true, publishedAt: true } });
  if (!article) {
    throw new OperationError(404, "not_found", `There's no article “${articleSlug}”`);
  }
  return article;
};

/** Why Verify can't run on an article now (null: it can), as articles.verify refuses it (409, `code`), credits aside. */
async function whyNot(projectId: string, published: boolean): Promise<{ code: string; message: string } | null> {
  if (!published) {
    return { code: "not_published", message: "Only a published article can be verified." };
  }
  // No AI on this server: there's no Autopilot setting to point to.
  if (!codeChangesEnabled()) {
    return { code: "ai_off", message: noAi() };
  }
  if (!(await analysisOn(projectId))) {
    return { code: "analysis_off", message: VERIFY_OFF };
  }
  if ((await prisma.githubRepository.count({ where: { connection: { projectId } } })) === 0) {
    return { code: "no_repository", message: NO_REPOSITORY };
  }
  return null;
}

/** Why Verify can't run on an article now, in words (null: it can): the editor's Verify panel says it. */
export const verifyUnavailable = async (projectId: string, published: boolean) => (await whyNot(projectId, published))?.message ?? null;

export const verifyArticle = defineOperation({
  name: "articles.verify",
  title: "Verify an article",
  summary:
    "Verify a published docs article against the project's GitHub repository, and write an Autopilot update fixing what's out of date. Sends repository files (secrets left out) to the AI provider; costs credits where used. One runs per article at a time: starting it again returns the one running",
  method: "POST",
  path: "/articles/{slug}/verify",
  scope: "write",
  access: "team",
  errors: [402, 409, 503],
  input: z.object({ slug }),
  output: verificationOutput.describe(
    "The run: `running` while it checks (see articles.verifications), or `skipped` when run again at the same commit on the same version. Only while the project analyses merged pull requests and has a repository (409 otherwise)",
  ),
  run: async ({ actor, projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    const unavailable = await whyNot(projectId, article.publishedAt !== null);
    if (unavailable) {
      throw new OperationError(409, unavailable.code, unavailable.message);
    }
    // One running already is returned as it is, whatever the credits now (checked again under the lock below); one that
    // has stopped is settled first, so it never stands in the way.
    await settleStale(article.id);
    const running = await prisma.articleVerification.findFirst({ where: { articleId: article.id, state: "RUNNING" }, select: verificationSelect });
    if (running) {
      return verificationView(running);
    }
    await aiOrRefuse(projectId, "code_changes");
    // Checked and started under the project's lock: two starts at once (a double click, a retry) make one run.
    const started = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      // Still published (and there) under the lock: an unpublish or delete since the check above refuses it.
      const still = await tx.article.findFirst({ where: { id: article.id, deletedAt: null }, select: { publishedAt: true } });
      if (!still) {
        throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
      }
      if (!still.publishedAt) {
        throw new OperationError(409, "not_published", "Only a published article can be verified.");
      }
      await settleStale(article.id, tx);
      const running = await tx.articleVerification.findFirst({ where: { articleId: article.id, state: "RUNNING" }, select: verificationSelect });
      if (running) {
        return { running };
      }
      const run = await tx.articleVerification.create({
        data: {
          projectId,
          articleId: article.id,
          startedById: actingUserId(actor),
          // The version checked: an edit landing after this is one it didn't see, so its fix isn't written.
          revisionId: await newestRevision(article.id, tx),
        },
        select: { id: true },
      });
      return { run };
    });
    if (started.running) {
      return verificationView(started.running);
    }
    const run = started.run!;
    try {
      await enqueue("verifyArticle", { verificationId: run.id });
    } catch {
      await prisma.articleVerification.updateMany({ where: { id: run.id, state: "RUNNING" }, data: { state: "FAILED", reason: "Couldn't start it.", finishedAt: new Date() } });
      throw new OperationError(503, "unavailable", "Couldn't start Verify. Try again in a moment.");
    }
    return verificationView(await prisma.articleVerification.findUniqueOrThrow({ where: { id: run.id }, select: verificationSelect }));
  },
});

export const listVerifications = defineOperation({
  name: "articles.verifications",
  title: "List an article's checks",
  summary: "List a docs article's verification history (articles.verify), newest first: the latest 20 runs",
  method: "GET",
  path: "/articles/{slug}/verifications",
  scope: "read",
  access: "team",
  input: z.object({ slug }),
  output: z.object({ verifications: z.array(verificationOutput).describe("Its runs, newest first") }).describe("The article's verification history"),
  run: async ({ projectId }, input) => ({ verifications: await articleVerifications((await teamArticle(projectId, input.slug)).id) }),
});

/**
 * Verify all (docs/plan.md, V7): Verify on every published article, by hand, one after another (continueVerifyAll),
 * each its own run and job, so one failing doesn't stop the rest.
 */

/** Every published article: what Verify all checks. */
const publishedArticles = (projectId: string) => ({ projectId, deletedAt: null, publishedAt: { not: null } }) satisfies Prisma.ArticleWhereInput;

/**
 * What one article's Verify costs, in dollars, before the project has run any: its two requests are the pick (the
 * article and up to 2,000 paths, about 20K tokens in, a few hundred out) and the check (the article and up to 30 KB of
 * files, about 10K tokens in, 1K to 6K out). At the default model's prices (about $1 in and $5 out per million tokens)
 * that's about $0.04 to $0.06. Once it has, the average of its latest runs is used instead.
 */
const VERIFY_DOLLARS = 0.05;
const ESTIMATE_RUNS = 20;

/**
 * What Verify all would check, and with credits on, what it would cost: `each` per article (the average of the
 * project's latest finished runs, `measured`, else VERIFY_DOLLARS), `total` for all of them (an article verified at the
 * same commit and unchanged since is skipped, costing nothing, so it's at most this), and the balance.
 */
export async function verifyAllEstimate(projectId: string) {
  const articles = await prisma.article.count({ where: publishedArticles(projectId) });
  if (!creditsEnabled()) {
    return { articles, credits: null };
  }
  const runs = await prisma.articleVerification.findMany({
    where: { projectId, state: "DONE", cost: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ESTIMATE_RUNS,
    select: { cost: true },
  });
  const dollars = runs.length > 0 ? runs.reduce((sum, run) => sum + run.cost!.toNumber(), 0) / runs.length : VERIFY_DOLLARS;
  const each = dollars * creditsPerUsageDollar();
  return { articles, credits: { each, total: each * articles, measured: runs.length > 0, balance: (await creditBalance(projectId)).balance } };
}

export type VerifyAllEstimate = Awaited<ReturnType<typeof verifyAllEstimate>>;

const verifyAllSelect = {
  id: true,
  state: true,
  reason: true,
  articleIds: true,
  taken: true,
  createdAt: true,
  finishedAt: true,
  startedBy: { select: { name: true } },
  runs: { select: { ...verifyAllRunSelect, fixes: { select: { status: true }, take: 1 } } },
} satisfies Prisma.VerifyAllSelect;

/**
 * A Verify all's next article is started without waiting for its job where jobs run in-process (JOBS_DRIVER=inline):
 * there the job, and every article after it, would run inside the request that started it or looked at it.
 */
const inBackground = () => ({ wait: process.env.JOBS_DRIVER !== "inline" });

function verifyAllView(all: Prisma.VerifyAllGetPayload<{ select: typeof verifyAllSelect }>) {
  const running = all.runs.some((run) => run.state === "RUNNING");
  return {
    id: all.id,
    /** running, done, or stopped (`reason` says why: out of credits, or the next article couldn't start). */
    state: all.state.toLowerCase() as "running" | "done" | "stopped",
    reason: all.reason,
    /** The published articles when it started. */
    total: all.articleIds.length,
    /** How many it has checked (done, skipped or failed). */
    checked: all.runs.filter((run) => run.state !== "RUNNING").length,
    /** How many it left out: unpublished or deleted since it started, or being verified by hand when their turn came. */
    leftOut: all.taken - all.runs.length,
    /** How many are behind it, checked or left out: its progress. */
    done: all.taken - (running ? 1 : 0),
    /** Articles whose run wrote a fix, and how many of those fixes still wait on their review in Autopilot. */
    fixed: all.runs.filter((run) => run.fixes.length > 0).length,
    waiting: all.runs.filter((run) => run.fixes.some((fix) => WAITING_FIX.has(fix.status))).length,
    failed: all.runs.filter((run) => run.state === "FAILED").length,
    startedBy: all.startedBy?.name ?? null,
    createdAt: all.createdAt.toISOString(),
    finishedAt: all.finishedAt?.toISOString() ?? null,
  };
}

export type VerifyAllView = ReturnType<typeof verifyAllView>;

/**
 * The project's latest Verify all (null: none yet). One running whose article's run has stopped (its worker went away:
 * settleStale), or that didn't go on after one ended (STUCK_MS), goes on to the next article here, so it never waits for
 * good. Not in the moment between one run ending and its job starting the next: that's the job's to do.
 */
export async function latestVerifyAll(projectId: string): Promise<VerifyAllView | null> {
  const latest = await prisma.verifyAll.findFirst({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: verifyAllSelect });
  if (latest?.state !== "RUNNING") {
    return latest && verifyAllView(latest);
  }
  if (!verifyAllStuck(latest)) {
    return verifyAllView(latest);
  }
  // Its run whose worker went away is settled first, so it goes on to the next article.
  const running = latest.runs.find((run) => run.state === "RUNNING");
  if (running) {
    await settleStale(running.articleId);
  }
  await continueVerifyAll(latest.id, log, inBackground());
  return verifyAllView(await prisma.verifyAll.findUniqueOrThrow({ where: { id: latest.id }, select: verifyAllSelect }));
}

/** Why Verify all can't run now (null: it can), in words: its dialog says it. */
export const verifyAllUnavailable = async (projectId: string) => (await whyNot(projectId, true))?.message ?? null;

export const verifyAll = defineOperation({
  name: "articles.verifyAll",
  title: "Verify every article",
  summary:
    "Verify every published docs article, one after another, most read first, each its own run, so one failing doesn't stop the rest; one email to the owners at the end for the fixes it wrote. Only people can start it, in the app, after seeing what it costs: API keys and MCP get 403",
  method: "POST",
  path: "/docs/verify-all",
  scope: "write",
  access: "team",
  input: z.object({}),
  output: verifyAllOutput.describe(
    "The run, with its progress. One runs per project at a time: starting it again while one runs returns that one. Articles verified at the same commit and unchanged since are skipped. With credits, running out stops it (402 when there are none to start with)",
  ),
  run: async ({ actor, projectId }) => {
    // It costs AI for every article: a person starts it, having seen what it costs (the app's confirmation).
    if (actor.kind !== "user") {
      throw new OperationError(403, "people_only", "Only a person can start Verify all, in the app, after seeing what it costs.");
    }
    const unavailable = await whyNot(projectId, true);
    if (unavailable) {
      throw new OperationError(409, unavailable.code, unavailable.message);
    }
    const latest = await latestVerifyAll(projectId);
    if (latest?.state === "running") {
      return latest;
    }
    await aiOrRefuse(projectId, "code_changes");
    const published = await prisma.article.findMany({ where: publishedArticles(projectId), orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (published.length === 0) {
      throw new OperationError(409, "no_articles", "There's no published article to verify.");
    }
    // The most read first: if credits run out partway, those are the ones checked.
    const views = await articlesViews(published.map((article) => article.id));
    const articleIds = published.map((article) => article.id).toSorted((a, b) => (views.get(b) ?? 0) - (views.get(a) ?? 0));
    // Started under the project's lock: two starts at once make one.
    const started = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const running = await tx.verifyAll.findFirst({ where: { projectId, state: "RUNNING" }, select: { id: true } });
      return running ?? (await tx.verifyAll.create({ data: { projectId, startedById: actor.userId, articleIds }, select: { id: true } }));
    });
    await continueVerifyAll(started.id, log, inBackground());
    return verifyAllView(await prisma.verifyAll.findUniqueOrThrow({ where: { id: started.id }, select: verifyAllSelect }));
  },
});
