import type { Doc } from "@tuti/content";
import { imageKey, imageWidths } from "@tuti/content/media";
import { type Prisma, prisma, type ScreenshotSignIn, type ScreenshotWindow } from "@tuti/db";
import { aiPaused, dropChangedScreenshotProfile, enqueue, foundDomains, LANDING_SHOT, lockProject, lastingMediaUrl, MAX_SHOW, placeScreenshots, SCREENSHOT_SECRET, partlyScannedFor, scannedFor, screenshotsAsked, settleStaleScreenshotRuns, startScreenshots } from "@tuti/jobs";
import { creditsEnabled, creditsPerUsageDollar, screenshotsEnabled } from "@tuti/shared";
import { sealValue } from "@tuti/shared/signed";
import { mediaStorage } from "@tuti/shared/storage";
import { getDomain } from "tldts";
import { z } from "zod";

import { HIDDEN_CHARACTERS, hasHiddenCharacters } from "@/lib/hidden-characters";

import { displayDoc } from "../content";
import { NO_CREDITS } from "./credits";
import { actingUserId, type Actor, defineOperation, OperationError } from "./define";
import { countSpecFetch } from "./fetch-limits";

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
export const MAX_OTHER_DOMAINS = 20;
/** A domain name as Browser Use's network policies take one: letters, digits and hyphens in dot-separated labels, no IP. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
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
    otherDomains: z
      .array(z.string())
      .describe("Other hosts your app needs (its API, a sign-in page, a CDN): the browser opens only your app's own host, its sign-in link's, and these (with their subdomains), and the password can be entered on any of them")
      .meta({ examples: [["acme.auth0.com"]] }),
    skippedDomains: z
      .array(z.string())
      .describe("Hosts found for your app's sign-in (screenshotSettings.signInDomains) that you removed: not allowed for its runs")
      .meta({ examples: [[]] }),
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
    otherDomains: settings?.otherDomains ?? [],
    skippedDomains: settings?.skippedDomains ?? [],
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
      .describe("Your app's address, where the agent starts. Changed in any way (another page on the same site too), the saved password and sign-in link are forgotten unless sent again with it"),
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
    otherDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(DOMAIN, "Enter each domain on its own, like cdn.example.com: no https://, path or port")
          // A shared suffix (vercel.app, github.io, com) would open every site under it: a domain of its own only.
          .refine((domain) => getDomain(domain, { allowPrivateDomains: true }) !== null, {
            error: (issue) => `${String(issue.input)} is shared by many sites: enter your own domain under it, like acme.${String(issue.input)}`,
          }),
      )
      .max(MAX_OTHER_DOMAINS, `List up to ${MAX_OTHER_DOMAINS} other domains`)
      .optional()
      .describe(
        `Other hosts your app needs, up to ${MAX_OTHER_DOMAINS} (its API like api.example.com, a sign-in page like acme.auth0.com, a CDN): the browser opens only your app's own host, its sign-in link's, these and those found for its sign-in (screenshotSettings.signInDomains), each with its subdomains, and the password can be entered on any of them. They replace the list; adding one needs the password or sign-in link sent again`,
      ),
    skippedDomains: z
      .array(z.string().trim().toLowerCase().regex(DOMAIN, "Enter each domain on its own, like cdn.example.com: no https://, path or port"))
      .max(50, "List up to 50 removed domains")
      .optional()
      .describe("Hosts found for your app's sign-in (screenshotSettings.signInDomains) not to allow for its runs. They replace the list; needs nothing sent again either way"),
  }),
  output: settingsOutput.describe("The screenshot settings, as saved"),
  example: { appUrl: "https://app.example.com", signIn: "password", username: "demo@example.com", password: "a demo account's password", about: "Close the welcome tour.", window: "desktop" },
  // Read, merged and saved under the project's lock: two updates at once (a password, the notes) keep both.
  run: async ({ projectId }, input) => {
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await saveSettings(tx, projectId, input);
    });
    await dropChangedScreenshotProfile(projectId);
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
  // The secrets are only ever given to the agent on the app's own host: an address changed forgets them, so changing
  // it can't send the saved password (typed only on that host) or link somewhere else. Any change, a path on the same
  // site too: the hosts found in the page it points to are allowed for them (foundDomains), and a page can echo text
  // from its address (a search's query).
  const sameAddress = !!saved && saved.appUrl === appUrl;
  // Sent again, it's saved as sent: never checked against the saved one, so no request can test a guess at it.
  const password = input.password ? sealValue(SCREENSHOT_SECRET, input.password) : sameAddress ? saved.password : null;
  const signInLink = input.signInLink ? sealValue(SCREENSHOT_SECRET, input.signInLink) : sameAddress ? saved.signInLink : null;
  const moved = saved && !sameAddress ? " again: the app's address changed" : "";
  if (signIn === "PASSWORD" && (!username || !password)) {
    throw new OperationError(400, "invalid_input", username && moved ? `Enter the password${moved}` : "Enter the username and password to sign in with");
  }
  if (signIn === "LINK" && !signInLink) {
    throw new OperationError(400, "invalid_input", `Enter the sign-in link${moved}`);
  }
  // A domain added sends the browser, and the password typed there, somewhere new: as when the app moves, only with the
  // secret sent again, so whoever adds one (another admin, a key) must know it. Taking domains off needs nothing.
  // One found for the app's sign-in (allowed already) isn't another.
  const found = saved ? foundDomains({ ...saved, appUrl }).map(({ host }) => host) : [];
  const added = (input.otherDomains ?? []).filter((domain) => !(saved?.otherDomains ?? []).includes(domain) && !found.includes(domain));
  if (added.length > 0 && signIn === "PASSWORD" && password && !input.password) {
    throw new OperationError(400, "invalid_input", "Enter the password again to add another domain: it can be typed there");
  }
  if (added.length > 0 && signIn === "LINK" && signInLink && !input.signInLink) {
    throw new OperationError(400, "invalid_input", "Enter the sign-in link again to add another domain: the browser can go there with it");
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
    otherDomains: input.otherDomains ? [...new Set(input.otherDomains)] : (saved?.otherDomains ?? []),
    // Found per address: another address's are found again, none removed.
    skippedDomains: input.skippedDomains && sameAddress ? [...new Set(input.skippedDomains)] : sameAddress ? saved.skippedDomains : [],
  };
  await tx.screenshotSettings.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
}

const signInDomainsOutput = z
  .object({
    domains: z
      .array(
        z.object({
          host: z.string().describe("The host, allowed for your app's runs unless `skipped`").meta({ examples: ["identitytoolkit.googleapis.com"] }),
          provider: z.string().describe("The sign-in service it's for").meta({ examples: ["Firebase"] }),
          skipped: z.boolean().describe("Whether you removed it (skippedDomains): not allowed").meta({ examples: [false] }),
        }),
      )
      .describe("Each host found; empty when none is, the app's page couldn't be read, or it hasn't been read yet"),
    checking: z.boolean().describe("Whether the app is being read now: ask again in a few seconds for the answer").meta({ examples: [false] }),
  })
  .meta({ id: "ScreenshotSignInDomains", description: "Hosts your app's sign-in needs, found in its code and allowed for its runs" });

/** An answer older than this is read again: the app may sign in through another service now. */
const CHECK_AGAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** A read started longer ago than this is taken for lost: its job waits up to 2 minutes for the worker, then takes 15 seconds. */
const SCAN_STALE_MS = 3 * 60 * 1000;
/**
 * How much longer a lost read still says checking to polls: as long again, so a page that began asking just before it
 * was taken for lost (another tab's read) has all its asks (the screen's CHECK_FOR_MS, the same), and a minute for the
 * asks' own time.
 */
