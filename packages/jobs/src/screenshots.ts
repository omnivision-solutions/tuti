import { type Prisma, prisma, type ScreenshotWindow } from "@tuti/db";
import { config, type JobInput, log, screenshotsEnabled } from "@tuti/shared";
import { openValue } from "@tuti/shared/signed";
import { mediaLimit } from "@tuti/shared/storage";

import { screenshotsMeter } from "./ai-usage";
import { type BrowserUse, browserUse, BrowserUseError, type RunSummary, type SessionCost, TERMINAL } from "./browser-use";
import { aiPaused } from "./credits";
import { storeImage } from "./import-media";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { lockProject } from "./running-draft";

/**
 * Screenshots (docs/plan.md, Screenshots): an agent in Browser Use's cloud browser opens a team's own app (Settings →
 * Screenshots), signs in once and takes each screenshot it's asked for, saving PNGs in its workspace, which are kept as
 * uploads of whoever started the run. Nothing here knows what the screenshots are for: the changelog and the docs ask
 * for them with `startScreenshots` (in the background) or `takeScreenshots` (in a job of their own).
 *
 * Each run gets a workspace of its own, so two never share one. Its cost is the browser session's (the model, the
 * browser's time and the proxy), charged as AI usage (`screenshots`); the browser is stopped once the files are down,
 * however the run ends, as an idle one is billed until it times out.
 */

/** What a password and a sign-in link are sealed for (sealValue). */
export const SCREENSHOT_SECRET = "screenshot-secret";

export const WINDOWS: Record<ScreenshotWindow, { width: number; height: number }> = { DESKTOP: { width: 1440, height: 900 }, PHONE: { width: 390, height: 844 } };

/** What the settings' Test asks for: the screen signing in lands on. */
export const LANDING_SHOT = "The screen you're on right after opening the app and signing in, as it is";

/** One run's time with the service, per try: past it the run counts as failed (and is tried again once). */
const RUN_MS = 15 * 60_000;
/** A run still RUNNING this long after its job started has stopped (its job died): it's settled as failed when it's read. */
export const SCREENSHOT_RUN_STALE_MS = 45 * 60_000;
/** How long a run may wait for a worker (Hatchet's `scheduleTimeout`, apps/worker tasks.ts): past it, Hatchet drops it. */
export const SCREENSHOT_QUEUE_MS = 60 * 60_000;
/** Less than this left of the budget: no retry (it couldn't get far). */
const MIN_TRY_USD = 0.01;
const POLL_MS = 5_000;

export const SCREENSHOT_ERRORS = {
  stopped: "It didn't finish. Try again.",
  noSettings: "Screenshots aren't set up for this project: add your app in Settings → Screenshots.",
  service: "Browser Use didn't answer. Try again in a moment.",
  unreadable: "The agent's answer couldn't be read. Try again.",
  signIn: "The agent couldn't sign in",
  credits: "The project is out of credits.",
} as const;

export type ShotResult = { id: string; show: string; imageId: string; description: string; url: string } | { id: string; show: string; failed: string };

/**
 * Settles the project's runs that stopped (see SCREENSHOT_RUN_STALE_MS) as failed, with their screenshots, claimed in
 * one statement so two reads at once settle each once. Then finishes what any ended run left at Browser Use: one whose
 * job died with the agent running (a deploy, the time limit), or whose charge or file deletion failed (the service
 * down for a moment), still holds its session or workspace. Its browser is stopped, which Browser Use would otherwise
 * bill until it times out, its cost charged and its files deleted, each id cleared once done. Charging claims the
 * session first (chargeSession), so a session is charged once whoever gets to it; deleting files twice is harmless.
 * Not under the project's lock: these are requests to Browser Use, which would hold it for seconds.
 */
