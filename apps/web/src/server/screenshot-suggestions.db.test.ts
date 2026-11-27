import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { prisma } from "@tuti/db";
import { partlyScannedFor, SCREENSHOT_SECRET, scannedFor, scanSignInServices } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { call } from "@/server/operations/run";
import { FETCHES_PER_MEMBER_PER_MINUTE } from "@/server/operations/fetch-limits";
import { suggestScreenshotDomains } from "@/server/operations/screenshots";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/**
 * Settings → Screenshots' suggestions (screenshotSettings.suggestions): the sign-in services an app's page and scripts
 * call, read from a fake app on this machine (tests' Tuti is on localhost, where only that is fetched). The read is the
 * screenshot-sign-in-scan job's (inline here: done before the look that started it answers "checking").
 */

let server: Server;
let base: string;
const requests: string[] = [];
let connections = 0;
/** Script reads at once, and the most at once. */
let reading = 0;
/** A 3 MB script. */
const heavy = " ".repeat(3_000_000);
/** A 2.8 MB script, less the sign-in SDK's line in one of them. */
const chunk = " ".repeat(2_800_000 - 50);
/** A 2 MB script of 1 million characters. */
const wide = "é".repeat(1_000_000);
let mostReading = 0;
/** Script reads that fail (500) before it loads. */
let scriptFailures = 0;
/** /assets/slow.js answers once this is let go. */
let slowScript: Promise<void> = Promise.resolve();
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/") {
      response.writeHead(302, { location: "/app" }).end();
    } else if (request.url === "/app") {
      response.writeHead(200, { "content-type": "text/html" }).end('<html><script type="module" src="/assets/main.js"></script><script src="https://cdn.elsewhere.example/x.js"></script></html>');
    } else if (request.url === "/assets/main.js" && scriptFailures > 0) {
      scriptFailures--;
      response.writeHead(500).end();
    } else if (request.url === "/partial") {
      response.writeHead(200, { "content-type": "text/html" }).end('<script src="/assets/main.js"></script><script src="/assets/gone.js"></script>');
    } else if (request.url === "/slow") {
      response.writeHead(200, { "content-type": "text/html" }).end('<script src="/assets/slow.js"></script>');
    } else if (request.url === "/assets/slow.js") {
      void slowScript.then(() => response.writeHead(200, { "content-type": "text/javascript" }).end('const a="identitytoolkit.googleapis.com";'));
    } else if (request.url === "/assets/main.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end('initializeApp({authDomain:"acme.firebaseapp.com"});const a="identitytoolkit.googleapis.com",b="securetoken.googleapis.com";');
    } else if (request.url === "/many") {
      response.writeHead(200, { "content-type": "text/html" }).end(Array.from({ length: 101 }, (_, i) => `<script src="/assets/s${i}.js"></script>`).join(""));
    } else if (request.url?.startsWith("/heavy")) {
      const count = Number(new URL(request.url, base).searchParams.get("scripts") ?? 30);
      response.writeHead(200, { "content-type": "text/html" }).end(Array.from({ length: count }, (_, i) => `<script src="/assets/h${i}.js"></script>`).join(""));
    } else if (request.url === "/one") {
      response.writeHead(200, { "content-type": "text/html" }).end('<script src="/assets/one.js"></script>');
    } else if (request.url === "/assets/one.js") {
      // A single-page app's one 4 MB bundle, the sign-in SDK at its end.
      response.writeHead(200, { "content-type": "text/javascript" }).end(`${" ".repeat(4_000_000)}const a="identitytoolkit.googleapis.com";`);
    } else if (request.url === "/chunks") {
      response.writeHead(200, { "content-type": "text/html" }).end(Array.from({ length: 14 }, (_, i) => `<script src="/assets/c${i}.js"></script>`).join(""));
    } else if (request.url?.startsWith("/assets/c")) {
      // 39.2 MB in 2.8 MB chunks, the sign-in SDK at the end of the last; answered after a moment, so 8 are read at once.
      setTimeout(() => response.writeHead(200, { "content-type": "text/javascript" }).end(request.url === "/assets/c13.js" ? `${chunk}const a="identitytoolkit.googleapis.com";` : chunk), 20);
    } else if (request.url?.startsWith("/assets/h")) {
      response.writeHead(200, { "content-type": "text/javascript" }).end(heavy);
    } else if (request.url === "/wide") {
      response.writeHead(200, { "content-type": "text/html" }).end(Array.from({ length: 30 }, (_, i) => `<script src="/assets/w${i}.js"></script>`).join(""));
    } else if (request.url?.startsWith("/assets/w")) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(wide);
    } else if (request.url?.startsWith("/assets/s")) {
      // The sign-in SDK deep in a Next.js page's chunks, at the end of a large one, as on a real app (its 26th of 40).
      reading++;
      mostReading = Math.max(mostReading, reading);
      setTimeout(() => {
        reading--;
        response.writeHead(200, { "content-type": "text/javascript" }).end(request.url === "/assets/s39.js" ? `${" ".repeat(1_000_000)}const a="identitytoolkit.googleapis.com";` : "");
      }, 5);
    } else {
      response.writeHead(404).end();
    }
  });
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  vi.stubEnv("SCREENSHOTS_ALLOW_LOCALHOST", "true");
  requests.length = 0;
  connections = 0;
  reading = 0;
  mostReading = 0;
  owner = await signUp("Owner");
  project = await createProject(owner);
});

