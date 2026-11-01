import { Prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import { withLockRetries } from "./lock-retries";

const deadlock = () => new Prisma.PrismaClientKnownRequestError("deadlock detected (40P01)", { code: "P2034", clientVersion: "test" });

test("a transaction Postgres aborts for its locks runs again, and its second try's result comes back", async () => {
  const run = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce("removed");
  expect(await withLockRetries(run)).toBe("removed");
  expect(run).toHaveBeenCalledTimes(2);
});

test("a raw query's deadlock (P2010, 40P01 in its message) is a lock error too, and runs again", async () => {
  const raw = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `40P01`. Message: `deadlock detected`', { code: "P2010", clientVersion: "test" });
  const run = vi.fn().mockRejectedValueOnce(raw).mockResolvedValueOnce("removed");
  expect(await withLockRetries(run)).toBe("removed");
  expect(run).toHaveBeenCalledTimes(2);
});

test("after 3 tries the last lock error is thrown (the action turns it into its message)", async () => {
  const run = vi.fn().mockRejectedValue(deadlock());
  await expect(withLockRetries(run)).rejects.toMatchObject({ code: "P2034" });
  expect(run).toHaveBeenCalledTimes(3);
});

test("any other error is thrown at once, never retried", async () => {
  const run = vi.fn().mockRejectedValue(new Error("database down"));
  await expect(withLockRetries(run)).rejects.toThrow("database down");
  expect(run).toHaveBeenCalledTimes(1);
});
