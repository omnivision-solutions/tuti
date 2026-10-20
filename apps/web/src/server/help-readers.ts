"use server";

import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { cookies, headers } from "next/headers";

import { portalUrl } from "@/lib/hosts";
import { visibleArticleSql } from "@/lib/reader-groups";

import type { FormState } from "./form-state";
import { answerQuestion, askFields, type HelpAnswer, rateAnswer } from "./operations/help-ask";
import { escalateFields, escalateQuestion } from "./operations/help-escalate";
import { answerFields, saveAnswer } from "./operations/help-insights";
import { OperationError } from "./operations";
import { readableProject, readerGroups } from "./portal-access";
import { getSession } from "./session";

/**
 * Readers' actions on the portal's help center (and the widget's): answering "Was this helpful?", counting
 * the view, asking the AI, and passing its answer to a person. Anyone who may read the portal may, signed in or not; most help readers are anonymous.
 */

const READER_COOKIE = "tuti_reader";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Crawlers and link previews, by user agent. Most don't run the page's script, which counts views, anyway. */
const BOT = /bot|crawl|spider|slurp|preview/i;

/**
 * Who answers: the signed-in user, or else an anonymous reader known by a random id in a
 * first-party cookie (set on their first answer). That's the limit: one answer per reader
 * and article. Clearing cookies gets another; Tuti keeps no IP address to stop that.
 *
 * In the widget (an iframe on the customer's site) a Lax cookie is neither sent nor stored, so
 * there it's `SameSite=None` and partitioned (CHIPS): kept per embedding site, never shared
 * across sites. A browser that refuses even that gets a new id per question, which only the
 * project's hourly limit then counts.
 */
async function readerId(projectSlug: string, widget = false) {
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
    // SameSite=None and Partitioned need Secure (browsers accept it from http://localhost too).
    ...(widget ? { sameSite: "none", secure: true, partitioned: true } : { sameSite: "lax", secure: portalUrl(projectSlug).startsWith("https:") }),
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
  const project = await readableProject(projectSlug);
  if (!project) {
    return { error: "Article not found" };
  }
  try {
    await saveAnswer(project.id, await readerId(String(projectSlug)), input.data, await readerGroups(project.id));
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  return {};
}

/**
 * Counts a view of a published article whose page is served (listed everywhere or unlisted): one
 * counter per article and day (UTC). Skips crawlers.
 */
export async function countArticleView(projectSlug: string, slug: string): Promise<void> {
  const project = BOT.test((await headers()).get("user-agent") ?? "") ? null : await readableProject(projectSlug);
  if (!project) {
    return;
  }
  const groups = await readerGroups(project.id);
  await prisma.$executeRaw`
    INSERT INTO article_view_day ("articleId", day, views)
    SELECT a.id, (now() AT TIME ZONE 'UTC')::date, 1
    FROM article a JOIN project p ON p.id = a."projectId"
    WHERE p.slug = ${String(projectSlug)} AND a.slug = ${String(slug)} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
      AND a.listing IN ('EVERYWHERE', 'UNLISTED') AND ${visibleArticleSql(groups)}
    ON CONFLICT ("articleId", day) DO UPDATE SET views = article_view_day.views + 1`;
}

/** "Ask AI" on the portal's /help or in the widget: an answer from the published articles, or "I don't know" (see help.ask). */
export async function askHelp(projectSlug: string, question: string, from: "portal" | "widget" = "portal"): Promise<HelpAnswer | { error: string }> {
  const widget = from === "widget";
  const input = askFields.safeParse({ q: question });
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  const project = await readableProject(projectSlug);
  if (!project) {
    return { error: "Help center not found" };
  }
  try {
    return await answerQuestion(
      project.id,
      await readerId(String(projectSlug), widget),
      input.data.q,
      widget ? "WIDGET" : "PORTAL",
      await readerGroups(project.id),
    );
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Thumbs up or down on an AI answer. Rating again replaces it. */
export async function rateHelpAnswer(projectSlug: string, questionId: string, helpful: boolean): Promise<FormState> {
  const project = await readableProject(projectSlug);
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

/** "Ask a person" after an AI answer that didn't help: emails the question to the team (see help.escalate). Only the asker may. */
export async function escalateHelp(
  projectSlug: string,
  questionId: string,
  email: string,
  note: string,
  from: "portal" | "widget" = "portal",
): Promise<FormState> {
  const input = escalateFields.safeParse({ questionId, email, note });
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  const project = await readableProject(projectSlug);
  if (!project) {
    return { error: "Help center not found" };
  }
  try {
    await escalateQuestion(project.id, await readerId(String(projectSlug), from === "widget"), input.data, await headers());
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  return {};
}
