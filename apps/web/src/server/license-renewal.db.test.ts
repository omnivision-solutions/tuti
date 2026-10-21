import { generateKeyPairSync } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { POST } from "@/app/api/license/refresh/route";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { testLicensePrivateKey } from "@/test/license";

import { installationId } from "./license";
import { DAY_MS, renewLicense } from "./license-renewal";
import { signLicense } from "./license-server";
import { getBranding, updateBranding } from "./operations/branding";
import { checkLicense } from "./operations/license";
import { call } from "./operations/run";

vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey);

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
/** Calls to tuti.so, answered by the licence server's own route in this process (unless a test says otherwise). */
let tutiSo: ReturnType<typeof vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>>;

beforeEach(async () => {
  // This installation is its own licence server, as tuti.so would be.
  vi.stubEnv("LICENSE_PRIVATE_KEY", testLicensePrivateKey);
  vi.stubEnv("LICENSE_SERVER_URL", "http://tuti.test");
  tutiSo = vi.fn((url: string | URL, init?: RequestInit) => POST(new Request(url, init)));
  vi.stubGlobal("fetch", tutiSo);
  owner = await signUp();
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const check = () => call(checkLicense, team(), {});
const poweredBy = async () => (await call(getBranding, team(), {})).poweredBy;
const state = () =>
  prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { licenseKey: true, licenseToken: true, licenseRequestId: true } });
/** Tuti sells this project's licence (scripts/license.mjs activate). */
const sell = async () => prisma.license.create({ data: { installationId: await installationId(), projectId: project.id } });
/** As if the last check was `days` ago. */
const checkedDaysAgo = (days: number) =>
  prisma.project.update({ where: { id: project.id }, data: { licenseCheckedAt: new Date(Date.now() - days * DAY_MS) } });

test("a project nobody asked a licence for never contacts tuti.so", async () => {
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("busy");
  expect(tutiSo).not.toHaveBeenCalled();
});

test("Check now before buying says so; once bought it gets a key, and Powered by tuti can be hidden", async () => {
  expect(await check()).toEqual({ status: "not_licensed", licensedUntil: null });
  const [url, init] = tutiSo.mock.calls[0]!;
  expect(String(url)).toBe("http://tuti.test/api/license/refresh");
  // What it sends: this installation and project, no token yet, a request id and the app version.
  expect(JSON.parse(init!.body as string)).toEqual({
    installation: await installationId(),
    project: project.id,
    token: null,
    requestId: expect.any(String),
    version: expect.any(String),
  });

  await sell();
  // Pressed again at once: it's just been checked.
  expect(await check()).toMatchObject({ status: "busy", licensedUntil: null });
  await checkedDaysAgo(1);
  const licensed = await check();
  expect(licensed.status).toBe("licensed");
  expect(licensed.licensedUntil!.getTime()).toBeGreaterThan(Date.now() + 34 * DAY_MS);
  await call(updateBranding, team(), { poweredBy: false });
  expect(await poweredBy()).toBe(false);
});

test("renewals are at most daily, each with the next token", async () => {
  await sell();
  await check();
  const first = await state();
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("busy");
  await checkedDaysAgo(2);
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("licensed");
  const second = await state();
  expect(second.licenseToken).not.toBe(first.licenseToken);
  expect(second.licenseKey).not.toBeNull();
  expect(second.licenseRequestId).toBeNull();
});

test("an answer lost on the way back is asked for again with the same request id, and tuti.so gives it", async () => {
  await sell();
  await check();
  const before = await state();
  // tuti.so renews, but the answer never arrives.
  tutiSo.mockImplementationOnce(async (url, init) => {
    await POST(new Request(url, init));
    throw new TypeError("fetch failed");
  });
  await checkedDaysAgo(2);
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("unreachable");
  const lost = await state();
  expect(lost).toMatchObject({ licenseKey: before.licenseKey, licenseToken: before.licenseToken, licenseRequestId: expect.any(String) });

  await checkedDaysAgo(2);
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("licensed");
  const retried = JSON.parse(tutiSo.mock.lastCall![1]!.body as string) as { requestId: string };
  expect(retried.requestId).toBe(lost.licenseRequestId);
  expect((await state()).licenseToken).not.toBe(before.licenseToken);
});

test("a copy of the installation that renews with a spent token loses the licence: its badge is back", async () => {
  await sell();
  await check();
  await call(updateBranding, team(), { poweredBy: false });
  const copied = await state();
  await checkedDaysAgo(2);
  await renewLicense(project.id, { olderThan: DAY_MS });

  // The copy still has the first token.
  await prisma.project.update({ where: { id: project.id }, data: { licenseToken: copied.licenseToken, licenseRequestId: null } });
  await checkedDaysAgo(2);
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("in_use");
  expect(await state()).toEqual({ licenseKey: null, licenseToken: null, licenseRequestId: null });
  expect(await poweredBy()).toBe(true);
});

test("a cancelled licence removes the key; tuti.so not answering keeps it", async () => {
  await sell();
  await check();
  const key = (await state()).licenseKey;

  for (const answer of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.resolve(new Response("", { status: 502 }))]) {
    tutiSo.mockImplementationOnce(answer);
    await checkedDaysAgo(1);
    expect(await check()).toMatchObject({ status: "unreachable", licensedUntil: expect.any(Date) });
    expect((await state()).licenseKey).toBe(key);
  }
  // A key that isn't Tuti's isn't kept either.
  const other = generateKeyPairSync("ed25519").privateKey;
  const forged = signLicense(other, { installation: await installationId(), project: project.id });
  tutiSo.mockImplementationOnce(async () => Response.json({ key: forged, token: "t", now: new Date().toISOString() }));
  await checkedDaysAgo(1);
  expect(await check()).toMatchObject({ status: "unreachable" });
  expect((await state()).licenseKey).toBe(key);

  await prisma.license.updateMany({ where: { projectId: project.id }, data: { active: false } });
  await checkedDaysAgo(1);
  expect(await check()).toEqual({ status: "not_licensed", licensedUntil: null });
  expect((await state()).licenseKey).toBeNull();
});

test("a check that outlasted its claim leaves the project to the check that took over", async () => {
  await sell();
  await check();
  const before = await state();
  // While tuti.so answers, the lease runs out and another check claims the project.
  tutiSo.mockImplementationOnce(async (url, init) => {
    await prisma.project.update({ where: { id: project.id }, data: { licenseCheckedAt: new Date(Date.now() + 1000) } });
    return POST(new Request(url, init));
  });
  await checkedDaysAgo(2);
  expect(await renewLicense(project.id, { olderThan: DAY_MS })).toBe("busy");
  expect((await state()).licenseKey).toBe(before.licenseKey);
});

test("keys expire by the latest time tuti.so has said it is, so setting the clock back doesn't help", async () => {
  await sell();
  await check();
  await call(updateBranding, team(), { poweredBy: false });
  expect((await prisma.installation.findFirstOrThrow()).latestSeenAt).not.toBeNull();
  // tuti.so said it's two months from now: the 35-day key is expired, whatever this clock says.
  await prisma.installation.updateMany({ data: { latestSeenAt: new Date(Date.now() + 60 * DAY_MS) } });
  expect(await poweredBy()).toBe(true);
  await prisma.installation.updateMany({ data: { latestSeenAt: null } });
});
