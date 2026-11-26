import { afterEach, expect, test, vi } from "vitest";

import { translationPending } from "./conversation-translation";

afterEach(() => vi.unstubAllEnvs());

const message = {
  author: "USER",
  note: false,
  body: "Der Export-Knopf auf der Berichtsseite tut nichts.",
  teamText: null,
  language: null,
  translationError: null,
  conversation: { spam: false, language: null, project: { language: null, teamLanguage: null, translateConversations: true } },
};

test("the team's notices wait only for a translation the job is still to settle, never for one it skips without a word", () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-or-v1-test");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("TUTI_CONFIG", "");
  expect(translationPending(message)).toBe(true);
  // Settled: translated, failed, or found in the team's language.
  expect(translationPending({ ...message, teamText: "The export button does nothing." })).toBe(false);
  expect(translationPending({ ...message, translationError: "Out of credits" })).toBe(false);
  expect(translationPending({ ...message, language: "en" })).toBe(false);
  // Skipped: too short to tell with no language known, or in the team's; spam; the team's own; translation off.
  expect(translationPending({ ...message, body: "Danke!" })).toBe(false);
  expect(translationPending({ ...message, body: "Danke!", conversation: { ...message.conversation, language: "de" } })).toBe(true);
  expect(translationPending({ ...message, body: "Thanks!", conversation: { ...message.conversation, language: "en-GB" } })).toBe(false);
  expect(translationPending({ ...message, conversation: { ...message.conversation, spam: true } })).toBe(false);
  // The team's language unset: the project's default language, as the translate job takes it ("Danke!" in German to a German team).
  expect(translationPending({ ...message, body: "Danke!", conversation: { ...message.conversation, language: "de", project: { language: "de", teamLanguage: null, translateConversations: true } } })).toBe(false);
  // Nothing to translate (only a link): left as it is, without a word.
  expect(translationPending({ ...message, body: "https://example.com/reports/export-button-screenshot" })).toBe(false);
  expect(translationPending({ ...message, author: "TEAM" })).toBe(false);
  expect(translationPending({ ...message, conversation: { ...message.conversation, project: { language: null, teamLanguage: null, translateConversations: false } } })).toBe(false);
});
