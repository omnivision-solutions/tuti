import { imageKey, imageWidths } from "@tuti/content/media";
import { type Prisma, prisma, type ScreenshotSignIn, type ScreenshotWindow } from "@tuti/db";
import { aiPaused, LANDING_SHOT, lockProject, lastingMediaUrl, placeChangelogScreenshots, SCREENSHOT_SECRET, screenshotsAsked, settleStaleScreenshotRuns, startScreenshots } from "@tuti/jobs";
import { creditsEnabled, creditsPerUsageDollar, screenshotsEnabled } from "@tuti/shared";
import { sealValue } from "@tuti/shared/signed";
import { mediaStorage } from "@tuti/shared/storage";
import { z } from "zod";

import { displayDoc } from "../content";
import { NO_CREDITS } from "./credits";
import { type Actor, defineOperation, OperationError } from "./define";

/**
 * Screenshots (docs/plan.md, Screenshots): an agent in a cloud browser signs in to the team's own app and takes
 * screenshots of it (@tuti/jobs screenshots.ts). The settings say where the app is and how to sign in; its password and
 * sign-in link are sealed, and never come back from a read (only whether one is set). A run takes minutes, in the
 * background: screenshots.take starts one, screenshots.get reads it.
 */

/** Whether screenshots work on this server: a Browser Use key, and uploads to keep them in. */
export const screenshotsAvailable = () => screenshotsEnabled() && mediaStorage() !== null;
export const SCREENSHOTS_UNAVAILABLE = "Screenshots aren't available on this server: they need a Browser Use key (BROWSER_USE_API_KEY) and uploads.";
const NOT_SET_UP = "Add your app's address in Settings → Screenshots first.";

export const MAX_SHOTS = 10;
export const MAX_ABOUT = 2000;

const SIGN_INS = ["none", "password", "link"] as const;
const WINDOW_NAMES = ["desktop", "phone"] as const;

const runSelect = {
  id: true,
  state: true,
  test: true,
  error: true,
  cost: true,
  createdAt: true,
  finishedAt: true,
  screenshots: {
    orderBy: { position: "asc" },
    select: { id: true, show: true, width: true, height: true, description: true, url: true, failed: true, takenAt: true, image: { select: { id: true, status: true, width: true, height: true } } },
  },
} satisfies Prisma.ScreenshotRunSelect;

type RunRow = Prisma.ScreenshotRunGetPayload<{ select: typeof runSelect }>;

const imageOutput = z
  .object({
    id: z.string().describe("The upload's id").meta({ examples: ["cm3media0001"] }),
    url: z.string().describe("A lasting link to the image at its full size (at most 2400px wide)").meta({ examples: ["https://tuti.so/api/media/cm3media0001/1440.webp?s=…"] }),
    width: z.number().int().describe("Its width in pixels").meta({ examples: [1440] }),
    height: z.number().int().describe("Its height in pixels").meta({ examples: [900] }),
  })
  .meta({ id: "ScreenshotImage" });

