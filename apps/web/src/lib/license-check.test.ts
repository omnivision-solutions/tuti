import { expect, test } from "vitest";

import { licenseCheckOutcome } from "./license-check";

const until = new Date("2026-11-30T00:00:00Z");

test("the dialog hides the badge only when tuti.so just said the project is licensed", () => {
  expect(licenseCheckOutcome({ status: "licensed", licensedUntil: until })).toEqual({ licensedUntil: until });
});

test("a key still valid from before doesn't hide it when the check didn't succeed", () => {
  expect(licenseCheckOutcome({ status: "unreachable", licensedUntil: until })).toEqual({
    message: "Couldn't reach tuti.so. Try again in a few minutes.",
  });
  expect(licenseCheckOutcome({ status: "busy", licensedUntil: until })).toEqual({
    message: "Checked a moment ago. Try again in a minute.",
  });
  expect(licenseCheckOutcome({ status: "in_use", licensedUntil: until })).toEqual({
    message: "This project's licence is in use on another installation of Tuti. Email hello@tuti.so to move it here.",
  });
});

test("without a licence, or when the check was refused, it says why", () => {
  expect(licenseCheckOutcome({ status: "not_licensed", licensedUntil: null })).toEqual({
    message: "No licence for this project yet. Once you've bought one, check again.",
  });
  expect(licenseCheckOutcome({ error: "Only project owners and admins can check the licence" })).toEqual({
    message: "Only project owners and admins can check the licence",
  });
  expect(licenseCheckOutcome({ status: "licensed", licensedUntil: null })).toEqual({
    message: "Couldn't reach tuti.so. Try again in a few minutes.",
  });
});