/** A look at the suggestions; `start: false` (the screen's polls) only reads. */
const look = (input: { start?: boolean } = {}) => call(suggestScreenshotDomains, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, input);
/** The suggestions once the read is done: a first look starts it (and says it's checking), the next reads its answer. */
const suggestions = async () => {
  const first = await look();
  return first.checking ? (await look({ start: false })).suggestions : first.suggestions;
};
const saved = () => prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } });
const settle = (data: { appUrl: string; otherDomains?: string[] }) => prisma.screenshotSettings.upsert({ where: { projectId: project.id }, create: { projectId: project.id, ...data }, update: data });

test("finds the app's sign-in service in its own scripts, once per address, and leaves out hosts already allowed", async () => {
  expect(await suggestions()).toEqual([]);
  await settle({ appUrl: `${base}/` });
  const firebase = { provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] };
  expect(await suggestions()).toEqual([firebase]);
  // The redirect followed, and only its own site's script read.
  expect(requests).toEqual(["/", "/app", "/assets/main.js"]);

  // Kept: not read again for the same address.
  expect(await suggestions()).toEqual([firebase]);
  expect(requests).toHaveLength(3);
  // A host listed isn't suggested.
  await settle({ appUrl: `${base}/`, otherDomains: ["securetoken.googleapis.com"] });
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com"] }]);

  // Another address is read again; one that can't be read suggests nothing, and isn't kept.
  await settle({ appUrl: `${base}/missing`, otherDomains: [] });
  expect(await suggestions()).toEqual([]);
  expect(requests.at(-1)).toBe("/missing");
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).signInServicesFor).toBe(scannedFor(`${base}/`));
});

test("a script that didn't load isn't kept as nothing found: the next look reads it again", async () => {
  scriptFailures = 1;
  await settle({ appUrl: `${base}/` });
  expect(await suggestions()).toEqual([]);
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
  expect(requests).toEqual(["/", "/app", "/assets/main.js", "/", "/app", "/assets/main.js"]);
});

test("never suggests what Other domains refuses (a shared suffix), nor a host the browser opens already (under the app's, the sign-in link's)", async () => {
  const appUrl = "https://app.example.com";
  await settle({ appUrl });
  await prisma.screenshotSettings.update({
    where: { projectId: project.id },
    data: {
      signIn: "LINK",
      signInLink: sealValue(SCREENSHOT_SECRET, "https://login.acme.example/magic?token=t"),
      signInServicesFor: scannedFor(appUrl),
      signInServices: [{ provider: "Clerk", hosts: ["vercel.app", "github.io", "acme-12.clerk.accounts.dev", "sub.app.example.com", "login.acme.example"] }],
    },
  });
  expect(await suggestions()).toEqual([{ provider: "Clerk", hosts: ["acme-12.clerk.accounts.dev"] }]);
});

