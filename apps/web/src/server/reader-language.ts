"use server";

import { prisma } from "@tuti/db";
import { cookies } from "next/headers";

import { portalUrl } from "@/lib/hosts";
import { LANGUAGE_COOKIE, readerLanguage } from "@/lib/reader-language";

import type { FormState } from "./form-state";
import { pathIn } from "./docs-queries";
import { portalLanguages } from "./portal-language";
import { sessionIn } from "./session";

/**
 * The portal's header's switcher (docs/plan.md, Languages): the reader reads the portal in `code`, one of its live languages
 * or its default. Kept in this browser (a cookie, as long as the reader's id is), and on the reader if they're signed in, so
 * their other devices and emails follow. Anyone may, signed in or not: a private portal's sign-in page has the switcher too.
 * With the page it's chosen on (`from`, `path`: the portal's path without a prefix), `path` is the same page in `code`: an
 * article's at its slug there (pathIn).
 */
export async function chooseLanguage(projectSlug: string, code: string, at?: { from: string; path: string }): Promise<FormState & { path?: string }> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, language: true } });
  if (!project) {
    return { error: "Project not found" };
  }
  const language = String(code);
  if (readerLanguage(await portalLanguages(project.id), [language]) !== language) {
    return { error: "This portal isn't in that language" };
  }
  (await cookies()).set(LANGUAGE_COOKIE, language, {
    httpOnly: true,
    sameSite: "lax",
    secure: portalUrl(String(projectSlug)).startsWith("https:"),
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  const session = await sessionIn(project.id);
  if (session) {
    await prisma.user.update({ where: { id: session.user.id }, data: { language } });
  }
  return at ? { path: await pathIn(String(projectSlug), String(at.path), String(at.from), language, project.language) } : {};
}