export async function settleStaleScreenshotRuns(projectId: string) {
  const stale = {
    projectId,
    state: "RUNNING",
    // Counted from when its job started; one still queued (a deploy, a busy worker) has as long as Hatchet waits for a worker.
    OR: [{ startedAt: { lt: new Date(Date.now() - SCREENSHOT_RUN_STALE_MS) } }, { startedAt: null, createdAt: { lt: new Date(Date.now() - SCREENSHOT_QUEUE_MS) } }],
  } satisfies Prisma.ScreenshotRunWhereInput;
  // Found and claimed in one statement: a run whose job starts it meanwhile (a queued one) isn't stale by then, and two
  // reads at once claim each run once.
  const settled = await prisma.screenshotRun.updateManyAndReturn({ where: stale, data: { state: "FAILED", error: SCREENSHOT_ERRORS.stopped, finishedAt: new Date() }, select: { id: true } });
  for (const { id } of settled) {
    await prisma.screenshot.updateMany({ where: { runId: id, imageId: null, failed: "" }, data: { failed: SCREENSHOT_ERRORS.stopped } });
  }
  // Ended runs still holding a session (not charged yet) or a workspace (files not deleted yet), the ones just settled
  // included, and due: never tried first, then the longest waiting. A few at a time: a read waits on these requests.
  if (!screenshotsEnabled()) {
    return;
  }
  const now = new Date();
  const leftovers = await prisma.screenshotRun.findMany({
    where: {
      projectId,
      state: { in: ["DONE", "FAILED"] },
      OR: [{ sessionId: { not: null } }, { workspaceId: { not: null } }],
      AND: [{ OR: [{ cleanupAfter: null }, { cleanupAfter: { lte: now } }] }],
    },
    orderBy: [{ cleanupAfter: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: LEFTOVERS_PER_READ,
    select: { id: true, sessionId: true, workspaceId: true, cleanupAttempts: true },
  });
  const client = browserUse();
  for (const { id, sessionId, workspaceId, cleanupAttempts } of leftovers) {
    // Claimed for this try, its next one put off: two reads at once take it once, and one that keeps failing (the
    // service down) waits longer each time instead of filling every read.
    const attempt = cleanupAttempts + 1;
    const { count } = await prisma.screenshotRun.updateMany({
      where: { id, cleanupAttempts },
      data: { cleanupAttempts: attempt, cleanupAfter: new Date(now.getTime() + CLEANUP_BACKOFF_MS * 4 ** (attempt - 1)) },
    });
    if (count === 0) {
      continue;
    }
    // Its files only once its browser is stopped: else the next try does both again.
    const charge = sessionId ? await chargeSession(client, sessionId, { projectId, runId: id, model: config().screenshots.model }, null) : SETTLED;
    const cleared = !workspaceId || (charge.stopped && (await clearWorkspace(client, workspaceId, { projectId, runId: id })));
    if ((!charge.settled || !cleared) && attempt >= CLEANUP_ATTEMPTS) {
      // Given up: it stops costing reads and requests. What's left is in the log, to finish by hand.
      log.error("Finishing a screenshot run's leftovers at Browser Use failed too often: given up", {
        projectId,
        runId: id,
        sessionId: charge.settled ? null : sessionId,
        workspaceId: cleared ? null : workspaceId,
      });
      await prisma.screenshotRun.update({ where: { id }, data: { sessionId: null, workspaceId: null } });
    }
  }
}

/** Ended runs whose leftovers at Browser Use one read tries to finish at most (the rest, on later reads). */
const LEFTOVERS_PER_READ = 3;
/** Tries at a run's leftovers before giving up, a minute apart at first and four times longer each time (1, 4, 16, 64 minutes). */
const CLEANUP_ATTEMPTS = 5;
const CLEANUP_BACKOFF_MS = 60_000;

/** What became of a session: its browser stopped, and `settled` once it needs nothing more (charged, by this or another, or gone). */
type Charge = { stopped: boolean; cost: SessionCost | null; settled: boolean };
const SETTLED: Charge = { stopped: true, cost: null, settled: true };

/** Browser Use no longer has it (its session or workspace expired or was removed): nothing more to do with it. */
const gone = (error: unknown) => error instanceof BrowserUseError && error.status === 404;

/** A session's cost, just charged, added to its run's: a run whose job dies later keeps every try's cost. */
async function addCost(runId: string, cost: SessionCost) {
  const added = costFields([cost]);
  const run = await prisma.screenshotRun.findUniqueOrThrow({ where: { id: runId }, select: { cost: true, browserCost: true, proxyCost: true, llmCost: true } });
  const sum = (key: keyof typeof added) => (run[key]?.toNumber() ?? 0) + (added[key] ?? 0);
  await prisma.screenshotRun.update({ where: { id: runId }, data: { cost: sum("cost"), browserCost: sum("browserCost"), proxyCost: sum("proxyCost"), llmCost: sum("llmCost") } });
}

/** A run's cost columns, from its sessions' costs. */
function costFields(costs: SessionCost[]) {
  const total = (...keys: (keyof SessionCost)[]) => (costs.length ? costs.reduce((sum, cost) => sum + keys.reduce((part, key) => part + (Number(cost[key]) || 0), 0), 0) : null);
  return { cost: total("totalCostUsd"), browserCost: total("browserCostUsd"), proxyCost: total("proxyCostUsd"), llmCost: total("llmCostUsd", "searchCostUsd") };
}

/**
 * A run of `shots` for `projectId`, recorded (RUNNING) and queued as `screenshotRun`: its id and its screenshots' ids, in
 * order. One runs at a time per project (and one Test): with one running, that one is returned (`started` false),
 * checked and created under the project's lock so two starts at once make one. The caller checks the project's settings
 * and credits first; the run checks them again.
 */
export async function startScreenshots(projectId: string, shots: { show: string }[], { startedById, test = false }: { startedById: string; test?: boolean }) {
  await settleStaleScreenshotRuns(projectId);
  const select = { id: true, screenshots: { orderBy: { position: "asc" }, select: { id: true } } } satisfies Prisma.ScreenshotRunSelect;
  const { run, started } = await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const running = await tx.screenshotRun.findFirst({ where: { projectId, test, state: "RUNNING" }, select });
    return running
      ? { run: running, started: false }
      : {
          run: await tx.screenshotRun.create({ data: { projectId, startedById, test, screenshots: { create: shots.map((shot, position) => ({ projectId, position, show: shot.show })) } }, select }),
          started: true,
        };
  });
  if (!started) {
    return { runId: run.id, screenshotIds: run.screenshots.map((shot) => shot.id), started };
  }
  try {
    await enqueue("screenshotRun", { runId: run.id });
  } catch (error) {
    await finish(run.id, SCREENSHOT_ERRORS.service);
    throw error;
  }
  return { runId: run.id, screenshotIds: run.screenshots.map((shot) => shot.id), started };
}

