import { expect, test } from "vitest";

import { latestOnly } from "./latest-only";

test("a job that finishes after a newer one was asked for keeps its result, and one not yet started is skipped", async () => {
  const exchange = latestOnly();
  const ran: string[] = [];
  const told: string[] = [];
  let finishFirst!: () => void;
  exchange(
    () => new Promise<string>((resolve) => (finishFirst = () => resolve((ran.push("kim"), "kim")))),
    (who) => told.push(who),
  );
  await new Promise((resolve) => setTimeout(resolve));
  exchange(async () => (ran.push("lee"), "lee"), (who) => told.push(who));
  exchange(async () => (ran.push("nobody"), "nobody"), (who) => told.push(who));
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve));
  // Kim's was running (its cookie set) when nobody was signed in; nobody's runs after it, so it's what's left.
  expect(ran).toEqual(["kim", "nobody"]);
  expect(told).toEqual(["nobody"]);
});

test("a job that fails doesn't stop the next", async () => {
  const exchange = latestOnly();
  const told: string[] = [];
  exchange(() => Promise.reject(new Error("offline")), () => told.push("failed"));
  await new Promise((resolve) => setTimeout(resolve));
  exchange(async () => "lee", (who) => told.push(who));
  await new Promise((resolve) => setTimeout(resolve));
  expect(told).toEqual(["lee"]);
});