test("off localhost, only public addresses over https: an app at a private address isn't read", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example.com");
  const port = new URL(base).port;
  for (const appUrl of [`https://localhost:${port}/`, `http://localhost:${port}/`, `http://127.0.0.1:${port}/`, `https://[::1]:${port}/`]) {
    await settle({ appUrl });
    expect(await suggestions()).toEqual([]);
  }
  // Never even connected to: refused when looked up (a name) or before (an address).
  expect(connections).toBe(0);
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).signInServicesFor).toBeNull();
});

test("Tuti on localhost without SCREENSHOTS_ALLOW_LOCALHOST (a self-hosted server) doesn't read a local app either", async () => {
  vi.stubEnv("SCREENSHOTS_ALLOW_LOCALHOST", "");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  await settle({ appUrl: `${base}/` });
  expect(await suggestions()).toEqual([]);
  expect(connections).toBe(0);
});

test("a page with many scripts reads the first 100, 8 at a time and each in full, the same each time, so what's found is kept", async () => {
  await settle({ appUrl: `${base}/many` });
  const firebase = [{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }];
  expect(await suggestions()).toEqual(firebase);
  expect(await suggestions()).toEqual(firebase);
  expect(requests.filter((path) => path.startsWith("/assets/s"))).toHaveLength(100);
  expect(mostReading).toBeLessThanOrEqual(8);
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).signInServicesFor).toBe(scannedFor(`${base}/many`));
});

test("a page whose scripts pass 40 MB together reads no more of them, and the answer is only shown, read again next time", async () => {
  await settle({ appUrl: `${base}/heavy` });
  expect(await suggestions()).toEqual([]);
  // 14 fill the budget; up to 7 more were already on their way.
  expect(requests.filter((path) => path.startsWith("/assets/h")).length).toBeLessThan(22);
  expect(await saved()).toMatchObject({ signInServicesFor: partlyScannedFor(`${base}/heavy`), signInServicesAt: null });
});

test("the last script cut short by the budget, with none left to read, isn't kept as the answer either", async () => {
  await settle({ appUrl: `${base}/heavy?scripts=14` });
  await suggestions();
  expect(requests.filter((path) => path.startsWith("/assets/h"))).toHaveLength(14);
  expect(await saved()).toMatchObject({ signInServicesAt: null });
});

test("scripts under the budget together are read in full, the last as much as the first, and the answer is kept", async () => {
  await settle({ appUrl: `${base}/chunks` });
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).signInServicesFor).toBe(scannedFor(`${base}/chunks`));
});

test("a single-page app's one large bundle is read in full, up to 5 MB, and the answer is kept", async () => {
  await settle({ appUrl: `${base}/one` });
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
  expect((await prisma.screenshotSettings.findUniqueOrThrow({ where: { projectId: project.id } })).signInServicesFor).toBe(scannedFor(`${base}/one`));
});

test("the budget counts the bytes read, not the characters", async () => {
  await settle({ appUrl: `${base}/wide` });
  expect(await suggestions()).toEqual([]);
  // 20 fill the budget; up to 7 more were already on their way.
  expect(requests.filter((path) => path.startsWith("/assets/w")).length).toBeLessThan(28);
});

test("an answer saved by the earlier scanner, under the bare address, is found again", async () => {
  await settle({ appUrl: `${base}/many` });
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServices: [], signInServicesFor: `${base}/many` } });
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
});

test("settings without an app address suggest nothing", async () => {
  await settle({ appUrl: "" });
  expect(await suggestions()).toEqual([]);
});