/** The job: runs the agent for a recorded run (startScreenshots). */
export async function screenshotRun({ runId }: JobInput<"screenshotRun">, jobLog: JobLogger): Promise<JobResult> {
  const results = await takeScreenshots(runId);
  jobLog.info(`screenshot run ${runId}: ${results.filter((shot) => "imageId" in shot).length} of ${results.length} taken`);
  return { taken: results.filter((shot) => "imageId" in shot).length, shots: results.length };
}

/**
 * Takes a recorded run's screenshots: one agent run (and one more, on the retry model, when the first fails as a
 * whole) that signs in once and takes them all. Each comes back with its image, or why it wasn't taken. Never throws for
 * the service or the agent: the run is left FAILED, saying why.
 */
export async function takeScreenshots(runId: string): Promise<ShotResult[]> {
  // Claimed: a second job for the same run (a duplicate delivery) finds it started and leaves it.
  const { count } = await prisma.screenshotRun.updateMany({ where: { id: runId, state: "RUNNING", startedAt: null }, data: { startedAt: new Date() } });
  const run = await prisma.screenshotRun.findUniqueOrThrow({
    where: { id: runId },
    select: { projectId: true, startedById: true, screenshots: { orderBy: { position: "asc" }, select: { id: true, show: true } } },
  });
  if (count === 0) {
    return results(runId);
  }
  const settings = await prisma.screenshotSettings.findUnique({ where: { projectId: run.projectId } });
  if (!settings || !settings.appUrl) {
    return finish(runId, SCREENSHOT_ERRORS.noSettings);
  }
  if (await aiPaused(run.projectId)) {
    return finish(runId, SCREENSHOT_ERRORS.credits);
  }
  const { model, retryModel, maxCostUsd } = config().screenshots;
  const client = browserUse();
  const shots = run.screenshots;
  let answer: Answer | null = null;
  let error: string = SCREENSHOT_ERRORS.service;
  const costs: SessionCost[] = [];
  // Two tries, even on one model: a retry of the same model can pass where the first failed.
  for (const tryModel of [model, retryModel]) {
    // The run's budget, all tries together: a retry gets what the first left (the whole of it when its cost is unknown).
    const left = maxCostUsd - costs.reduce((sum, cost) => sum + (Number(cost.totalCostUsd) || 0), 0);
    if (left < MIN_TRY_USD) {
      break;
    }
    const tried = await attempt(client, { runId, projectId: run.projectId, settings, shots, model: tryModel, maxCostUsd: Number(left.toFixed(4)) });
    if (tried.cost) {
      costs.push(tried.cost);
    }
    if ("answer" in tried) {
      answer = tried.answer;
      break;
    }
    error = tried.error;
    // A try that left something at Browser Use (its browser not stopped or not charged, so what's left of the budget
    // isn't known either; or its files not deleted): no retry, which would put its own session and workspace on the run
    // in their place. A later read finishes them (settleStaleScreenshotRuns).
    if (tried.leftover) {
      break;
    }
  }
  // On the run already, each try's added as it was charged (addCost).
  const { cost } = costFields(costs);
  if (!answer) {
    return finish(runId, error);
  }
  if (!answer.signedIn) {
    return finish(runId, `${SCREENSHOT_ERRORS.signIn}${answer.error ? `: ${answer.error.slice(0, 500)}` : "."}`);
  }
  const share = cost === null ? null : cost / shots.length;
  for (const [index, shot] of shots.entries()) {
    // By its file only: one the agent left out isn't another's answer by its place in the list.
    const said = answer.shots.find((one) => one.file === fileName(index));
    const image = said?.reached === true ? answer.files.get(fileName(index)) : undefined;
    let failed = !said ? "The agent didn't say." : said.reached !== true ? said.reason?.slice(0, 500) || "The agent couldn't reach it." : !image ? "The agent didn't save it." : "";
    let imageId: string | null = null;
    if (!failed) {
      if (!run.startedById) {
        failed = "Whoever started it is no longer here to keep it.";
      } else {
        const stored = await storeImage(image!, { projectId: run.projectId, uploaderId: run.startedById });
        if ("mediaId" in stored) {
          imageId = stored.mediaId;
        } else {
          failed = stored.leftOut === "quota" ? "There's no room left for images in this project." : stored.leftOut === "unsupported" ? "Uploads aren't set up on this server." : "Its image couldn't be kept.";
        }
      }
    }
    await prisma.screenshot.update({
      where: { id: shot.id },
      data: imageId
        ? { imageId, ...pngSize(image!), description: said!.description?.slice(0, 1000) ?? "", url: said!.url?.slice(0, 2048) ?? "", takenAt: new Date(), cost: share }
        : { failed, cost: share },
    });
  }
  // Unless it was settled as failed meanwhile (its job past the stale limit): that stands.
  await prisma.screenshotRun.updateMany({ where: { id: runId, state: "RUNNING" }, data: { state: "DONE", finishedAt: new Date() } });
  return results(runId);
}

