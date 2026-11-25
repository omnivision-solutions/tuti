import { prisma } from "@tuti/db";
import { creditBalance, grantCredits, handlers, takeScreenshots as takeScreenshotRun, withoutLink } from "@tuti/jobs";
import { type BrowserUseFake, configFile, creditsOn, type S3Fake, startBrowserUseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { call } from "@/server/operations/run";
import { getScreenshots, getScreenshotSettings, takeScreenshots, testScreenshotSettings, updateScreenshotSettings } from "@/server/operations/screenshots";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Screenshots (docs/plan.md): the settings, and runs of the agent (Browser Use's fake) through the operations, jobs inline. */

let browserUse: BrowserUseFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

const PASSWORD = "correct-horse-battery";
const LINK = "https://app.example.com/magic?token=secret-token-123";

beforeAll(async () => {
  browserUse = await startBrowserUseFake();
  s3 = await startS3Fake();
});
afterAll(async () => {
  // Every run this file started said whether to use Browser Use's residential proxy, off unless a test turned it on (the
  // fake refuses one that doesn't say, too).
  expect(browserUse.runs.length).toBeGreaterThan(0);
  for (const run of browserUse.runs) {
    expect(run.body.browserSettings).toHaveProperty("proxyCountryCode");
    expect([null, "us"]).toContain((run.body.browserSettings as { proxyCountryCode: unknown }).proxyCountryCode);
  }
  expect(browserUse.runs.filter((run) => (run.body.browserSettings as { proxyCountryCode: unknown }).proxyCountryCode === "us")).toHaveLength(1);
  await Promise.all([browserUse.close(), s3.close()]);
});

beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...browserUse.env, ...s3.env })) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const setUp = (input: Parameters<typeof updateScreenshotSettings.run>[1] = {}) =>
  call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com/home", signIn: "password", username: "e2e-demo@example.com", password: PASSWORD, ...input });
/** The run's session's browser, by the fake's latest run. */
const lastBrowser = () => browserUse.browsers.get(browserUse.runs.at(-1)!.sessionId)!;

test("settings keep the password and sign-in link sealed, never return them, and forget the one not in use", async () => {
  const saved = await setUp({ about: "Pick the Acme workspace.", window: "phone" });
  expect(saved).toMatchObject({ available: true, appUrl: "https://app.example.com/home", signIn: "password", username: "e2e-demo@example.com", passwordSet: true, signInLinkSet: false, about: "Pick the Acme workspace.", window: "phone", test: null });
  const row = await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } });
  expect(row.password).not.toContain(PASSWORD);
  expect(JSON.stringify(await call(getScreenshotSettings, as(), {}))).not.toContain(PASSWORD);
  // Saved again without it: kept.
  expect(await call(updateScreenshotSettings, as(), { password: "", about: "Close the tour." })).toMatchObject({ passwordSet: true, about: "Close the tour." });
  // A link instead: the password and username are forgotten.
  const link = await call(updateScreenshotSettings, as(), { signIn: "link", signInLink: LINK });
  expect(link).toMatchObject({ signIn: "link", username: "", passwordSet: false, signInLinkSet: true });
  expect(JSON.stringify(link)).not.toContain("secret-token-123");
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).password).toBeNull();
  // An empty address is refused, nothing lost.
  await expect(call(updateScreenshotSettings, as(), { appUrl: "" })).rejects.toMatchObject({ status: 400 });
  expect(await call(getScreenshotSettings, as(), {})).toMatchObject({ signInLinkSet: true });
});

