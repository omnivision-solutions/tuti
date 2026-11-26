import { expect, test } from "vitest";

import { reachSentence } from "./changelog-subscription";

test("where a subscriber stands, in the page's language: each state, the opted-out one included", () => {
  expect(reachSentence("gets", "Acme", "e2e-ada@example.com")).toBe("The changelog entries Acme emails to subscribers go to e2e-ada@example.com.");
  expect(reachSentence("opted-out", "Acme", "e2e-ada@example.com")).toBe("You've turned off all of Acme's emails, so its changelog isn't emailed to e2e-ada@example.com either.");
  expect(reachSentence("gets", "Acme", "e2e-ada@example.com", "de")).toBe("Die Changelog-Einträge, die Acme an Abonnenten mailt, gehen an e2e-ada@example.com.");
  expect(reachSentence("paused", "Acme", "e2e-ada@example.com", "de")).toBe(
    "Die Changelog-Einträge, die Acme an Abonnenten mailt, gehen an e2e-ada@example.com, sobald die derzeit pausierten E-Mails von Acme wieder aufgenommen werden.",
  );
  expect(reachSentence("unconfirmed", "Acme", "e2e-ada@example.com", "fr")).toBe("Les nouveautés de Acme ne sont pas envoyées à e2e-ada@example.com.");
  expect(reachSentence("private", "Acme", "e2e-ada@example.com", "ja")).toContain("e2e-ada@example.com");
  expect(reachSentence("opted-out", "Acme", "e2e-ada@example.com", "de")).toBe("Du hast alle E-Mails von Acme abbestellt, daher wird auch sein Changelog nicht an e2e-ada@example.com gemailt.");
});
