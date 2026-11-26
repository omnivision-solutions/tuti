import { vi } from "vitest";

/**
 * Pages and components render on their own in tests, without the root layout's English messages (app/layout.tsx): outside
 * any provider, next-intl's hooks answer in English, as the root layout's provider does, instead of throwing.
 */
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const { MESSAGES } = await import("@tuti/shared/messages");
  const outside = <T,>(hook: () => T, english: () => T) => {
    try {
      return hook();
    } catch {
      return english();
    }
  };
  return {
    ...actual,
    useTranslations: (namespace?: never) =>
      outside(
        () => actual.useTranslations(namespace),
        () => actual.createTranslator({ locale: "en", messages: MESSAGES.en, namespace }),
      ),
    useLocale: () => outside(actual.useLocale, () => "en" as const),
  };
});
