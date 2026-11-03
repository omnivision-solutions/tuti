import { describe, expect, it } from "vitest";

import { takesFocus } from "./pull-request-chip";

describe("takesFocus", () => {
  const wanted = "/app/acme/autopilot/articles/a1";

  it("gives the chip row focus on the page it was asked on while focus is lost, however long its refresh took", () => {
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a1", true)).toBe(true);
  });

  it("never on another page (the next to review, opened instead), nor once something else has focus, nor unasked", () => {
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a2", true)).toBe(false);
    expect(takesFocus(wanted, "/app/acme/autopilot/articles/a1", false)).toBe(false);
    expect(takesFocus(null, "/app/acme/autopilot/articles/a1", true)).toBe(false);
  });
});
