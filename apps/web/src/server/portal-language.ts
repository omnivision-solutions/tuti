import { prisma } from "@tuti/db";
import { DEFAULT_LANGUAGE, isLanguage, languageLimit } from "@tuti/shared";
import { MESSAGES, type Messages } from "@tuti/shared/messages";
import { createTranslator } from "next-intl";
import { cookies } from "next/headers";
import { cache } from "react";

import { LANGUAGE_COOKIE, type PortalLanguages, readerLanguage } from "@/lib/reader-language";
import { portalLanguage } from "@/server/portal-base";

/**
 * A project's default language and its live others, in the order added (the header's switcher lists them so). Past the plan's
 * limit (after a downgrade) only the oldest within it are live, as languages.get says.
 */
export const portalLanguages = cache(async (projectId: string): Promise<PortalLanguages> => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { plan: true, language: true, languages: { select: { code: true, live: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  const limit = languageLimit(project.plan);
  return {
    default: isLanguage(project.language) ? project.language : DEFAULT_LANGUAGE,
    // Counted among those offered only, as languages.get does.
    live: project.languages
      .filter(({ code }) => isLanguage(code))
      .filter(({ live }, index) => live && (limit === null || index < limit - 1))
      .map(({ code }) => code)
      .filter(isLanguage),
  };
});

/** The language this request's reader reads the portal in: this browser's choice, else their saved one if signed in (`userId`). */
export async function currentLanguage(projectId: string, userId: string | null) {
  const [languages, jar, user] = await Promise.all([
    portalLanguages(projectId),
    cookies(),
    userId ? prisma.user.findUnique({ where: { id: userId }, select: { language: true } }) : null,
  ]);
  return { languages, language: readerLanguage(languages, [jar.get(LANGUAGE_COOKIE)?.value, user?.language]) };
}

/**
 * The portal's messages under `namespace` in this page's language (its address's, L3; the project's default on its own
 * addresses), for its server components (next-intl's hooks need its plugin there, which the portal doesn't use), and that
 * `language` for dates and numbers (Intl). The same language the portal's layout gives its client components (PortalIntl).
 */
export async function portalTranslator<N extends keyof Messages>(projectId: string, namespace: N) {
  const [{ language: address }, languages] = await Promise.all([portalLanguage(), portalLanguages(projectId)]);
  const language = address && isLanguage(address) ? address : languages.default;
  return { language, t: createTranslator({ locale: language, messages: MESSAGES[language], namespace }) };
}