test("moving the app to another host forgets the saved password and link, so they're never given to it", async () => {
  await setUp();
  // The same host keeps it.
  expect(await call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com/other" })).toMatchObject({ passwordSet: true });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "https://evil.example.net" })).rejects.toMatchObject({
    status: 400,
    message: "Enter the password again: the app's address moved to another site",
  });
  expect(await call(getScreenshotSettings, as(), {})).toMatchObject({ appUrl: "https://app.example.com/other", passwordSet: true });
  // With a new one, it moves, and the agent gets only that one, bound to the new host.
  expect(await call(updateScreenshotSettings, as(), { appUrl: "https://demo.example.net", password: "a-new-password" })).toMatchObject({ passwordSet: true });
  await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(browserUse.runs.at(-1)!.body.secretBindings).toEqual([{ alias: "app_password", source: { type: "inline", value: "a-new-password" }, allowedDomains: ["demo.example.net"] }]);
  // A link too.
  await call(updateScreenshotSettings, as(), { signIn: "link", signInLink: LINK, appUrl: "https://app.example.com" });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "https://evil.example.net" })).rejects.toMatchObject({ message: "Enter the sign-in link again: the app's address moved to another site" });
  // Another scheme or port on the same host is another site too.
  await expect(call(updateScreenshotSettings, as(), { appUrl: "http://app.example.com" })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com:8443" })).rejects.toMatchObject({ status: 400 });
});

test("an answer without whether it signed in, or with a screenshot not plainly reached, isn't taken as a yes", async () => {
  await setUp();
  browserUse.next({ output: { shots: [] } }, { output: { shots: [] } });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", error: "The agent's answer couldn't be read. Try again." });
  browserUse.next({ output: { signedIn: true, shots: [{ file: "shot-1.png", reached: "yes", description: "Maybe" }] } });
  expect((await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).screenshots).toMatchObject([{ state: "failed", image: null }]);
});

test("a try whose cost couldn't be read isn't retried: what's left of the budget isn't known", async () => {
  await setUp();
  const before = browserUse.runs.length;
  browserUse.next({ status: "failed", error: "Max steps reached", costStatus: 500 });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", cost: null });
  expect(browserUse.runs).toHaveLength(before + 1);
  // Its browser was still stopped.
  expect(lastBrowser().status).toBe("stopped");
  // The session stays on the run, unclaimed.
  expect(await prisma.screenshotRun.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, select: { sessionId: true } })).toEqual({ sessionId: browserUse.runs.at(-1)!.sessionId });
  // A total that isn't a number is the same.
  browserUse.next({ status: "failed", error: "Max steps reached", cost: { totalCostUsd: "n/a" } });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", cost: null });
  expect(browserUse.runs).toHaveLength(before + 2);
});

test("settings are refused without what their sign-in needs", async () => {
  await expect(call(updateScreenshotSettings, as(), { signIn: "none" })).rejects.toMatchObject({ status: 400, message: "Enter your app's address" });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com", signIn: "password", username: "demo" })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com", signIn: "link" })).rejects.toMatchObject({ message: "Enter the sign-in link" });
  await expect(call(updateScreenshotSettings, as(), { appUrl: "ftp://app.example.com" })).rejects.toMatchObject({ status: 400 });
});