const runOutput = z
  .object({
    id: z.string().describe("The run's id, for screenshots.get").meta({ examples: ["cm3run0001"] }),
    state: z.enum(["running", "done", "failed"]).describe("`running` while the agent works (minutes); `done` once it ended, each screenshot taken or saying why not; `failed` when it couldn't run (`error` says why)").meta({ examples: ["done"] }),
    test: z.boolean().describe("Whether it's the settings' Test: it only signs in and takes the screen it lands on").meta({ examples: [false] }),
    error: z.string().nullable().describe("Why it failed, e.g. it couldn't sign in").meta({ examples: [null] }),
    cost: z.number().nullable().describe("What it cost in dollars (the browser session's, all of it), once it ended; null while running or when the service didn't say").meta({ examples: [0.0419] }),
    createdAt: z.string().describe("When it started").meta({ examples: ["2026-11-25T10:00:00.000Z"] }),
    finishedAt: z.string().nullable().describe("When it ended; null while running").meta({ examples: ["2026-11-25T10:03:30.000Z"] }),
    screenshots: z
      .array(
        z.object({
          id: z.string().describe("The screenshot's id").meta({ examples: ["cm3shot0001"] }),
          show: z.string().describe("What it was asked to show").meta({ examples: ["The billing page with the invoices list"] }),
          state: z.enum(["running", "taken", "failed"]).describe("`taken` with its image; `failed` with why not").meta({ examples: ["taken"] }),
          image: imageOutput.nullable().describe("Its image, once taken"),
          width: z.number().int().nullable().describe("Its width in pixels as taken (often twice the screen's, on a high-density screen); its `image` may be scaled down").meta({ examples: [2880] }),
          height: z.number().int().nullable().describe("Its height in pixels as taken: the browser's viewport, a little less than the screen's").meta({ examples: [1376] }),
          description: z.string().describe("What it shows, in a sentence: also its alt text").meta({ examples: ["The billing page, listing three invoices"] }),
          url: z.string().describe("The page's address when it was taken").meta({ examples: ["https://app.example.com/billing"] }),
          failed: z.string().nullable().describe("Why it wasn't taken").meta({ examples: [null] }),
          takenAt: z.string().nullable().describe("When it was taken").meta({ examples: ["2026-11-25T10:03:00.000Z"] }),
        }),
      )
      .describe("Its screenshots, in the order asked for"),
  })
  .meta({ id: "ScreenshotRun", description: "A screenshot run: an agent that signs in to your app once and takes each screenshot asked for" });

function runView(run: RunRow): z.infer<typeof runOutput> {
  const state = run.state.toLowerCase() as "running" | "done" | "failed";
  return {
    id: run.id,
    state,
    test: run.test,
    error: run.error || null,
    cost: run.cost?.toNumber() ?? null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    screenshots: run.screenshots.map((shot) => {
      const image =
        mediaStorage() && shot.image?.status === "READY" && shot.image.width && shot.image.height
          ? { id: shot.image.id, url: lastingMediaUrl(imageKey(shot.image.id, imageWidths(shot.image.width).at(-1)!)), width: shot.image.width, height: shot.image.height }
          : null;
      return {
        id: shot.id,
        show: shot.show,
        state: image ? "taken" : shot.failed || state !== "running" ? "failed" : "running",
        image,
        width: image ? shot.width : null,
        height: image ? shot.height : null,
        description: shot.description,
        url: shot.url,
        failed: image ? null : shot.failed || (state === "running" ? null : "Not taken."),
        takenAt: shot.takenAt?.toISOString() ?? null,
      };
    }),
  };
}

async function readRun(projectId: string, where: Prisma.ScreenshotRunWhereInput) {
  await settleStaleScreenshotRuns(projectId);
  const run = await prisma.screenshotRun.findFirst({ where: { projectId, ...where }, orderBy: { createdAt: "desc" }, select: runSelect });
  return run && runView(run);
}

const settingsOutput = z
  .object({
    available: z.boolean().describe("Whether screenshots work on this server (a Browser Use key and uploads); without, nothing runs").meta({ examples: [true] }),
    appUrl: z.string().nullable().describe("Your app's address, where the agent starts; null: not set up").meta({ examples: ["https://app.example.com"] }),
    signIn: z.enum(SIGN_INS).describe("How it signs in: `password` (username and password), `link` (a link that signs in by itself) or `none`").meta({ examples: ["password"] }),
    username: z.string().describe("The username or email it signs in with").meta({ examples: ["e2e-demo@example.com"] }),
    passwordSet: z.boolean().describe("Whether a password is saved (it's never returned)").meta({ examples: [true] }),
    signInLinkSet: z.boolean().describe("Whether a sign-in link is saved (it's never returned)").meta({ examples: [false] }),
    about: z.string().describe("What the agent reads about your app on every run").meta({ examples: ["After signing in, pick the Acme workspace. Close the tour."] }),
    window: z.enum(WINDOW_NAMES).describe("The browser window: `desktop` (1440×900) or `phone` (390×844)").meta({ examples: ["desktop"] }),
    residentialProxy: z.boolean().describe("Whether runs go through a residential proxy: only for an app that blocks visits from cloud servers; runs cost more").meta({ examples: [false] }),
    test: runOutput.nullable().describe("The latest Test (screenshotSettings.test), if any"),
  })
  .meta({ id: "ScreenshotSettings", description: "How screenshots sign in to your app" });

