import { describe, expect, it } from "vitest";

import { takesFocus } from "./pull-request-chip";

describe("takesFocus", () => {
  const wanted = { path: "/app/acme/autopilot/articles/a1", at: 1_000 };

  it("gives the chip row focus on the page it was asked on, once its refresh is in", () => {
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a1", 2_000)).toBe(true);
  });

  it("never on another page (the next to review, opened instead), nor long after, nor unasked", () => {
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a2", 2_000)).toBe(false);
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a1", 12_000)).toBe(false);
    expect(takesFocus(null, "/app/acme/autopilot/articles/a1", 2_000)).toBe(false);
  });
});