test("a run signs in once, takes every screenshot as an upload, stops its browser, and charges the session's whole cost", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await setUp({ about: "Close the welcome tour." });
  const started = await call(takeScreenshots, as(), { shots: [{ show: "The billing page" }, { show: "Settings → Team" }] });
  const run = await call(getScreenshots, as(), { id: started.id });
  expect(run).toMatchObject({ state: "done", test: false, error: null, cost: 0.0419 });
  expect(run.screenshots).toMatchObject([
    { show: "The billing page", state: "taken", width: 144, height: 90, description: "The screen: The billing page", url: "https://app.example.com/dashboard", failed: null, image: { width: 144, height: 90 } },
    { show: "Settings → Team", state: "taken", image: { width: 144, height: 90 } },
  ]);
  const media = await prisma.media.findUniqueOrThrow({ where: { id: run.screenshots[0]!.image!.id } });
  expect(media).toMatchObject({ projectId: project.id, uploaderId: owner.id, status: "READY" });

  // What the agent was told: the app, the username, the password by its alias only (bound to the app's hostname), the
  // team's notes, the rules, and each screenshot's file.
  const sent = browserUse.runs.at(-1)!.body;
  expect(sent).toMatchObject({
    model: "bu-4.0-mini",
    maxCostUsd: 1,
    browserSettings: { screenWidth: 1440, screenHeight: 900, proxyCountryCode: null },
    secretBindings: [{ alias: "app_password", source: { type: "inline", value: PASSWORD }, allowedDomains: ["app.example.com"] }],
  });
  expect(sent.task).toContain("Open https://app.example.com/home.");
  expect(sent.task).toContain('the username "e2e-demo@example.com" and the password app_password');
  expect(sent.task).not.toContain(PASSWORD);
  expect(sent.task).toContain("Close the welcome tour.");
  expect(sent.task).toContain("Never delete, submit, send");
  expect(sent.task).toContain("fully loaded");
  expect(sent.task).toContain("Do not resize the window or set a custom clip");
  expect(sent.task).toContain("shot-1.png: The billing page\nshot-2.png: Settings → Team");

  // Nothing left at Browser Use: the agent's files deleted once downloaded, after its browser stopped (so it can't save
  // more after them) and its cost read.
  const { sessionId: session, workspaceId: workspace } = browserUse.runs.at(-1)!;
  expect([...browserUse.files.get(workspace)!.keys()]).toEqual([]);
  const order = browserUse.events.filter((event) => event.endsWith(session) || event.endsWith(workspace));
  expect(order.slice(0, 2)).toEqual([`stop ${session}`, `cost ${session}`]);
  expect(order.slice(2).every((event) => event === `delete ${workspace}`)).toBe(true);
  expect(order.length).toBeGreaterThan(2);
  // The browser stopped, then the session's cost (browser and proxy too, not only the model's) recorded and charged.
  expect(lastBrowser().status).toBe("stopped");
  const usage = await prisma.aiUsage.findMany({ where: { projectId: project.id } });
  expect(usage).toMatchObject([{ feature: "screenshots", kind: "agent", model: "bu-4.0-mini", inputTokens: 12000, outputTokens: 800 }]);
  expect(usage[0]!.cost!.toNumber()).toBe(0.0419);
  expect(usage[0]!.credits!.toNumber()).toBeCloseTo(4.19, 6);
  expect((await creditBalance(project.id)).balance).toBeCloseTo(10 - 4.19, 6);
  expect(await prisma.screenshotRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ state: "DONE" });
  const stored = await prisma.screenshotRun.findUniqueOrThrow({ where: { id: run.id }, select: { browserCost: true, proxyCost: true, llmCost: true } });
  expect([stored.browserCost?.toNumber(), stored.proxyCost?.toNumber(), stored.llmCost?.toNumber()]).toEqual([0.005, 0.0061, 0.0308]);
});

test("a screenshot the agent couldn't reach says why; the others are kept", async () => {
  await setUp({ window: "phone" });
  browserUse.next({ unreached: { "shot-2.png": "There's no Reports page in the menu." } });
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }, { show: "The reports page" }] });
  expect(run.state).toBe("done");
  expect(run.screenshots).toMatchObject([
    { state: "taken", failed: null },
    { state: "failed", image: null, failed: "There's no Reports page in the menu." },
  ]);
  expect(browserUse.runs.at(-1)!.body.browserSettings).toEqual({ screenWidth: 390, screenHeight: 844, proxyCountryCode: null });
  expect(lastBrowser().status).toBe("stopped");
  expect(browserUse.files.get(browserUse.runs.at(-1)!.workspaceId)!.size).toBe(0);
});

