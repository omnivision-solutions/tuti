import { expect, test } from "vitest";

import { emailLine } from "./autopilot-email-line";

const update = (id: string, status: string) => ({ id, status });

test("the email's line says what became of the updates it named, now, whether they're ticked or not", () => {
  expect(emailLine("named", ["a"], [update("a", "pending")])).toBe("the update it named waits for you: check it and approve.");
  expect(emailLine("likely", ["a", "b"], [update("a", "pending"), update("b", "pending")])).toBe("2 updates it named wait for you: check them and approve.");
  // Approved here (or elsewhere): decided, not "selected".
  expect(emailLine("likely", ["a"], [update("a", "applied")])).toBe("the updates it named were decided already.");
  // One it named changed since, or goes out by itself: not "decided".
  expect(emailLine("named", ["a"], [update("a", "stale")])).toBe("the update it named changed since: write it again, or dismiss it.");
  expect(emailLine("named", ["a"], [update("a", "scheduled")])).toBe("the updates it named go out by themselves (Publish now, or Stop).");
  // Nothing likely, but some wait.
  expect(emailLine("likely", [], [update("a", "pending")])).toBe("Autopilot isn't sure of any of these: tick the ones to approve.");
  expect(emailLine("named", ["gone"], [update("a", "pending")])).toBe("the updates it named were decided already.");
});
