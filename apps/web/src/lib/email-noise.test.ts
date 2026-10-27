import { expect, test } from "vitest";

import { noiseReason } from "./email-noise";

const mail = (headers: Record<string, string> = {}, more: { from?: string; subject?: string; nullSender?: boolean } = {}) => ({
  headers: new Map(Object.entries(headers)),
  from: more.from ?? "e2e-sam@example.com",
  subject: more.subject ?? "Help",
  nullSender: more.nullSender ?? false,
});

test("a person's email is a message", () => {
  expect(noiseReason(mail())).toBeNull();
  expect(noiseReason(mail({ "auto-submitted": "no" }))).toBeNull();
  // No-reply senders aren't dropped: a mail provider's forwarding confirmation comes from one, and the team needs it.
  expect(noiseReason(mail({}, { from: "forwarding-noreply@google.com" }))).toBeNull();
});

test.each([
  ["our own mail coming back", mail({ "x-tuti-loop": "acme" }), "loop"],
  ["a bounce from the mailer daemon", mail({}, { from: "MAILER-DAEMON@mx.example.com" }), "bounce"],
  [
    "a delivery report with no return path",
    mail({ "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' }, { nullSender: true }),
    "bounce",
  ],
  ["auto-generated mail", mail({ "auto-submitted": "auto-replied" }), "auto_submitted"],
  ["bulk mail", mail({ precedence: "bulk" }), "precedence"],
  ["list mail", mail({ precedence: "list" }), "precedence"],
  ["an auto-reply header", mail({ "x-autoreply": "yes" }), "auto_reply"],
  ["an Exchange out-of-office", mail({ "x-auto-response-suppress": "All" }, { subject: "Automatic reply: Help" }), "auto_reply"],
  ["no sender", mail({}, { from: "" }), "no_sender"],
])("ignored: %s", (_, email, reason) => {
  expect(noiseReason(email)).toBe(reason);
});