type Settings = NonNullable<Awaited<ReturnType<typeof prisma.screenshotSettings.findUnique>>>;
type Answer = { signedIn: boolean; error?: string; shots: { file?: string; reached?: boolean; description?: string; url?: string; reason?: string }[]; files: Map<string, Uint8Array> };

const fileName = (index: number) => `shot-${index + 1}.png`;

type Attempt = { runId: string; projectId: string; settings: Settings; shots: { show: string }[]; model: string; maxCostUsd: number };

/**
 * One agent run: its answer and files, or why not; then, however it ended (an error, the time limit), the session's
 * browser stopped and what the whole session cost, charged.
 */
async function attempt(client: BrowserUse, input: Attempt): Promise<({ answer: Answer } | { error: string }) & { cost: SessionCost | null; leftover: boolean }> {
  const session: { id: string | null; summary: RunSummary | null; workspaceId: string | null } = { id: null, summary: null, workspaceId: null };
  const outcome = await agentRun(client, input, session).catch((error: unknown) => {
    log.warn("A screenshot run's agent failed", { projectId: input.projectId, runId: input.runId, error });
    return { error: SCREENSHOT_ERRORS.service };
  });
  // The browser stopped first (in chargeSession), and the files deleted only once it has, so the agent can't save more
  // after them; nothing of the team's signed-in app stays at Browser Use, however the try (or its charge) ended. A
  // charge that threw (the database) did so after stopping the browser.
  // Thrown only by the database, after stopping the browser.
  let charge: Charge = { ...SETTLED, settled: false };
  let cleared = !session.workspaceId;
  try {
    charge = session.id ? await chargeSession(client, session.id, input, session.summary) : SETTLED;
  } finally {
    if (session.workspaceId && charge.stopped) {
      cleared = await clearWorkspace(client, session.workspaceId, input);
    }
  }
  return { ...outcome, cost: charge.cost, leftover: !charge.settled || !cleared };
}

