import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";

import { GET } from "./route";

afterEach(() => vi.restoreAllMocks());

test("healthy while the database answers", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("unhealthy (503) when the database doesn't answer", async () => {
  vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false });
});
