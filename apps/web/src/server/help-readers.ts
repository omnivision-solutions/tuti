"use server";

import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { cookies, headers } from "next/headers";

import { portalUrl } from "@/lib/hosts";

import type { FormState } from "./form-state";
import { answerQuestion, askFields, type HelpAnswer, rateAnswer } from "./operations/help-ask";
import { answerFields, saveAnswer } from "./operations/help-insights";
import { OperationError } from "./operations";
import { getSession } from "./session";

/**
 * Readers' actions on the portal's help center: answering "Was this helpful?", counting
 * the view, and asking the AI. Anyone may, signed in or not; most help readers are anonymous.
 */

const READER_COOKIE = "tuti_reader";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Crawlers and link previews, by user agent. Most don't run the page's script, which counts views, anyway. */
const BOT = /bot|crawl|spider|slurp|preview/i;

/**
 * Who answers: the signed-in user, or else an anonymous reader known by a random id in a
 * first-party cookie (set on their first answer). That's the limit: one answer per reader
 * and article. Clearing cookies gets another; Tuti keeps no IP address to stop that.
 */
async function readerId(projectSlug: string) {
  const session = await getSession();
  if (session) {
    return session.user.id;
  }
  const jar = await cookies();
  const known = jar.get(READER_COOKIE)?.value;
  if (known && UUID.test(known)) {
    return known;
  }
  const id = randomUUID();
  jar.set(READER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: portalUrl(projectSlug).startsWith("https:"),
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return id;
}

/** "Yes" or "No" under article `slug`, then (after a "No") what was missing. Answering again replaces the answer. */
export async function answerArticle(projectSlug: string, slug: string, helpful: boolean, comment?: string): Promise<FormState> {
  const input = answerFields.safeParse({ slug, helpful, comment });
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  if (!project) {
    return { error: "Article not found" };
  }
  try {
    await saveAnswer(project.id, await readerId(String(projectSlug)), input.data);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  return {};
}

/** Counts a view of a published article: one counter per article and day (UTC). Skips crawlers. */
export async function countArticleView(projectSlug: string, slug: string): Promise<void> {
  if (BOT.test((await headers()).get("user-agent") ?? "")) {
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO article_view_day ("articleId", day, views)
    SELECT a.id, (now() AT TIME ZONE 'UTC')::date, 1
    FROM article a JOIN project p ON p.id = a."projectId"
    WHERE p.slug = ${String(projectSlug)} AND a.slug = ${String(slug)} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
    ON CONFLICT ("articleId", day) DO UPDATE SET views = article_view_day.views + 1`;
}

/** "Ask AI" on the portal's /help: an answer from the published articles, or "I don't know" (see help.ask). */
export async function askHelp(projectSlug: string, question: string): Promise<HelpAnswer | { error: string }> {
  const input = askFields.safeParse({ q: question });
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  if (!project) {
    return { error: "Help center not found" };
  }
  try {
    return await answerQuestion(project.id, await readerId(String(projectSlug)), input.data.q);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Thumbs up or down on an AI answer. Rating again replaces it. */
export async function rateHelpAnswer(projectSlug: string, questionId: string, helpful: boolean): Promise<FormState> {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
  if (!project) {
    return { error: "Help center not found" };
  }
  try {
    await rateAnswer(project.id, String(questionId), helpful === true);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  return {};
}