async function agentRun(
  client: BrowserUse,
  { runId, settings, shots, model, maxCostUsd }: Attempt,
  session: { id: string | null; summary: RunSummary | null; workspaceId: string | null },
): Promise<{ answer: Answer } | { error: string }> {
  const workspace = await client.createWorkspace(`tuti-${runId}`);
  session.workspaceId = workspace.id;
  // Kept until its files are deleted: a settle deletes them if the job dies.
  await prisma.screenshotRun.update({ where: { id: runId }, data: { workspaceId: workspace.id } });
  const password = settings.signIn === "PASSWORD" && settings.password ? openValue(SCREENSHOT_SECRET, settings.password) : null;
  const created = await client.createRun({
    task: screenshotTask(settings, shots),
    model,
    workspaceId: workspace.id,
    maxCostUsd,
    outputSchema: OUTPUT_SCHEMA,
    // ponytail: the app's own hostname (and its subdomains) only; a sign-in page on another domain (an identity provider) never gets the password.
    ...(password && { secretBindings: [{ alias: PASSWORD_ALIAS, source: { type: "inline" as const, value: password }, allowedDomains: [new URL(settings.appUrl).hostname] }] }),
    // Always said: Browser Use's residential proxy is on by default and billed per GB at residential rates, so it's off
    // unless the project turned it on (an app that blocks cloud servers).
    browserSettings: { screenWidth: WINDOWS[settings.window].width, screenHeight: WINDOWS[settings.window].height, proxyCountryCode: settings.residentialProxy ? "us" : null },
  });
  session.id = created.sessionId;
  await prisma.screenshotRun.update({ where: { id: runId }, data: { externalId: created.id, sessionId: created.sessionId } });
  const deadline = Date.now() + RUN_MS;
  while (!TERMINAL.includes((await client.runStatus(created.id)).status)) {
    if (Date.now() > deadline) {
      return { error: "The agent took too long." };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const summary = await client.run(created.id);
  session.summary = summary;
  if (summary.status !== "completed") {
    return { error: summary.error ? `The agent stopped: ${withoutLink(summary.error, signInLink(settings)).slice(0, 500)}` : SCREENSHOT_ERRORS.service };
  }
  const said = readAnswer(summary, signInLink(settings));
  if (!said) {
    return { error: SCREENSHOT_ERRORS.unreadable };
  }
  // Download links last 60 seconds: all fetched at once, before anything else is done with them.
  // Only this run's: shot-1.png to shot-N.png, whatever else the agent saved.
  const names = new Set(shots.map((_, index) => fileName(index)));
  const wanted = new Map<string, string>();
  for (const file of (await client.files(workspace.id)).files) {
    const name = file.path.split("/").at(-1) ?? "";
    if (names.has(name) && file.url && !wanted.has(name)) {
      wanted.set(name, file.url);
    }
  }
  const downloaded = await Promise.all([...wanted].map(async ([name, url]) => [name, await download(url)] as const));
  const files = new Map(downloaded.filter((entry): entry is [string, Uint8Array] => entry[1] !== null));
  return { answer: { ...said, files } };
}

/** Deletes every file in a run's workspace (Browser Use keeps no way to delete the workspace itself); logged, never thrown. */
/** Whether it's empty now (its id cleared from the run). */
async function clearWorkspace(client: BrowserUse, workspaceId: string, { projectId, runId }: { projectId: string; runId: string }): Promise<boolean> {
  try {
    // A listing gives 100 at most: listed again until it's empty (bounded, for an agent that saved thousands).
    for (let round = 0; round < MAX_CLEAR_ROUNDS; round++) {
      const files = await client.files(workspaceId, false).then(
        (listed) => listed.files,
        (error: unknown) => {
          if (gone(error)) {
            return [];
          }
          throw error;
        },
      );
      if (files.length === 0) {
        await prisma.screenshotRun.updateMany({ where: { id: runId, workspaceId }, data: { workspaceId: null } });
        return true;
      }
      for (const file of files) {
        // One already gone is as good as deleted.
        await client.deleteFile(workspaceId, file.path).catch((error: unknown) => {
          if (!gone(error)) {
            throw error;
          }
        });
      }
    }
    log.error("A screenshot run's workspace at Browser Use still has files after deleting for a while", { projectId, runId, workspaceId });
  } catch (error) {
    log.error("Deleting a screenshot run's files at Browser Use failed: they're still there", { projectId, runId, workspaceId, error });
  }
  return false;
}

/**
 * Stops the session's browsers and reads what the session cost; then, once it's claimed (its id cleared from the run, so
 * the job and a settle never both charge it), charges it and adds it to the run's cost. Never throws for the service
 * (logged): a browser that couldn't be stopped (its cost may still grow), or a cost that can't be read or isn't a
 * number, leaves the session on the run, not settled, for a later read. A session Browser Use no longer has is settled
 * with nothing charged (logged): its cost can't be known any more.
 */
async function chargeSession(client: BrowserUse, sessionId: string, { projectId, runId, model }: { projectId: string; runId: string; model: string }, summary: RunSummary | null): Promise<Charge> {
  const pending: Charge = { stopped: true, cost: null, settled: false };
  const forget = async (why: string, error?: unknown) => {
    log.error(why, { projectId, runId, sessionId, error });
    await prisma.screenshotRun.updateMany({ where: { id: runId, sessionId }, data: { sessionId: null } });
    return SETTLED;
  };
  try {
    for (const browser of (await client.activeBrowsers(sessionId)).items) {
      // A browser gone by now (it stopped or timed out since it was listed) is as good as stopped: the session isn't.
      await client.stopBrowser(browser.id).catch((error: unknown) => {
        if (!gone(error)) {
          throw error;
        }
      });
    }
  } catch (error) {
    if (gone(error)) {
      return forget("A screenshot run's session is gone at Browser Use: it can't be charged", error);
    }
    log.error("Stopping a screenshot run's browser failed: it isn't charged yet", { projectId, runId, sessionId, error });
    return { ...pending, stopped: false };
  }
  let cost: SessionCost;
  try {
    cost = await client.sessionCost(sessionId);
  } catch (error) {
    if (gone(error)) {
      return forget("A screenshot run's session is gone at Browser Use: it can't be charged", error);
    }
    log.error("Reading a screenshot run's cost failed: it isn't charged yet", { projectId, runId, sessionId, error });
    return pending;
  }
  const dollars = Number(cost.totalCostUsd);
  if (!Number.isFinite(dollars) || dollars < 0) {
    log.error("A screenshot run's cost isn't a number: it isn't charged yet", { projectId, runId, sessionId, cost });
    return pending;
  }
  const { count } = await prisma.screenshotRun.updateMany({ where: { id: runId, sessionId }, data: { sessionId: null } });
  if (count === 0) {
    // Another (the job, or a read) claimed it and charges it.
    return SETTLED;
  }
  // Logged, never thrown, by the meter itself: a write that fails there leaves what to charge by hand in the log.
  await screenshotsMeter(projectId)({ kind: "agent", model, inputTokens: summary?.totalInputTokens ?? 0, outputTokens: summary?.totalOutputTokens ?? 0, cost: dollars });
  await addCost(runId, cost).catch((error: unknown) => log.error("Adding a screenshot run's cost to it failed: it was charged", { projectId, runId, sessionId, cost, error }));
  return { stopped: true, cost, settled: true };
}

const PASSWORD_ALIAS = "app_password";
/** Rounds of 100 files deleted at most from one workspace. */
const MAX_CLEAR_ROUNDS = 20;

/** What the agent answers with (the run's `outputSchema`). */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    signedIn: { type: "boolean", description: "Whether you're signed in to the app (true when it needs no sign-in)" },
    error: { type: "string", description: "When you couldn't sign in: what happened" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Its file name, e.g. shot-1.png" },
          reached: { type: "boolean", description: "Whether you reached the screen asked for and saved it" },
          description: { type: "string", description: "One sentence on what the screenshot shows, for its alt text" },
          url: { type: "string", description: "The page's address when you took it" },
          reason: { type: "string", description: "When not reached: why" },
        },
        required: ["file", "reached"],
      },
    },
  },
  required: ["signedIn", "shots"],
};

