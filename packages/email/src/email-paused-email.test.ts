import { expect, test } from "vitest";

import { pausedNotice } from "./email-paused-email";

test("the pause notice says why from the stored reason: bounces, or spam reports", () => {
  expect(pausedNotice("2.0% of emails bounced in the last 2 weeks (2 of 100)")).toBe(
    "Email sending is paused because of a high bounce rate. We need to review it before sending can be enabled again.",
  );
  expect(pausedNotice("5 people marked emails as spam in the last 2 weeks")).toBe(
    "Email sending is paused because of too many spam reports. We need to review it before sending can be enabled again.",
  );
});
