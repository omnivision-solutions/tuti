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

/**
 * The portal's messages under `namespace` in this request's address's language (portalLanguage: the project's default on
 * its own addresses), for server components that don't have the project to hand (the docs' tree, tabs and pages);
 * English off the portal.
 */
export async function pageTranslator<N extends keyof Messages>(namespace: N) {
  const { language: address } = await portalLanguage();
  const language = address && isLanguage(address) ? address : DEFAULT_LANGUAGE;
  return { language, t: createTranslator({ locale: language, messages: MESSAGES[language], namespace }) };
}

/**
 * A reader's changelog language (docs/plan.md L16): their saved one where it's one of the portal's live languages; null
 * where it's the default. Undefined when this portal has none of theirs: none saved, or one it doesn't serve (saved on
 * another portal, taken offline, past the plan's limit), which isn't a choice made here.
 */
export async function subscriberLanguage(projectId: string, userId: string): Promise<string | null | undefined> {
  const [languages, user] = await Promise.all([portalLanguages(projectId), prisma.user.findUnique({ where: { id: userId }, select: { language: true } })]);
  const language = user?.language;
  if (language && language === languages.default) {
    return null;
  }
  return language && (languages.live as string[]).includes(language) ? language : undefined;
}

/**
 * A signed-in reader's language for their emails (docs/plan.md, Languages: "a signed-in reader's language, else the language
 * of the page they were asked for on"): one who never chose one (User.language, the header's switcher) gets the page's, when
 * they do something on a language's address that emails them (vote, comment, post, sign in with its link). Never over one
 * they chose; only for someone acting as themselves (`actor`: never an API key writing on someone's behalf, whatever headers
 * it sends); only a language the project has live (not the team's preview of one that isn't); nothing at the default
 * language's address.
 */
export async function rememberPageLanguage(actor: { kind: string; userId?: string }, userId: string, projectId: string) {
  if (actor.kind !== "user" || actor.userId !== userId) {
    return;
  }
  // Outside a request (an operation a job runs): no page, nothing to remember.
  const page = await portalLanguage().catch(() => null);
  const { language, prefix } = page ?? { language: null, prefix: "" };
  if (!prefix || !language || !(await portalLanguages(projectId)).live.includes(language)) {
    return;
  }
  await prisma.user.updateMany({ where: { id: userId, language: null }, data: { language } });
}