/** The agent's task: sign in (if it must), the team's notes, the rules, then each screenshot. */
export function screenshotTask(settings: Pick<Settings, "appUrl" | "signIn" | "username" | "signInLink" | "about" | "window">, shots: { show: string }[]): string {
  const { width, height } = WINDOWS[settings.window];
  const link = signInLink(settings);
  const signIn =
    settings.signIn === "PASSWORD"
      ? `If you're not signed in already, sign in with the username ${JSON.stringify(settings.username)} and the password ${PASSWORD_ALIAS} (a secret: enter it by its name).`
      : link
        ? `If you're not signed in already, open this sign-in link, which signs you in by itself: ${link} (it's secret: never repeat it or any part of it, in your answer or anywhere else)`
        : "The app needs no sign-in.";
  return [
    `You're taking screenshots of a web app for its team's help articles and changelog. Open ${settings.appUrl}. ${signIn}`,
    ...(settings.about.trim() ? [`What the team says about their app (follow it):\n${settings.about.trim()}`] : []),
    [
      "Rules:",
      "- Never delete, submit, send, buy, invite, save or change anything, and never sign out or log out: only look around, open pages, tabs and menus.",
      "- Close a tour, a cookie banner or a pop-up that covers the page when closing it changes nothing.",
      `- The browser's screen is ${width}×${height}. Take each screenshot of the browser viewport only, as a PNG file in the workspace, named as below.`,
      "- Do not resize the window or set a custom clip: save exactly what the browser viewport shows.",
      "- Before each screenshot, wait until the page has fully loaded: no spinners, skeletons or half-loaded images, and embedded previews and images finished loading.",
      "- If you can't reach a screen, don't save a file for it: say why, and go on to the next.",
    ].join("\n"),
    ["Screenshots:", ...shots.map((shot, index) => `${fileName(index)}: ${shot.show}`)].join("\n"),
    "Then answer with JSON: whether you're signed in, and per screenshot its file, whether you reached it, one sentence on what it shows, the page's address, or why not.",
  ].join("\n\n");
}