const POLL_GRACE_MS = SCAN_STALE_MS + 60 * 1000;

/**
 * The hosts of the hosted sign-in services the app calls (@tuti/jobs sign-in-hosts.ts), allowed for its runs (foundDomains).
 * Reading the app's page and scripts takes seconds, so the worker does it (the screenshot-sign-in-scan job),
 * once per app address and week (kept on the settings); a look meanwhile says it's checking. Only `start`
 * (screenshotSettings.scan) starts a read; a look (screenshotSettings.signInDomains, the screen's polls) never does: one
 * that ended without an answer (a script didn't load) ends the waiting.
 */
async function signInDomains(context: { actor: Actor; projectId: string }, start: boolean): Promise<z.infer<typeof signInDomainsOutput>> {
  const { projectId } = context;
  const settings = await prisma.screenshotSettings.findUnique({
    where: { projectId },
    select: { appUrl: true, skippedDomains: true, signInServices: true, signInServicesFor: true, signInServicesAt: true, signInScanFor: true, signInScanAt: true },
  });
  if (!settings?.appUrl) {
    return { domains: [], checking: false };
  }
  const key = scannedFor(settings.appUrl);
  const now = Date.now();
  // A full answer, or what a read that wasn't complete found (no time, so read again).
  const kept = settings.signInServicesFor === key || settings.signInServicesFor === partlyScannedFor(settings.appUrl) ? settings.signInServices : null;
  // One kept before answers had a time (until 2026-11) is read again too.
  const fresh = kept !== null && settings.signInServicesAt !== null && now - settings.signInServicesAt.getTime() < CHECK_AGAIN_MS;
  // A read claimed: still checking while it may run. One taken for lost (never run, or the worker restarted) still is
  // for polls a while longer while there's no answer, so the page's last ones (it asks for SCAN_STALE_MS) never read
  // as nothing found; then not, so an API client polling stops. A look starts another.
  const age = settings.signInScanFor === key && settings.signInScanAt !== null ? now - settings.signInScanAt.getTime() : Infinity;
  let checking = !fresh && (age < SCAN_STALE_MS || (!start && kept === null && age < SCAN_STALE_MS + POLL_GRACE_MS));
  if (!fresh && !checking && start) {
    checking = await startScan(context, settings.appUrl, kept !== null);
  }
  // Those removed too, said so: typed again, one comes back as found.
  return { domains: foundDomains({ ...settings, skippedDomains: [] }).map((one) => ({ ...one, skipped: settings.skippedDomains.includes(one.host) })), checking };
}

