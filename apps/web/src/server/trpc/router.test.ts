import { expect, test, vi } from "vitest";

// Loading the operations loads the app's auth, which reads its addresses: placeholders (unit tests have none).
vi.hoisted(() => {
  process.env.APP_URL = "http://tuti.localhost:3100";
  process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
});

import { allOperations } from "../operations";
import { appRouter } from "./router";

// Generated from the operations list: one procedure per operation under its name, a query exactly when it's a GET, so
// no write is ever served as a GET.
test("the router has a procedure for every operation under its name, a query exactly when its method is GET", () => {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  expect(Object.keys(procedures).sort()).toEqual(allOperations.map((operation) => operation.name).sort());
  for (const operation of allOperations) {
    expect({ name: operation.name, type: procedures[operation.name]!._def.type }).toEqual({ name: operation.name, type: operation.method === "GET" ? "query" : "mutation" });
  }
});
