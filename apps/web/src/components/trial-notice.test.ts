import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { daysLeft, TrialNotice } from "./trial-notice";

const now = new Date("2026-11-13T12:00:00Z");
const ahead = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

test("days left in a trial: a part of a day counts as one, and never fewer than one", () => {
  expect([daysLeft(ahead(7 * 24), now), daysLeft(ahead(6.5 * 24), now), daysLeft(ahead(1), now), daysLeft(ahead(-1), now)]).toEqual([7, 7, 1, 1]);
});

const text = (admin: boolean, ended: boolean) =>
  renderToStaticMarkup(createElement(TrialNotice, { projectSlug: "acme", trial: { endsAt: ahead(2.5 * 24), ended }, admin, now })).replaceAll("&#x27;", "'");

test("owners and admins get the way to Billing; a member sees the trial without it, and who can choose a plan once it ended", () => {
  expect(text(true, false)).toContain("3 days left in your trial.");
  expect(text(true, false)).toContain('href="/app/acme/settings/billing"');
  expect(text(false, false)).toContain("3 days left in your trial.");
  expect(text(false, false)).not.toContain("Choose a plan");
  expect(text(false, false)).not.toContain("owner or admin");
  expect(text(false, true)).toContain("Your trial has ended. An owner or admin can choose a plan.");
  expect(text(false, true)).not.toContain("settings/billing");
});