test("a run that can't sign in fails saying so, stops its browser and is still charged", async () => {
  await setUp();
  browserUse.next({ signInFailed: "The password was refused." });
  const before = browserUse.runs.length;
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(run).toMatchObject({ state: "failed", error: "The agent couldn't sign in: The password was refused.", cost: 0.0419 });
  expect(run.screenshots).toMatchObject([{ state: "failed", failed: run.error }]);
  // Not tried again: the same password would be refused again.
  expect(browserUse.runs).toHaveLength(before + 1);
  expect(lastBrowser().status).toBe("stopped");
  expect(await prisma.aiUsage.count({ where: { projectId: project.id, feature: "screenshots" } })).toBe(1);
});

test("a retry gets only what's left of the run's budget, and none when the first try spent it", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ screenshots: { maxCostUsd: 0.5 } }));
  await setUp({ signIn: "none" });
  const before = browserUse.runs.length;
  browserUse.next({ status: "failed", error: "Cost limit reached", cost: { totalCostUsd: "0.350000" } });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "done", cost: 0.3919 });
  expect(browserUse.runs.slice(before).map((one) => one.body.maxCostUsd)).toEqual([0.5, 0.15]);
  browserUse.next({ status: "failed", error: "Cost limit reached", cost: { totalCostUsd: "0.500000" } });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", error: "The agent stopped: Cost limit reached", cost: 0.5 });
  expect(browserUse.runs).toHaveLength(before + 3);
});

test("one run at a time per project: another is refused while one runs, starts at once make one", { timeout: 60_000 }, async () => {
  await setUp();
  const running = await prisma.screenshotRun.create({ data: { projectId: project.id, startedById: owner.id } });
  await expect(call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).rejects.toMatchObject({ status: 409, code: "busy" });
  await prisma.screenshotRun.delete({ where: { id: running.id } });
  // Five at once, the agent taking a while (its job runs inline, inside the call that started it): the project's lock
  // lets one start. Real timers, and each step waited for, not timed: the job polls every 5 seconds once released.
  browserUse.next({ stuck: true });
  const before = browserUse.runs.length;
  const outcomes: string[] = [];
  const all = Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      call(takeScreenshots, as(), { shots: [{ show: `Shot ${i}` }] }).then(
        () => outcomes.push("started"),
        (error: { status?: number; code?: string; message?: string }) => outcomes.push(error.status === 409 ? error.code! : `${error.status ?? ""} ${error.message}`),
      ),
    ),
  );
  // The other four refused while the first one's agent is still running; only then is it let finish.
  await vi.waitFor(() => expect(outcomes).toEqual(["busy", "busy", "busy", "busy"]), { timeout: 30_000, interval: 100 });
  expect(browserUse.runs).toHaveLength(before + 1);
  browserUse.release();
  await all;
  expect(outcomes).toEqual(["busy", "busy", "busy", "busy", "started"]);
  expect(browserUse.runs).toHaveLength(before + 1);
  expect(await prisma.screenshotRun.count({ where: { projectId: project.id } })).toBe(1);
});

test("a run whose job died with the agent running has its browser stopped and its session charged when it's settled", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await setUp();
  // The agent started (the fake's session, its browser active), then the job died.
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  const { sessionId } = browserUse.runs.at(-1)!;
  browserUse.browsers.get(sessionId)!.status = "active";
  await prisma.aiUsage.deleteMany({ where: { projectId: project.id } });
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const died = await prisma.screenshotRun.create({ data: { projectId: project.id, startedById: owner.id, createdAt: hourAgo, startedAt: hourAgo, sessionId } });
  expect(run.state).toBe("done");
  // The agent saved more than a listing gives (100) before the job died.
  const workspaceId = browserUse.runs.at(-1)!.workspaceId;
  for (let i = 0; i < 150; i++) {
    browserUse.files.get(workspaceId)!.set(`outputs/extra-${i}.png`, new Uint8Array([1]));
  }
  await prisma.screenshotRun.update({ where: { id: died.id }, data: { workspaceId } });
  expect(await call(getScreenshots, as(), { id: died.id })).toMatchObject({ state: "failed", cost: 0.0419 });
  expect(browserUse.browsers.get(sessionId)!.status).toBe("stopped");
  // Every one of its files deleted at Browser Use.
  expect(browserUse.files.get(workspaceId)!.size).toBe(0);
  expect(await prisma.screenshotRun.findUniqueOrThrow({ where: { id: died.id }, select: { workspaceId: true } })).toEqual({ workspaceId: null });
  expect((await prisma.aiUsage.findMany({ where: { projectId: project.id } })).map((usage) => usage.cost!.toNumber())).toEqual([0.0419]);
  // Read again: settled once, charged once.
  await call(getScreenshots, as(), { id: died.id });
  expect(await prisma.aiUsage.count({ where: { projectId: project.id } })).toBe(1);
});