/** The project's settings as the page and screenshotSettings.get show them: never the password or sign-in link. */
export async function settingsView(projectId: string): Promise<z.infer<typeof settingsOutput>> {
  const settings = await prisma.screenshotSettings.findUnique({ where: { projectId } });
  return {
    available: screenshotsAvailable(),
    appUrl: settings?.appUrl ?? null,
    signIn: (settings?.signIn.toLowerCase() ?? "none") as (typeof SIGN_INS)[number],
    username: settings?.username ?? "",
    passwordSet: Boolean(settings?.password),
    signInLinkSet: Boolean(settings?.signInLink),
    about: settings?.about ?? "",
    window: (settings?.window.toLowerCase() ?? "desktop") as (typeof WINDOW_NAMES)[number],
    residentialProxy: settings?.residentialProxy ?? false,
    test: await readRun(projectId, { test: true }),
  };
}

const webAddress = (error: string) =>
  z
    .string()
    .trim()
    .max(2048, error)
    .pipe(z.url({ protocol: /^https?$/, error }));

export const getScreenshotSettings = defineOperation({
  name: "screenshotSettings.get",
  title: "Get screenshot settings",
  summary: "How screenshots sign in to your app: its address, how it signs in (never the password or link) and notes for the agent, with the latest Test",
  method: "GET",
  path: "/screenshots/settings",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: settingsOutput.describe("The screenshot settings"),
  run: ({ projectId }) => settingsView(projectId),
});

export const updateScreenshotSettings = defineOperation({
  name: "screenshotSettings.update",
  title: "Update screenshot settings",
  summary: "Set where your app is and how the screenshot agent signs in to it (use a demo account: the agent is told only to look, never to change anything). Fields left out keep their value",
  method: "PATCH",
  path: "/screenshots/settings",
  scope: "write",
  access: "admin",
  input: z.object({
    appUrl: webAddress("Enter your app's full address, starting with https://")
      .optional()
      .describe("Your app's address, where the agent starts. Moved to another site (host, scheme or port), the saved password and sign-in link are forgotten unless new ones are sent with it"),
    signIn: z.enum(SIGN_INS, { error: "Pick password, link or none" }).optional().describe("How it signs in: `password`, `link` or `none`; the other way's secret is forgotten"),
    username: z.string().trim().max(320, "Keep the username under 320 characters").optional().describe("The username or email to sign in with (`password`)"),
    password: z.string().max(1000, "Keep the password under 1,000 characters").optional().describe("The password (`password`); left out or empty keeps the saved one"),
    signInLink: z
      .union([z.literal(""), webAddress("Enter the sign-in link's full address, starting with https://")])
      .optional()
      .describe("A link that signs in by itself, like a magic link (`link`); left out or empty keeps the saved one. The agent is given it to open"),
    about: z.string().trim().max(MAX_ABOUT, `Keep it under ${MAX_ABOUT.toLocaleString("en")} characters`).optional().describe("What the agent should know about your app, read on every run"),
    window: z.enum(WINDOW_NAMES, { error: "Pick desktop or phone" }).optional().describe("The browser window: `desktop` (1440×900) or `phone` (390×844)"),
    residentialProxy: z
      .boolean()
      .optional()
      .describe("Runs go through a residential proxy (in the US): only if your app blocks visits from cloud servers. Runs cost more (the proxy's traffic is billed)"),
  }),
  output: settingsOutput.describe("The screenshot settings, as saved"),
  example: { appUrl: "https://app.example.com", signIn: "password", username: "demo@example.com", password: "a demo account's password", about: "Close the welcome tour.", window: "desktop" },
  // Read, merged and saved under the project's lock: two updates at once (a password, the notes) keep both.
  run: async ({ projectId }, input) => {
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await saveSettings(tx, projectId, input);
    });
    return settingsView(projectId);
  },
});