/**
 * Starts the read of the app at `appUrl`, unless one for it started meanwhile; whether one is running. Each makes our
 * server fetch and scan an address the team picks: limited as fetching an API reference is, though a kept answer (one
 * being read again) is shown rather than refused.
 */
async function startScan(context: { actor: Actor; projectId: string }, appUrl: string, keptAnswer: boolean): Promise<boolean> {
  const { projectId } = context;
  try {
    await countSpecFetch(context);
  } catch (error) {
    if (keptAnswer && error instanceof OperationError && error.status === 429) {
      return false;
    }
    throw error;
  }
  const key = scannedFor(appUrl);
  // Claimed in one statement, so of looks at once only one starts it; only while the address is still this one.
  const claimedAt = new Date();
  const { count } = await prisma.screenshotSettings.updateMany({
    where: { projectId, appUrl, OR: [{ signInScanFor: null }, { signInScanFor: { not: key } }, { signInScanAt: null }, { signInScanAt: { lt: new Date(Date.now() - SCAN_STALE_MS) } }] },
    data: { signInScanFor: key, signInScanAt: claimedAt },
  });
  if (count === 0) {
    return true;
  }
  try {
    await enqueue("screenshotSignInScan", { projectId, appUrl, claimedAt: claimedAt.toISOString() });
  } catch (error) {
    await prisma.screenshotSettings.updateMany({ where: { projectId, signInScanFor: key, signInScanAt: claimedAt }, data: { signInScanFor: null, signInScanAt: null } });
    throw error;
  }
  return true;
}

export const getScreenshotSignInDomains = defineOperation({
  name: "screenshotSettings.signInDomains",
  title: "Get screenshot sign-in domains",
  summary:
    "Hosts of the sign-in services your app calls (Firebase, Auth0, Supabase, Okta, Amazon Cognito, Clerk, Stytch, WorkOS), found in its code and allowed for its runs; remove one with screenshotSettings.update's `skippedDomains`. Read in the background (screenshotSettings.scan); ask while `checking`.",
  method: "GET",
  path: "/screenshots/settings/sign-in-domains",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: signInDomainsOutput.describe("The sign-in domains found"),
  run: async (context) => signInDomains(context, false),
});