/** The sign-in link, opened (null without one). */
const signInLink = (settings: Pick<Settings, "signIn" | "signInLink">) => (settings.signIn === "LINK" && settings.signInLink ? openValue(SCREENSHOT_SECRET, settings.signInLink) : null);

/**
 * `text` without the sign-in link, nor the parts of it that may be its token: what the agent says is kept and shown to
 * the team, and the link must never come back. Its token is a query value or fragment of 8 characters or more, or a
 * path segment that long with a digit in it (a page like "dashboard" stays); a fragment of `key=value` pairs is read
 * as a query. A value that's itself an address
 * (`redirect_to=https://…`, a hash route `#/verify?token=…`) isn't taken out whole: it's looked into the same way.
 * ponytail: the agent is told never to repeat it, and this catches it verbatim; a link it rewrote (encoded, split)
 * would get through.
 */
export function withoutLink(text: string, link: string | null): string {
  if (!link) {
    return text;
  }
  const parts = [link, ...tokensIn(link, 0)];
  return parts.reduce((redacted, part) => redacted.replaceAll(part, "[sign-in link]"), text);
}

/** The parts of an address that may be a token (see withoutLink); one nested in it looked into, three levels deep. */
function tokensIn(address: string, depth: number): string[] {
  const url = URL.canParse(address, "https://x.invalid") ? new URL(address, "https://x.invalid") : null;
  if (!url || depth > 3) {
    return [];
  }
  // A fragment that's itself `key=value` pairs (`#access_token=…`, Netlify's `#invite_token=…`) is read as a query too.
  const fragment = url.hash.slice(1);
  const values = [...url.searchParams.values(), fragment, ...(fragment.includes("=") ? new URLSearchParams(fragment).values() : [])].filter((value) => value.length >= 8);
  const isAddress = (value: string) => value.includes("://") || value.startsWith("/");
  return [
    ...values.filter((value) => !isAddress(value)),
    ...values.filter(isAddress).flatMap((value) => tokensIn(value, depth + 1)),
    ...url.pathname.split("/").filter((part) => part.length >= 8 && /\d/.test(part)),
  ];
}