/** screenshotSettings.update's read, merge and save, in `tx` under the project's lock. */
async function saveSettings(tx: Prisma.TransactionClient, projectId: string, input: z.infer<typeof updateScreenshotSettings.input>) {
  const saved = await tx.screenshotSettings.findUnique({ where: { projectId } });
  const appUrl = input.appUrl ?? saved?.appUrl;
  if (!appUrl) {
    throw new OperationError(400, "invalid_input", "Enter your app's address");
  }
  const signIn = (input.signIn?.toUpperCase() ?? saved?.signIn ?? "NONE") as ScreenshotSignIn;
  const username = input.username ?? saved?.username ?? "";
  // The secrets are only ever given to the agent on the app's own host: one that moved forgets them, so changing the
  // address can't send the saved password (typed only on that host) or link somewhere else.
  // By origin: another scheme (https to http) or port is another place too.
  const sameHost = !!saved && new URL(saved.appUrl).origin === new URL(appUrl).origin;
  const password = input.password ? sealValue(SCREENSHOT_SECRET, input.password) : sameHost ? saved.password : null;
  const signInLink = input.signInLink ? sealValue(SCREENSHOT_SECRET, input.signInLink) : sameHost ? saved.signInLink : null;
  const moved = saved && !sameHost ? " again: the app's address moved to another site" : "";
  if (signIn === "PASSWORD" && (!username || !password)) {
    throw new OperationError(400, "invalid_input", username && moved ? `Enter the password${moved}` : "Enter the username and password to sign in with");
  }
  if (signIn === "LINK" && !signInLink) {
    throw new OperationError(400, "invalid_input", `Enter the sign-in link${moved}`);
  }
  const data = {
    appUrl,
    signIn,
    // Only the way it signs in keeps its secret.
    username: signIn === "PASSWORD" ? username : "",
    password: signIn === "PASSWORD" ? password : null,
    signInLink: signIn === "LINK" ? signInLink : null,
    about: input.about ?? saved?.about ?? "",
    window: (input.window?.toUpperCase() ?? saved?.window ?? "DESKTOP") as ScreenshotWindow,
    residentialProxy: input.residentialProxy ?? saved?.residentialProxy ?? false,
  };
  await tx.screenshotSettings.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
}

/** Refuses a run that can't go: no key or uploads here (503), no settings (409), no credits (402). */
async function refuseRun(projectId: string) {
  if (!screenshotsAvailable()) {
    throw new OperationError(503, "unavailable", SCREENSHOTS_UNAVAILABLE);
  }
  if (!(await prisma.screenshotSettings.count({ where: { projectId } }))) {
    throw new OperationError(409, "not_set_up", NOT_SET_UP);
  }
  if (await aiPaused(projectId)) {
    throw new OperationError(402, "no_credits", NO_CREDITS);
  }
}

const startedBy = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/**
 * Starts a run, or finds the one running: one at a time per project (and one Test), as each holds a worker slot for
 * minutes and spends up to the cost cap. A Test returns the one running; screenshots.take refuses (409).
 */
async function start(projectId: string, actor: Actor, shots: { show: string }[], test: boolean, changelogEntryId?: string) {
  const started = await startScreenshots(projectId, shots, { startedById: startedBy(actor), test, changelogEntryId }).catch(() => {
    throw new OperationError(503, "unavailable", "Couldn't start the screenshots. Try again in a moment.");
  });
  if (!started.started && !test) {
    throw new OperationError(409, "busy", "Screenshots are already being taken for this project: try again once they're done.");
  }
  return (await readRun(projectId, { id: started.runId }))!;
}