test("a sign-in link that no longer opens (another server secret) still gets suggestions", async () => {
  const appUrl = "https://app.example.com";
  await settle({ appUrl });
  await prisma.screenshotSettings.update({
    where: { projectId: project.id },
    data: { signIn: "LINK", signInLink: "v1.not-sealed-here", signInServicesFor: scannedFor(appUrl), signInServices: [{ provider: "Auth0", hosts: ["acme.auth0.com"] }] },
  });
  expect(await suggestions()).toEqual([{ provider: "Auth0", hosts: ["acme.auth0.com"] }]);
});

test("reads of the app count against the fetch limits: past them, 429 and nothing fetched", async () => {
  await settle({ appUrl: `${base}/missing` });
  for (let i = 0; i < FETCHES_PER_MEMBER_PER_MINUTE; i++) {
    expect(await suggestions()).toEqual([]);
  }
  const fetched = requests.length;
  await expect(suggestions()).rejects.toMatchObject({ status: 429 });
  expect(requests).toHaveLength(fetched);
});

test("a kept answer counts against no limit: looked at again and again, never refused", async () => {
  await settle({ appUrl: `${base}/` });
  for (let i = 0; i <= FETCHES_PER_MEMBER_PER_MINUTE + 1; i++) {
    expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
  }
});

test("the first look starts the read in the background and says it's checking; the next has its answer", async () => {
  await settle({ appUrl: `${base}/` });
  expect(await look()).toEqual({ suggestions: [], checking: true });
  // Done: the read has ended and its answer is kept, with when it was found.
  expect(await look({ start: false })).toEqual({ suggestions: [{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }], checking: false });
  expect(await saved()).toMatchObject({ signInServicesFor: scannedFor(`${base}/`), signInServicesAt: expect.any(Date), signInScanFor: null, signInScanAt: null });
});

test("one read per project at a time: a look while one runs for the same address starts no other", async () => {
  await settle({ appUrl: `${base}/slow` });
  let letGo!: () => void;
  slowScript = new Promise((resolve) => (letGo = resolve));
  const first = look();
  // Its script asked for: the read is claimed and running.
  await vi.waitFor(() => expect(requests).toContain("/assets/slow.js"));
  expect(await Promise.all([look(), look()])).toEqual([{ suggestions: [], checking: true }, { suggestions: [], checking: true }]);
  letGo();
  expect(await first).toEqual({ suggestions: [], checking: true });
  expect(requests.filter((path) => path === "/slow")).toHaveLength(1);

  // One running (a claim of a moment ago): the look says checking and reads nothing.
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServicesFor: null, signInScanFor: scannedFor(`${base}/slow`), signInScanAt: new Date() } });
  expect(await look()).toEqual({ suggestions: [], checking: true });
  expect(requests.filter((path) => path === "/slow")).toHaveLength(1);
  // One started long ago was lost (its worker stopped, say): a look starts another.
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInScanAt: new Date(Date.now() - 10 * 60_000) } });
  expect(await look()).toEqual({ suggestions: [], checking: true });
  expect(requests.filter((path) => path === "/slow")).toHaveLength(2);
});

test("a read that isn't complete ends the checking without keeping it as the answer; a poll starts no other, the next look does", async () => {
  scriptFailures = 1;
  await settle({ appUrl: `${base}/` });
  expect(await look()).toEqual({ suggestions: [], checking: true });
  expect(await look({ start: false })).toEqual({ suggestions: [], checking: false });
  expect(await saved()).toMatchObject({ signInServicesAt: null, signInScanFor: null });
  expect(requests).toEqual(["/", "/app", "/assets/main.js"]);
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
});