test("a try's files are deleted even when its charge fails in the database, and a failed cost write doesn't stop the run", async () => {
  await setUp();
  // The cost read, then adding it to the run fails: logged, the run goes on, and its files are still deleted.
  const findUniqueOrThrow = prisma.screenshotRun.findUniqueOrThrow.bind(prisma.screenshotRun);
  const costWrite = vi.spyOn(prisma.screenshotRun, "findUniqueOrThrow").mockImplementation(((args: { select?: { llmCost?: boolean } }) =>
    args.select?.llmCost ? Promise.reject(new Error("The database went away")) : findUniqueOrThrow(args as never)) as never);
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  costWrite.mockRestore();
  // Charged (its usage recorded), only not added to the run's cost.
  expect(run).toMatchObject({ state: "done", cost: null, screenshots: [{ state: "taken" }] });
  expect((await prisma.aiUsage.findMany({ where: { projectId: project.id } })).map((usage) => usage.cost!.toNumber())).toEqual([0.0419]);
  expect(browserUse.files.get(browserUse.runs.at(-1)!.workspaceId)!.size).toBe(0);
  // The claim itself fails: the error ends the job, but the try's files are deleted first.
  const updateMany = prisma.screenshotRun.updateMany.bind(prisma.screenshotRun);
  const claim = vi.spyOn(prisma.screenshotRun, "updateMany").mockImplementation(((args: { data?: { sessionId?: null } }) =>
    args.data && "sessionId" in args.data ? Promise.reject(new Error("The database went away")) : updateMany(args as never)) as never);
  await expect(call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).rejects.toThrow();
  claim.mockRestore();
  expect(browserUse.files.get(browserUse.runs.at(-1)!.workspaceId)!.size).toBe(0);
});

test("each try's cost is on the run as it's charged; one charged isn't charged again when the run is settled", { timeout: 60_000 }, async () => {
  await setUp();
  // A first try that fails ($0.02), and a second whose job dies mid-run (its agent still going).
  browserUse.next({ status: "failed", error: "Max steps reached", cost: { totalCostUsd: "0.020000" } }, { stuck: true });
  const taking = call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] }).catch(() => null);
  await vi.waitFor(async () => {
    const run = await prisma.screenshotRun.findFirstOrThrow({ where: { projectId: project.id }, select: { cost: true, sessionId: true } });
    expect(run.cost?.toNumber()).toBe(0.02);
    // The second try's session, not charged yet.
    expect(run.sessionId).toBe(browserUse.runs.at(-1)!.sessionId);
  }, { timeout: 30_000, interval: 100 });
  // Its job "died": the run is past the stale limit.
  const { id } = await prisma.screenshotRun.findFirstOrThrow({ where: { projectId: project.id } });
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  await prisma.screenshotRun.update({ where: { id }, data: { createdAt: hourAgo, startedAt: hourAgo } });
  expect(await call(getScreenshots, as(), { id })).toMatchObject({ state: "failed", cost: 0.0619 });
  expect((await prisma.aiUsage.findMany({ where: { projectId: project.id } })).map((usage) => usage.cost!.toNumber()).sort()).toEqual([0.02, 0.0419]);
  // Released, the job polls again within 5 seconds and ends.
  browserUse.release();
  await taking;
  // The job, finding its session charged, charged nothing more, and the run stays settled.
  expect(await prisma.aiUsage.count({ where: { projectId: project.id } })).toBe(2);
  expect(await call(getScreenshots, as(), { id })).toMatchObject({ state: "failed", cost: 0.0619 });
});

