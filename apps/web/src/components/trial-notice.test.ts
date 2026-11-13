import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TrialNotice } from "./trial-notice";

const text = (admin: boolean, ended: boolean) =>
  renderToStaticMarkup(createElement(TrialNotice, { projectSlug: "acme", trial: { endsAt: new Date(Date.now() + 3 * 86_400_000 - 1000), ended }, admin })).replaceAll("&#x27;", "'");

test("owners and admins get the way to Billing; a member sees the trial without it, and who can choose a plan once it ended", () => {
  expect(text(true, false)).toContain("3 days left in your trial.");
  expect(text(true, false)).toContain('href="/app/acme/settings/billing"');
  expect(text(false, false)).toContain("3 days left in your trial.");
  expect(text(false, false)).not.toContain("Choose a plan");
  expect(text(false, false)).not.toContain("owner or admin");
  expect(text(false, true)).toContain("Your trial has ended. An owner or admin can choose a plan.");
  expect(text(false, true)).not.toContain("settings/billing");
});
