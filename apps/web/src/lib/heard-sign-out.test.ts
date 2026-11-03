import { expect, test } from "vitest";

import { heardSignOut } from "./heard-sign-out";

test("a sign-out counts as the page signing nobody in only for a listener that heard it coming", () => {
  const heard = heardSignOut();
  expect(heard({ signingOut: true })).toBe(false);
  expect(heard({ signedOut: true })).toBe(true);

  // Home shown again while an earlier sign-out was still on its way: that one's the earlier ask's answer.
  const late = heardSignOut();
  expect(late({ signedOut: true })).toBe(false);

  // Someone signing in since the sign-out began: it isn't who's here any more.
  const since = heardSignOut();
  since({ signingOut: true });
  expect(since({ pending: true })).toBe(false);
  expect(since({ signedOut: true })).toBe(false);
});
