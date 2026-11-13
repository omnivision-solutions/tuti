import { readFileSync } from "node:fs";
import { join } from "node:path";

import { billingFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { billingConfig, billingSchema } from "./billing";

afterEach(() => vi.unstubAllEnvs());

test("billing.schema.json is the schema's (pnpm test -u rewrites it)", async () => {
  await expect(`${JSON.stringify(z.toJSONSchema(billingSchema, { io: "input", unrepresentable: "any" }), null, 2)}\n`).toMatchFileSnapshot("../billing.schema.json");
});

test("the example file is valid, and the test file is too", () => {
  billingSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../billing.example.json"), "utf8")));
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(billingConfig()?.plans.map(({ key }) => key)).toEqual(["free", "pro", "business"]);
});

test("an invalid file stops the server, naming what's wrong", () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { pro }) => {
    config.defaultPlan = "starter";
    pro.limits.boards = -1;
    pro.prices.month!.stripe = pro.prices.year!.stripe;
  }));
  expect(() => billingConfig()).toThrow(/"starter" isn't one of the plans\n {2}→ at defaultPlan/);
  expect(() => billingConfig()).toThrow(/plans\[1\]\.limits\.boards/);
  expect(() => billingConfig()).toThrow(/is listed twice/);
});
