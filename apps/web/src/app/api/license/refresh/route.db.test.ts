import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { licensedUntil } from "@/server/license";
import { testLicensePrivateKey } from "@/test/license";

import { POST } from "./route";

vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey);

const DAY = 24 * 60 * 60 * 1000;
/** The installation and project of each test's licence (the database is shared by the file's tests). */
let ids: { installation: string; project: string };

beforeEach(() => {
  vi.stubEnv("LICENSE_PRIVATE_KEY", testLicensePrivateKey);
  ids = { installation: randomUUID(), project: randomUUID() };
});
afterEach(() => vi.unstubAllEnvs());

type Answer = { key?: string; token?: string; now?: string; error?: string };
/** One renewal attempt, as an installation makes it. */
async function refresh(token: string | null, requestId: string = randomUUID(), body: object = {}) {
  const response = await POST(
    new Request("http://tuti.localhost:3100/api/license/refresh", {
      method: "POST",
      body: JSON.stringify({ ...ids, token, requestId, version: "0.1.0", ...body }),
    }),
  );
  return { status: response.status, ...((await response.json()) as Answer) };
}
const sell = (data: { active?: boolean } = {}) => prisma.license.create({ data: { installationId: ids.installation, projectId: ids.project, ...data } });
const license = () => prisma.license.findUniqueOrThrow({ where: { installationId_projectId: { installationId: ids.installation, projectId: ids.project } } });

test("an installation claims a licence Tuti sold, gets a key for about a month, and renews it with each new token", async () => {
  expect(await refresh(null)).toMatchObject({ status: 403, error: "not_licensed" });
  await sell();

  const first = await refresh(null);
  expect(first.status).toBe(200);
  expect(licensedUntil(first.key!, ids)!.getTime()).toBeGreaterThan(Date.now() + 34 * DAY);
  expect(licensedUntil(first.key!, { ...ids, project: "another-project" })).toBeNull();
  expect(Math.abs(new Date(first.now!).getTime() - Date.now())).toBeLessThan(60_000);

  const second = await refresh(first.token!);
  expect(second).toMatchObject({ status: 200, key: expect.any(String) });
  expect(second.token).not.toBe(first.token);
  expect(await refresh(second.token!)).toMatchObject({ status: 200 });
  expect(await license()).toMatchObject({ generation: 3, version: "0.1.0", refusedCount: 0, lastRefreshAt: expect.any(Date) });
});

test("a spent token, or a second claim, is another installation using the licence: refused and counted", async () => {
  await sell();
  const first = await refresh(null);
  // A copy of the installation, made before it renewed, still has the first token.
  const renewed = await refresh(first.token!);
  expect(await refresh(first.token!)).toMatchObject({ status: 403, error: "in_use" });
  expect(await refresh(null)).toMatchObject({ status: 403, error: "in_use" });
  expect(await refresh("made-up-token")).toMatchObject({ status: 403, error: "in_use" });
  expect(await license()).toMatchObject({ refusedCount: 3, lastRefusedAt: expect.any(Date) });
  // The installation that renewed carries on.
  expect(await refresh(renewed.token!)).toMatchObject({ status: 200 });
});

test("a retry after a lost answer gets the same answer, with the same request id only, until the new token is used", async () => {
  await sell();
  const claim = randomUUID();
  const first = await refresh(null, claim);
  expect((await refresh(null, claim)).token).toBe(first.token);

  const renewal = randomUUID();
  const second = await refresh(first.token!, renewal);
  // The answer was lost: the installation retries with what it had, and the same request id.
  expect((await refresh(first.token!, renewal)).token).toBe(second.token);
  // The same token with another request id is a copy of the installation.
  expect(await refresh(first.token!, randomUUID())).toMatchObject({ status: 403, error: "in_use" });

  // Once the new token is used, the old one is spent even with the old request id.
  await refresh(second.token!);
  expect(await refresh(first.token!, renewal)).toMatchObject({ status: 403, error: "in_use" });
});

test("a cancelled licence isn't renewed", async () => {
  await sell();
  const first = await refresh(null);
  await prisma.license.update({ where: { id: (await license()).id }, data: { active: false } });
  expect(await refresh(first.token!)).toMatchObject({ status: 403, error: "not_licensed" });
});

test("only Tuti's own installation is a licence server, and requests are checked", async () => {
  await sell();
  expect((await refresh(null, randomUUID(), { installation: "" })).status).toBe(400);
  expect((await refresh(null, "short")).status).toBe(400);
  vi.stubEnv("LICENSE_PRIVATE_KEY", "");
  expect(await refresh(null)).toMatchObject({ status: 404 });
  expect(await license()).toMatchObject({ generation: 0 });
});

test("two renewals with the same token at once: one renews, the other is a copy", async () => {
  await sell();
  const { token } = await refresh(null);
  const { id } = await license();
  const { renewals } = await prisma.$transaction(
    async (tx) => {
      // Holds the licence's row, so both renewals have started before either can renew.
      await tx.$executeRaw`SELECT 1 FROM license WHERE id = ${id} FOR UPDATE`;
      const renewals = Promise.all([refresh(token!), refresh(token!)]);
      // Both wait for the row (with no lock of their own, both would have read the same generation by now).
      // Counted in this test file's database, on the licence table only.
      let waiting = 0;
      for (let tries = 0; waiting < 2 && tries < 250; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        // pg_stat_activity is read once per transaction unless its snapshot is cleared.
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot()`;
        const [row] = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%license%'`;
        waiting = Number(row!.count);
      }
      expect(waiting).toBe(2);
      // Wrapped: the transaction commits (letting them go) without waiting for them.
      return { renewals };
    },
    { timeout: 10_000 },
  );
  const both = await renewals;
  expect(both.map((answer) => answer.status).sort()).toEqual([200, 403]);
  expect(both.find((answer) => answer.status === 403)).toMatchObject({ error: "in_use" });
  expect(await license()).toMatchObject({ generation: 2, refusedCount: 1 });
});
