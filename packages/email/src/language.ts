import { DEFAULT_LANGUAGE, isLanguage, type Language } from "@tuti/shared";
import { MESSAGES, type Messages } from "@tuti/shared/messages";
import { createTranslator } from "use-intl/core";

/**
 * An email's language (docs/plan.md, Languages: "Emails to a reader are in one language"): the one its sender chose for the
 * reader, any it doesn't know (or none: the team's and Tuti's own emails) English.
 */
export const emailLanguage = (language?: string | null): Language => (language && isLanguage(language) ? language : DEFAULT_LANGUAGE);

/** The portal's messages (`@tuti/shared/messages`) in `language`, for an email's own words. */
export const emailTranslator = <N extends keyof Messages>(language: string | null | undefined, namespace: N) => {
  const locale = emailLanguage(language);
  return createTranslator({ locale, messages: MESSAGES[locale], namespace });
};