export const testScreenshotSettings = defineOperation({
  name: "screenshotSettings.test",
  title: "Test screenshot sign-in",
  summary:
    "Run the screenshot agent once with the saved settings: it signs in and takes the screen it lands on. Takes a few minutes, in the background (read it with screenshotSettings.get); costs credits where used. One runs at a time: starting it again returns the one running",
  method: "POST",
  path: "/screenshots/settings/test",
  scope: "write",
  access: "admin",
  errors: [402, 409, 503],
  input: z.object({}),
  output: runOutput.describe("The Test run"),
  run: async ({ actor, projectId }) => {
    await refuseRun(projectId);
    return start(projectId, actor, [{ show: LANDING_SHOT }], true);
  },
});

export const takeScreenshots = defineOperation({
  name: "screenshots.take",
  title: "Take screenshots",
  summary: `Start a run that signs in to your app (Settings → Screenshots) and takes up to ${MAX_SHOTS} screenshots, each described in words. Takes minutes, in the background: read the results with screenshots.get. One run at a time per project (409 while one runs). Costs credits where used`,
  method: "POST",
  path: "/screenshots",
  scope: "write",
  // Owners and admins, who set the sign-in: what's asked for goes into the agent's task beside a sign-in link, so asking
  // is trusted as setting it is.
  access: "admin",
  errors: [402, 409, 503],
  input: z.object({
    shots: z
      .array(
        z.object({
          show: z
            .string()
            .trim()
            .min(1, "Say what each screenshot shows")
            .max(500, "Keep each screenshot's description under 500 characters")
            .describe("What it shows, as you'd ask a person: the screen, and what's open or selected on it"),
        }),
      )
      .min(1, "Ask for a screenshot")
      .max(MAX_SHOTS, `Ask for up to ${MAX_SHOTS} screenshots at a time`)
      .describe(`The screenshots to take, up to ${MAX_SHOTS}, in order`),
  }),
  output: runOutput.describe("The run, running"),
  example: { shots: [{ show: "The billing page with the invoices list" }, { show: "Settings → Team with the Invite dialog open" }] },
  run: async ({ actor, projectId }, input) => {
    await refuseRun(projectId);
    return start(projectId, actor, input.shots, false);
  },
});

export const getScreenshots = defineOperation({
  name: "screenshots.get",
  title: "Get a screenshot run",
  summary: "A screenshot run (screenshots.take) and its screenshots: each one's image, what it shows and its page, or why it wasn't taken",
  method: "GET",
  path: "/screenshots/{id}",
  scope: "read",
  access: "team",
  errors: [404],
  input: z.object({ id: z.string().trim().min(1).max(100).describe("The run's id").meta({ examples: ["cm3run0001"] }) }),
  output: runOutput.describe("The run"),
  run: async ({ projectId }, input) => {
    const run = await readRun(projectId, { id: input.id });
    if (!run) {
      throw new OperationError(404, "not_found", "There's no such screenshot run");
    }
    return run;
  },
});

export const takeChangelogScreenshots = defineOperation({
  name: "changelog.takeScreenshots",
  title: "Fill an entry's screenshot lines",
  summary: `Take screenshots for the entry's "[Screenshot: …]" lines (up to ${MAX_SHOTS}), in the background (screenshots.get reads the run). Each one taken replaces its line if the line is still as it was; one not taken stays, holding publishing back. Costs credits where used`,
  method: "POST",
  path: "/changelog/{number}/screenshots",
  scope: "write",
  // As screenshots.take: what's asked for goes into the agent's task beside the sign-in.
  access: "admin",
  errors: [402, 404, 409, 503],
  input: z.object({ number: z.coerce.number().int().positive().describe("The entry's number in the project").meta({ examples: [7] }) }),
  output: runOutput.describe("The run, running"),
  run: async ({ actor, projectId }, { number }) => {
    const entry = await prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { id: true, content: true, body: true } });
    if (!entry) {
      throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
    }
    await refuseRun(projectId);
    const asked = screenshotsAsked(displayDoc(entry));
    if (asked.length === 0) {
      throw new OperationError(409, "no_markers", "This entry has no “[Screenshot: …]” lines to fill.");
    }
    return start(projectId, actor, asked.slice(0, MAX_SHOTS).map((show) => ({ show })), false, entry.id);
  },
});

