import { expect, test } from "vitest";

import { lastDeliveryText } from "./webhook-events";

const now = new Date("2026-10-19T12:00:00Z");
const at = new Date("2026-10-19T11:58:00Z");

test("a delivery not tried yet is queued, not failed", () => {
  expect(lastDeliveryText(null, now)).toBe("no deliveries yet");
  expect(lastDeliveryText({ createdAt: at, deliveredAt: null, lastError: null, attempts: 0 }, now)).toMatch(/^delivery queued /);
  expect(lastDeliveryText({ createdAt: at, deliveredAt: null, lastError: "Answered 500", attempts: 1 }, now)).toMatch(
    /^last delivery failed .*: Answered 500$/,
  );
  expect(lastDeliveryText({ createdAt: at, deliveredAt: at, lastError: null, attempts: 1 }, now)).toMatch(/^last delivered /);
});