export const scanScreenshotSignInDomains = defineOperation({
  name: "screenshotSettings.scan",
  title: "Scan for sign-in domains",
  summary:
    "Start reading your app for the sign-in services it calls, unless its answer is from the last week or a read is under way; returns what's known. Read in the background: ask screenshotSettings.signInDomains while `checking`. Each read counts against the hourly limit for reading an API reference.",
  method: "POST",
  path: "/screenshots/settings/scan",
  scope: "write",
  access: "admin",
  input: z.object({}),
  output: signInDomainsOutput.describe("The sign-in domains found so far"),
  errors: [429],
  run: async (context) => signInDomains(context, true),
});

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

const startedBy = (actor: Actor) => actingUserId(actor);

/**
 * Starts a run, or finds the one running: one at a time per project (and one Test), as each holds a worker slot for
 * minutes and spends up to the cost cap. A Test returns the one running; screenshots.take refuses (409).
 */
async function start(projectId: string, actor: Actor, shots: { show: string }[], test: boolean, target?: LinesOf) {
  const started = await startScreenshots(projectId, shots, { startedById: startedBy(actor), test, ...target }).catch(() => {
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
            .refine((show) => !hasHiddenCharacters(show), { error: `A screenshot's description ${HIDDEN_CHARACTERS}` })
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

/** What `shots` is in the operations that fill a text's lines: what the admin read and confirmed. */
const linesInput = (where: string) =>
  z
    .array(
      z.object({
        show: z
          .string()
          .trim()
          .min(1, "Say what each screenshot shows")
          .max(MAX_SHOW, `Keep each screenshot line under ${MAX_SHOW} characters`)
          // What the admin confirmed must be all the agent reads.
          .refine((show) => !hasHiddenCharacters(show), { error: (issue) => `“[Screenshot: ${String(issue.input).slice(0, 80)}]” ${HIDDEN_CHARACTERS}` })
          .describe(`A line's text, between "[Screenshot:" and "]", as it is in the ${where}`),
      }),
    )
    .min(1, "Pick a line to take")
    .max(MAX_SHOTS, `Take up to ${MAX_SHOTS} screenshots at a time`)
    .describe(`The lines to take, as you read them in the ${where}: only these are sent to the agent, and each must still be one of its "[Screenshot: …]" lines (a 409 otherwise)`);

/** Where a run's screenshots go once it's done: a changelog entry's lines, or an article's. */
type LinesOf = { changelogEntryId: string } | { articleId: string };

/**
 * Starts a run for a text's "[Screenshot: …]" lines: only lines the caller confirmed, each one of the text's own, one
 * for one, so what the agent is asked is what was read, never a line added since (by a member, or a draft written from
 * outside text).
 */
async function takeLines(projectId: string, actor: Actor, doc: Doc, shots: { show: string }[], target: LinesOf, what: "entry" | "article") {
  await refuseRun(projectId);
  const left = screenshotsAsked(doc);
  if (left.length === 0) {
    throw new OperationError(409, "no_markers", `This ${what} has no “[Screenshot: …]” lines to fill.`);
  }
  for (const { show } of shots) {
    const at = left.indexOf(show);
    if (at === -1) {
      throw new OperationError(409, "changed", `“[Screenshot: ${show.slice(0, 80)}${show.length > 80 ? "…" : ""}]” isn't in the ${what}'s saved text any more. Look at its lines again.`);
    }
    left.splice(at, 1);
  }
  return start(projectId, actor, shots, false, target);
}

export const takeChangelogScreenshots = defineOperation({
  name: "changelog.takeScreenshots",
  title: "Fill screenshot lines",
  summary: `Take screenshots for the entry's "[Screenshot: …]" lines you confirm (\`shots\`, up to ${MAX_SHOTS}, each still in its saved text), in the background (screenshots.get reads the run). Each one taken replaces its line if still there as it was; one not taken stays. Costs credits where used`,
  method: "POST",
  path: "/changelog/{number}/screenshots",
  scope: "write",
  // As screenshots.take: what's asked for goes into the agent's task beside the sign-in.
  access: "admin",
  errors: [402, 404, 409, 503],
  input: z.object({
    number: z.coerce.number().int().positive().describe("The entry's number in the project").meta({ examples: [7] }),
    shots: linesInput("entry"),
  }),
  output: runOutput.describe("The run, running"),
  example: { shots: [{ show: "The billing page with the invoices list" }] },
  run: async ({ actor, projectId }, { number, shots }) => {
    const entry = await prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { id: true, content: true, body: true } });
    if (!entry) {
      throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
    }
    return takeLines(projectId, actor, displayDoc(entry), shots, { changelogEntryId: entry.id }, "entry");
  },
});

/** An article's text as last saved: a published one's unpublished changes if it has some, else its own. */
const savedText = (article: { body: string; content: unknown; changes: { body: string; content: unknown } | null }) => displayDoc(article.changes ?? article);

export const takeArticleScreenshots = defineOperation({
  name: "articles.takeScreenshots",
  title: "Fill article screenshot lines",
  summary: `Take screenshots for a docs article's "[Screenshot: …]" lines you confirm (\`shots\`, up to ${MAX_SHOTS}), in the background (screenshots.get reads the run). Each one taken replaces its line as a new version; one not taken stays, and the article can't be published while it does. Costs credits where used`,
  method: "POST",
  path: "/articles/{slug}/screenshots",
  scope: "write",
  // As screenshots.take: what's asked for goes into the agent's task beside the sign-in.
  access: "admin",
  errors: [402, 404, 409, 503],
  input: z.object({
    slug: z.string().trim().min(1).max(200).describe("The article's slug").meta({ examples: ["invite-your-team"] }),
    shots: linesInput("article"),
  }),
  output: runOutput.describe("The run, running"),
  example: { shots: [{ show: "Settings → Team with the Invite dialog open" }] },
  run: async ({ actor, projectId }, { slug, shots }) => {
    const article = await prisma.article.findFirst({
      where: { projectId, slug, deletedAt: null },
      select: { id: true, body: true, content: true, changes: { select: { body: true, content: true } } },
    });
    if (!article) {
      throw new OperationError(404, "not_found", `There's no article “${slug}”`);
    }
    return takeLines(projectId, actor, savedText(article), shots, { articleId: article.id }, "article");
  },
});

/** Shots whose cost the estimate averages: the project's latest. */
const ESTIMATE_SHOTS = 20;

/**
 * What an editor shows of a text's screenshots (a changelog entry's, an article's): how many of its lines ask for one,
 * whether they can be taken (null: not on this server, or not set up), the text's latest run while it runs, the lines
 * it didn't take that are still there with why, and what taking them would cost in credits, from recent screenshots
 * (with credits on; null when none has been priced yet). `doc` is its text as saved; `savedAt` which version that is.
 */
export async function lineScreenshots(projectId: string, target: LinesOf, doc: Doc, savedAt: string) {
  const latest = await prisma.screenshotRun.findFirst({ where: target, orderBy: { createdAt: "desc" }, select: { id: true, state: true, placedAt: true } });
  // Going until its screenshots are placed, as screenshotsRunning says: one ended a moment before its job places
  // them still has the editor asking.
  const going = latest !== null && (latest.state === "RUNNING" || !latest.placedAt);
  if (latest?.state === "RUNNING") {
    await settleStaleScreenshotRuns(projectId);
  }
  const asked = screenshotsAsked(doc);
  const setUp = Boolean(await prisma.screenshotSettings.count({ where: { projectId } }));
  const run =
    latest &&
    (await prisma.screenshotRun.findUniqueOrThrow({
      where: { id: latest.id },
      select: { state: true, screenshots: { orderBy: { position: "asc" }, select: { show: true, failed: true, imageId: true } } },
    }));
  const left = [...asked];
  const failed =
    run && !going
      ? run.screenshots.flatMap(({ show, failed, imageId }) => {
          const at = imageId ? -1 : left.indexOf(show);
          return at === -1 ? [] : (left.splice(at, 1), [{ show, reason: failed || "Not taken." }]);
        })
      : [];
  const priced = creditsEnabled()
    ? await prisma.screenshot.findMany({ where: { projectId, cost: { not: null }, run: { test: false } }, orderBy: { createdAt: "desc" }, take: ESTIMATE_SHOTS, select: { cost: true } })
    : [];
  return {
    // Which saved version the text shown is: a run that ends without changing it changed nothing in the form.
    savedAt,
    asked: asked.length,
    // The lines, for Take screenshots to list before it sends them (the first MAX_SHOTS).
    lines: asked.slice(0, MAX_SHOTS),
    available: screenshotsAvailable() && setUp ? true : screenshotsAvailable() ? ("not_set_up" as const) : false,
    running: run && going ? run.screenshots.length : null,
    // A run for it ended: the section stays (focus goes to it after one), saying when every line is filled.
    ran: Boolean(run && !going),
    failed,
    // ponytail: the average shot's cost; a run's own sign-in, shared by its shots, makes a lone one cost more.
    estimate: priced.length ? (priced.reduce((sum, shot) => sum + shot.cost!.toNumber(), 0) / priced.length) * creditsPerUsageDollar() * Math.min(asked.length, MAX_SHOTS) : null,
    credits: creditsEnabled(),
  };
}

export type LineScreenshots = Awaited<ReturnType<typeof lineScreenshots>>;

/** A changelog entry's (lineScreenshots): `savedAt` when it was saved, which its save sends back (`screenshotsSince`). */
export const entryScreenshots = (projectId: string, entry: { id: string; content: unknown; body: string; updatedAt: Date }) =>
  lineScreenshots(projectId, { changelogEntryId: entry.id }, displayDoc(entry), entry.updatedAt.toISOString());

/** An article's (lineScreenshots), as last saved: `savedAt` its newest version's id (the editor's own checks use it). */
export const articleScreenshots = (projectId: string, article: { id: string; body: string; content: unknown; changes: { body: string; content: unknown } | null }, revision: string | null) =>
  lineScreenshots(projectId, { articleId: article.id }, savedText(article), revision ?? "");

export const SCREENSHOTS_PLACED =
  "Screenshots went into the saved text since you opened this entry. Reload the page to see them: saving now would put the lines back in place of them.";

/**
 * Places the text's latest run's screenshots if it ended without (its job an older worker's, during a deploy, or one
 * that died): the editor does it before reading the text. Whether it placed any.
 */
export async function placeLeftoverScreenshots(target: LinesOf | Prisma.ScreenshotRunWhereInput): Promise<boolean> {
  const latest = await prisma.screenshotRun.findFirst({ where: target, orderBy: { createdAt: "desc" }, select: { id: true, state: true, placedAt: true } });
  return Boolean(latest && latest.state !== "RUNNING" && !latest.placedAt && (await placeScreenshots(latest.id)) > 0);
}

/**
 * Whether a text's latest screenshot run is still going (a stopped one settled first), and which version of it is
 * saved: the editor asks while one runs. Going until its screenshots are placed, not only until it ends: its job places
 * them a moment after, and the editor reads `savedAt` to know whether they changed the saved text. One that ended
 * without (an older worker's, a job that died) is placed here, as on opening the editor.
 */
async function screenshotsRunning(projectId: string, target: LinesOf | null, saved: () => Promise<string | null>) {
  await settleStaleScreenshotRuns(projectId);
  if (!target) {
    return { running: false, savedAt: null };
  }
  const latest = () => prisma.screenshotRun.findFirst({ where: target, orderBy: { createdAt: "desc" }, select: { state: true, placedAt: true } });
  let run = await latest();
  if (run && run.state !== "RUNNING" && !run.placedAt) {
    await placeLeftoverScreenshots(target);
    run = await latest();
  }
  return { running: run?.state === "RUNNING" || (run !== null && !run.placedAt), savedAt: await saved() };
}

/** A changelog entry's (screenshotsRunning): `savedAt` when it was last saved. */
export async function entryScreenshotsRunning(projectId: string, number: number) {
  const entry = await prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { id: true } });
  return screenshotsRunning(projectId, entry && { changelogEntryId: entry.id }, async () =>
    entry ? ((await prisma.changelogEntry.findUnique({ where: { id: entry.id }, select: { updatedAt: true } }))?.updatedAt.toISOString() ?? null) : null,
  );
}

/** An article's (screenshotsRunning): `savedAt` its newest version's id. Null when it's gone (deleted since): nothing more to ask. */
export async function articleScreenshotsRunning(projectId: string, slug: string) {
  const article = await prisma.article.findFirst({ where: { projectId, slug, deletedAt: null }, select: { id: true } });
  if (!article) {
    return null;
  }
  return screenshotsRunning(projectId, { articleId: article.id }, async () =>
    (await prisma.articleRevision.findFirst({ where: { articleId: article.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }))?.id ?? null,
  );
}