/** Shots whose cost the estimate averages: the project's latest. */
const ESTIMATE_SHOTS = 20;

/**
 * What the changelog editor shows of an entry's screenshots: how many of its lines ask for one, whether they can be
 * taken (null: not on this server, or not set up), the entry's latest run while it runs, the lines it didn't take that
 * are still there with why, and what taking them would cost in credits, from recent screenshots (with credits on; null when none has been priced yet).
 */
export async function entryScreenshots(projectId: string, entry: { id: string; content: unknown; body: string }) {
  const latest = await prisma.screenshotRun.findFirst({ where: { changelogEntryId: entry.id }, orderBy: { createdAt: "desc" }, select: { id: true, state: true } });
  if (latest?.state === "RUNNING") {
    await settleStaleScreenshotRuns(projectId);
  }
  const asked = screenshotsAsked(displayDoc(entry));
  const setUp = Boolean(await prisma.screenshotSettings.count({ where: { projectId } }));
  const run =
    latest &&
    (await prisma.screenshotRun.findUniqueOrThrow({
      where: { id: latest.id },
      select: { state: true, screenshots: { orderBy: { position: "asc" }, select: { show: true, failed: true, imageId: true } } },
    }));
  const left = [...asked];
  const failed =
    run && run.state !== "RUNNING"
      ? run.screenshots.flatMap(({ show, failed, imageId }) => {
          const at = imageId ? -1 : left.indexOf(show);
          return at === -1 ? [] : (left.splice(at, 1), [{ show, reason: failed || "Not taken." }]);
        })
      : [];
  const priced = creditsEnabled()
    ? await prisma.screenshot.findMany({ where: { projectId, cost: { not: null }, run: { test: false } }, orderBy: { createdAt: "desc" }, take: ESTIMATE_SHOTS, select: { cost: true } })
    : [];
  return {
    asked: asked.length,
    available: screenshotsAvailable() && setUp ? true : screenshotsAvailable() ? ("not_set_up" as const) : false,
    running: run?.state === "RUNNING" ? run.screenshots.length : null,
    // A run for it ended: the section stays (focus goes to it after one), saying when every line is filled.
    ran: Boolean(run && run.state !== "RUNNING"),
    failed,
    // ponytail: the average shot's cost; a run's own sign-in, shared by its shots, makes a lone one cost more.
    estimate: priced.length ? (priced.reduce((sum, shot) => sum + shot.cost!.toNumber(), 0) / priced.length) * creditsPerUsageDollar() * Math.min(asked.length, MAX_SHOTS) : null,
    credits: creditsEnabled(),
  };
}

export type EntryScreenshots = Awaited<ReturnType<typeof entryScreenshots>>;

/**
 * Places the entry's latest run's screenshots if it ended without (its job an older worker's, during a deploy, or one
 * that died): the editor does it before reading the entry. Whether it placed any.
 */
export async function placeLeftoverScreenshots(entryId: string): Promise<boolean> {
  const latest = await prisma.screenshotRun.findFirst({ where: { changelogEntryId: entryId }, orderBy: { createdAt: "desc" }, select: { id: true, state: true, placedAt: true } });
  return Boolean(latest && latest.state !== "RUNNING" && !latest.placedAt && (await placeChangelogScreenshots(latest.id)) > 0);
}

/** Whether the entry's latest screenshot run is still running (a stopped one settled first): the editor asks while one runs. */
export async function entryScreenshotsRunning(projectId: string, number: number) {
  await settleStaleScreenshotRuns(projectId);
  const run = await prisma.screenshotRun.findFirst({ where: { projectId, changelogEntry: { number } }, orderBy: { createdAt: "desc" }, select: { state: true } });
  return run?.state === "RUNNING";
}