test("with the same model for both, a failed run is still tried twice", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ screenshots: { model: "bu-4.0", retryModel: "bu-4.0" } }));
  await setUp({ signIn: "none" });
  const before = browserUse.runs.length;
  browserUse.next({ status: "failed", error: "Max steps reached" });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "done" });
  expect(browserUse.runs.slice(before).map((one) => one.body.model)).toEqual(["bu-4.0", "bu-4.0"]);
});

test("a run that fails as a whole is tried once more on the retry model; both sessions are stopped and charged", async () => {
  vi.stubEnv("TUTI_CONFIG", configFile({ screenshots: { model: "bu-4.0-mini", retryModel: "bu-4.0", maxCostUsd: 0.5 } }));
  await setUp({ signIn: "none" });
  const before = browserUse.runs.length;
  browserUse.next({ status: "failed", error: "Max steps reached", cost: { totalCostUsd: "0.020000" } }, { cost: { totalCostUsd: "0.050000" } });
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(run).toMatchObject({ state: "done", cost: 0.07 });
  const tries = browserUse.runs.slice(before);
  expect(tries.map((one) => [one.body.model, one.body.maxCostUsd])).toEqual([
    ["bu-4.0-mini", 0.5],
    // What the first left of the budget.
    ["bu-4.0", 0.48],
  ]);
  // No sign-in: no secret.
  expect(tries[0]!.body).not.toHaveProperty("secretBindings");
  expect(tries[0]!.body.task).toContain("The app needs no sign-in.");
  expect(tries.map((one) => browserUse.browsers.get(one.sessionId)!.status)).toEqual(["stopped", "stopped"]);
  expect((await prisma.aiUsage.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } })).map((usage) => usage.cost!.toNumber()).sort()).toEqual([0.02, 0.05]);
});

test("a run whose answer can't be read, twice, fails; one Browser Use refuses fails without a session to stop", async () => {
  await setUp();
  browserUse.next({ output: "I took them, I think." }, { output: "Still not JSON." });
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", error: "The agent's answer couldn't be read. Try again." });
  expect(lastBrowser().status).toBe("stopped");
  // Its files deleted too, though nothing was kept.
  expect(browserUse.files.get(browserUse.runs.at(-1)!.workspaceId)!.size).toBe(0);
  browserUse.next({ createStatus: 500 }, { createStatus: 500 });
  const costsRead = browserUse.costsRead.length;
  expect(await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).toMatchObject({ state: "failed", error: "Browser Use didn't answer. Try again in a moment.", cost: null });
  expect(browserUse.costsRead).toHaveLength(costsRead);
});

test("the sign-in link goes in the task for the agent to open; the Test takes the screen it lands on", async () => {
  await setUp({ signIn: "link", signInLink: LINK });
  const run = await call(testScreenshotSettings, as(), {});
  expect(run).toMatchObject({ state: "done", test: true, screenshots: [{ state: "taken", show: expect.stringContaining("right after opening the app and signing in") }] });
  expect(browserUse.runs.at(-1)!.body.task).toContain(`open this sign-in link, which signs you in by itself: ${LINK}`);
  expect(browserUse.runs.at(-1)!.body).not.toHaveProperty("secretBindings");
  // The settings show the latest Test.
  expect((await call(getScreenshotSettings, as(), {})).test).toMatchObject({ id: run.id, state: "done" });
});