/** The agent's answer, from its output (by the schema) or its text, the sign-in link taken out; null when there's none to read. */
function readAnswer(summary: RunSummary, link: string | null): Omit<Answer, "files"> | null {
  let value: unknown = summary.output ?? null;
  if (typeof value === "string" || value === null) {
    const text = (typeof value === "string" ? value : (summary.result ?? "")).trim();
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    try {
      value = json ? JSON.parse(json) : null;
    } catch {
      value = null;
    }
  }
  // The schema checked: `signedIn` said (a missing one isn't a yes), and the shots listed.
  if (!value || typeof value !== "object" || typeof (value as Answer).signedIn !== "boolean" || !Array.isArray((value as Answer).shots)) {
    return null;
  }
  const answer = value as Answer;
  const text = (field: unknown) => (typeof field === "string" ? withoutLink(field, link) : undefined);
  return {
    signedIn: answer.signedIn,
    error: text(answer.error),
    shots: answer.shots
      .filter((shot) => shot && typeof shot === "object")
      .map((shot) => ({ file: shot.file, reached: shot.reached, description: text(shot.description), url: text(shot.url), reason: text(shot.reason) })),
  };
}

/**
 * A PNG's size in pixels, from its header: the screenshot as taken (often at 2×, and less tall than the screen, which
 * the browser's own bars take a part of), before its upload is scaled down to at most 2400px.
 */
export function pngSize(png: Uint8Array): { width: number | null; height: number | null } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng = png.byteLength >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452;
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: null, height: null };
}

/**
 * A workspace file by its download link (Browser Use's storage): the body, or null past the size limit (read as it
 * streams, so an oversized file is never held whole) or on a failure.
 */
async function download(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const limit = mediaLimit("importImage");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) {
        // Leaving the loop cancels the stream.
        return null;
      }
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** Ends a run as FAILED, saying why (and each screenshot not taken with it). */
async function finish(runId: string, error: string): Promise<ShotResult[]> {
  await prisma.$transaction([
    prisma.screenshot.updateMany({ where: { runId, imageId: null, failed: "" }, data: { failed: error } }),
    prisma.screenshotRun.updateMany({ where: { id: runId, state: "RUNNING" }, data: { state: "FAILED", error, finishedAt: new Date() } }),
  ]);
  return results(runId);
}

/** A run's screenshots as they are: each one's image, or why it wasn't taken. */
async function results(runId: string): Promise<ShotResult[]> {
  const shots = await prisma.screenshot.findMany({ where: { runId }, orderBy: { position: "asc" }, select: { id: true, show: true, imageId: true, description: true, url: true, failed: true } });
  return shots.map(({ id, show, imageId, description, url, failed }) => (imageId ? { id, show, imageId, description, url } : { id, show, failed: failed || "Not taken yet." }));
}
