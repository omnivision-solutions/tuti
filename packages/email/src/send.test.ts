import { expect, test } from "vitest";

import { deliveredMessageId } from "./send";

const ses = "0100019a2b3c4d5e-1a2b3c4d-5e6f-4a1b-9c8d-0123456789ab-000000";

test("Amazon SES's Message-ID comes from its answer, in its region's domain; other servers keep ours", () => {
  expect(deliveredMessageId(`250 Ok ${ses}`, "email-smtp.us-east-1.amazonaws.com")).toBe(`<${ses}@email.amazonses.com>`);
  expect(deliveredMessageId(`250 Ok ${ses}`, "email-smtp.eu-west-1.amazonaws.com")).toBe(`<${ses}@eu-west-1.amazonses.com>`);
  expect(deliveredMessageId("250 2.0.0 Ok: queued as 4F1A2B3C", "smtp.example.com")).toBeNull();
  expect(deliveredMessageId("250 Accepted", "smtp.example.com")).toBeNull();
  expect(deliveredMessageId(null)).toBeNull();
});