test("the sign-in link never comes back from what the agent says", async () => {
  await setUp({ signIn: "link", signInLink: LINK });
  browserUse.next({ output: { signedIn: true, shots: [{ file: "shot-1.png", reached: true, description: `Signed in through ${LINK}`, url: LINK }] } });
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(run.screenshots[0]).toMatchObject({ state: "taken", description: "Signed in through [sign-in link]" });
  expect(JSON.stringify(run)).not.toContain("secret-token-123");
  browserUse.next({ signInFailed: "The link secret-token-123 had expired." });
  const failed = await call(testScreenshotSettings, as(), {});
  expect(failed.error).toBe("The agent couldn't sign in: The link [sign-in link] had expired.");
  expect(browserUse.runs.at(-1)!.body.task).toContain("never repeat it");
});

test("only the link and the token-like parts of it are taken out, not ordinary words", () => {
  const link = "https://app.example.com/dashboard?token=secret-token-123";
  expect(withoutLink("The dashboard at https://app.example.com/dashboard, token secret-token-123", link)).toBe("The dashboard at https://app.example.com/dashboard, token [sign-in link]");
  expect(withoutLink(`Opened ${link}`, link)).toBe("Opened [sign-in link]");
  // A token of letters only, in the query, is a token too.
  expect(withoutLink("Used abcdefghijkl", "https://app.example.com/login?key=abcdefghijkl")).toBe("Used [sign-in link]");
  // An address in it (where it sends you after) isn't a token.
  const magic = "https://app.example.com/auth/v1/verify?token=abc123def456&type=magiclink&redirect_to=https://app.example.com/home";
  expect(withoutLink("Landed on https://app.example.com/home after abc123def456", magic)).toBe("Landed on https://app.example.com/home after [sign-in link]");
  // A token inside an address-like value is still found: a hash route's, a `next=` address's.
  expect(withoutLink("Token abc123def456", "https://app.example.com/#/verify?token=abc123def456")).toBe("Token [sign-in link]"); // gitleaks:allow
  expect(withoutLink("Code zyxwvutsrqpo", "https://app.example.com/login?next=/accept%3Fcode%3Dzyxwvutsrqpo")).toBe("Code [sign-in link]");
  // And one in a fragment of key=value pairs.
  expect(withoutLink("Used qwertyuiopas", "https://site.example.com/#recovery_token=qwertyuiopas&type=recovery")).toBe("Used [sign-in link]");
});

test("a screenshot's image is kept by the daily release of unused uploads, for as long as the screenshot is", async () => {
  await setUp();
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  const imageId = run.screenshots[0]!.image!.id;
  await prisma.media.update({ where: { id: imageId }, data: { attachedAt: new Date(Date.now() - 3 * 86_400_000) } });
  const log = { info: () => {}, warn: () => {} };
  await handlers.releaseMedia({}, log);
  expect((await prisma.media.findUniqueOrThrow({ where: { id: imageId } })).attachedAt).not.toBeNull();
  // The screenshot gone, its image is released.
  await prisma.screenshotRun.delete({ where: { id: run.id } });
  await handlers.releaseMedia({}, log);
  expect((await prisma.media.findUniqueOrThrow({ where: { id: imageId } })).attachedAt).toBeNull();
});

test("a Test already running is returned, not started again; a run's job delivered twice runs the agent once", async () => {
  await setUp();
  const running = await prisma.screenshotRun.create({
    data: { projectId: project.id, startedById: owner.id, test: true, screenshots: { create: { projectId: project.id, position: 0, show: "The landing screen" } } },
  });
  const before = browserUse.runs.length;
  expect(await call(testScreenshotSettings, as(), {})).toMatchObject({ id: running.id, state: "running" });
  expect(await prisma.screenshotRun.count({ where: { projectId: project.id } })).toBe(1);

  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(browserUse.runs).toHaveLength(before + 1);
  expect(await takeScreenshotRun(run.id)).toMatchObject([{ id: run.screenshots[0]!.id, imageId: run.screenshots[0]!.image!.id }]);
  expect(browserUse.runs).toHaveLength(before + 1);
});

