import { expect, test } from "vitest";

import { GET } from "./route";

test("healthy while the database answers", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