test("an answer older than 7 days is read again, and shown while it is", async () => {
  const appUrl = `${base}/`;
  await settle({ appUrl });
  const old = [{ provider: "Auth0", hosts: ["acme.auth0.com"] }];
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServices: old, signInServicesFor: scannedFor(appUrl), signInServicesAt: new Date(Date.now() - 6 * 24 * 3600_000) } });
  // Six days old: kept.
  expect(await look()).toEqual({ suggestions: old, checking: false });
  expect(requests).toHaveLength(0);
  // Eight: shown while it's read again, then the new answer.
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServicesAt: new Date(Date.now() - 8 * 24 * 3600_000) } });
  expect(await look()).toEqual({ suggestions: old, checking: true });
  expect(await look({ start: false })).toEqual({ suggestions: [{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }], checking: false });
});

test("past the fetch limits, an answer older than 7 days is still shown, not refused", async () => {
  const appUrl = `${base}/missing`;
  await settle({ appUrl });
  for (let i = 0; i < FETCHES_PER_MEMBER_PER_MINUTE; i++) {
    await look();
  }
  const old = [{ provider: "Auth0", hosts: ["acme.auth0.com"] }];
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServices: old, signInServicesFor: scannedFor(appUrl), signInServicesAt: new Date(0) } });
  expect(await look()).toEqual({ suggestions: old, checking: false });
});

test("a read taken for lost (never run) still says checking to the page's polls while there's no answer; a look starts another", async () => {
  const appUrl = `${base}/`;
  await settle({ appUrl });
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInScanFor: scannedFor(appUrl), signInScanAt: new Date(Date.now() - 10 * 60_000) } });
  expect(await look({ start: false })).toEqual({ suggestions: [], checking: true });
  expect(requests).toEqual([]);
  expect(await suggestions()).toEqual([{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }]);
});

test("a read ending clears only its own claim, not a later one for the same address", async () => {
  const appUrl = `${base}/`;
  await settle({ appUrl });
  const later = new Date();
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInScanFor: scannedFor(appUrl), signInScanAt: later } });
  await scanSignInServices({ projectId: project.id, appUrl, claimedAt: new Date(later.getTime() - 60_000).toISOString() });
  expect(await saved()).toMatchObject({ signInScanFor: scannedFor(appUrl), signInScanAt: later });
});

test("a read of an address since changed keeps nothing and leaves the new address's read alone", async () => {
  const now = new Date();
  await settle({ appUrl: `${base}/many` });
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInScanFor: scannedFor(`${base}/many`), signInScanAt: now } });
  await scanSignInServices({ projectId: project.id, appUrl: `${base}/` });
  expect(await saved()).toMatchObject({ signInServicesFor: null, signInServices: null, signInScanFor: scannedFor(`${base}/many`), signInScanAt: now });
});

test("what a read that isn't complete found is shown, and the next look reads the app again; it never replaces a full answer", async () => {
  const appUrl = `${base}/partial`;
  const firebase = [{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }];
  await settle({ appUrl });
  expect(await suggestions()).toEqual(firebase);
  expect(await saved()).toMatchObject({ signInServicesFor: partlyScannedFor(appUrl), signInServicesAt: null });
  // Read again (and shown meanwhile).
  expect(await look()).toEqual({ suggestions: firebase, checking: true });
  expect(requests.filter((path) => path === "/partial")).toHaveLength(2);

  // An earlier partial answer is replaced by a newer partial read.
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServices: [] } });
  expect(await suggestions()).toEqual(firebase);

  // A full answer, expired, isn't replaced by a partial read.
  const full = [{ provider: "Auth0", hosts: ["acme.auth0.com"] }];
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServices: full, signInServicesFor: scannedFor(appUrl), signInServicesAt: new Date(0) } });
  expect(await suggestions()).toEqual(full);
  expect(await saved()).toMatchObject({ signInServices: full, signInServicesFor: scannedFor(appUrl), signInServicesAt: new Date(0) });
  // Nor one saved before answers had a time (or by the previous release while a deploy runs both).
  await prisma.screenshotSettings.update({ where: { projectId: project.id }, data: { signInServicesAt: null } });
  expect(await suggestions()).toEqual(full);
  expect(await saved()).toMatchObject({ signInServices: full, signInServicesFor: scannedFor(appUrl), signInServicesAt: null });
});