test("runs are refused without a key or uploads, without settings, and out of credits; another project's run isn't found", async () => {
  vi.stubEnv("BROWSER_USE_API_KEY", "");
  expect(await call(getScreenshotSettings, as(), {})).toMatchObject({ available: false });
  await expect(call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("BROWSER_USE_API_KEY", browserUse.env.BROWSER_USE_API_KEY);
  await expect(call(testScreenshotSettings, as(), {})).rejects.toMatchObject({ status: 409 });
  await setUp();
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await expect(call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] })).rejects.toMatchObject({ status: 402 });
  expect(await prisma.screenshotRun.count({ where: { projectId: project.id } })).toBe(0);
  await expect(call(takeScreenshots, as(), { shots: [] })).rejects.toMatchObject({ status: 400 });

  vi.stubEnv("TUTI_CONFIG", "");
  const run = await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  const other = await createProject(owner);
  await expect(call(getScreenshots, { actor: as().actor, projectId: other.id }, { id: run.id })).rejects.toMatchObject({ status: 404 });
});

test("a run whose job stopped is settled as failed when it's read; one still queued waits a day", async () => {
  await setUp();
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const stuck = await prisma.screenshotRun.create({
    data: { projectId: project.id, startedById: owner.id, createdAt: hourAgo, startedAt: hourAgo, screenshots: { create: { projectId: project.id, position: 0, show: "The dashboard" } } },
  });
  const queued = await prisma.screenshotRun.create({ data: { projectId: project.id, startedById: owner.id, test: true, createdAt: new Date(Date.now() - 30 * 60_000) } });
  expect(await call(getScreenshots, as(), { id: stuck.id })).toMatchObject({ state: "failed", error: "It didn't finish. Try again.", screenshots: [{ state: "failed", failed: "It didn't finish. Try again." }] });
  expect(await call(getScreenshots, as(), { id: queued.id })).toMatchObject({ state: "running" });
  // Past the hour Hatchet waits for a worker, it was dropped: settled, and the Test can run again.
  await prisma.screenshotRun.update({ where: { id: queued.id }, data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
  expect(await call(getScreenshots, as(), { id: queued.id })).toMatchObject({ state: "failed" });
  expect(await call(testScreenshotSettings, as(), {})).toMatchObject({ state: "done" });
});

test("the residential proxy is off unless the project turns it on: null by default, \"us\" when on", async () => {
  expect(await setUp()).toMatchObject({ residentialProxy: false });
  await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(browserUse.runs.at(-1)!.body.browserSettings).toMatchObject({ proxyCountryCode: null });
  expect(await call(updateScreenshotSettings, as(), { residentialProxy: true })).toMatchObject({ residentialProxy: true });
  await call(takeScreenshots, as(), { shots: [{ show: "The dashboard" }] });
  expect(browserUse.runs.at(-1)!.body.browserSettings).toMatchObject({ proxyCountryCode: "us" });
  // Saved without it, it stays.
  expect(await call(updateScreenshotSettings, as(), { about: "Close the tour." })).toMatchObject({ residentialProxy: true });
});

test("the fake, like the rule it stands for, refuses a run that doesn't say whether to use Browser Use's residential proxy", async () => {
  const create = (browserSettings: unknown) =>
    fetch(`${browserUse.env.BROWSER_USE_API_URL}/runs`, {
      method: "POST",
      headers: { "X-Browser-Use-API-Key": browserUse.env.BROWSER_USE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ task: "Look", model: "bu-4.0-mini", browserSettings }),
    });
  expect((await create({ screenWidth: 1440, screenHeight: 900 })).status).toBe(422);
  expect((await create(undefined)).status).toBe(422);
});
