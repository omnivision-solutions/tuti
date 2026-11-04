import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { type RangeKey, type ReportRange, reportRange } from "@/lib/report-range";

import { getMembership, isAdminRole } from "./membership";
import type { docsGaps } from "./operations/docs-insights";
import { type aiReport, type docsReport, type inboxReport, lockedRanges } from "./operations/reports";

/**
 * A Reporting page's project and range: `?range=` where the plan has it (the default otherwise), the ranges it doesn't (`locked`), and
 * whether the page shows made-up numbers (`sample`: a plan without Reporting, blurred behind a card saying so, ReportBody's `upgrade`),
 * so a project without Reporting is never sent its own.
 */
export async function reportingPage(slug: string, given: unknown) {
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { plan } = membership.project;
  const locked = lockedRanges(plan);
  const key = typeof given === "string" && !locked.includes(given as RangeKey) ? given : undefined;
  const sample = !planIncludes(plan, "reporting");
  return { membership, range: reportRange(key), locked, sample, upgrade: sample ? { slug, admin: isAdminRole(membership.role) } : null };
}

// Made-up numbers in the reports' shapes, for the blurred pages: the same each time, rising and falling over the range's days.

const wave = (days: string[], base: number, phase = 0) => days.map((_, i) => Math.round(base * (1 + 0.4 * Math.sin(i / 2 + phase))));
/** The previous days' total of a wave a little lower than the range's, so the tiles show a rise. */
const waveBefore = (range: ReportRange, base: number, phase = 0) => sum(wave(range.previous.days, base * 0.85, phase));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const at = (range: ReportRange) => range.until.toISOString();
const span = (range: ReportRange) => ({ since: range.since.toISOString(), until: at(range), days: range.days });

const ARTICLES = [
  ["getting-started", "Getting started", "Basics"],
  ["invite-your-team", "Invite your team", "Basics"],
  ["connect-a-domain", "Connect a domain", "Settings"],
  ["billing", "Billing and invoices", "Account"],
  ["export", "Export your data", null],
] as const;

export function sampleDocsReport(range: ReportRange): Awaited<ReturnType<typeof docsReport>> {
  const { days } = range;
  const daily = { views: wave(days, 120), searches: wave(days, 40, 1), failed: wave(days, 6, 2), helpful: wave(days, 9, 3), notHelpful: wave(days, 2, 4) };
  return {
    ...span(range),
    daily,
    totals: {
      views: sum(daily.views),
      searches: sum(daily.searches),
      failedSearches: sum(daily.failed),
      helpful: sum(daily.helpful),
      notHelpful: sum(daily.notHelpful),
      publishedArticles: ARTICLES.length,
    },
    before: {
      views: waveBefore(range, 120),
      searches: waveBefore(range, 40, 1),
      failedSearches: waveBefore(range, 6, 2),
      helpful: waveBefore(range, 9, 3),
      notHelpful: waveBefore(range, 2, 4),
    },
    searchesSince: null,
    articles: ARTICLES.map(([slug, title, collection], i) => ({ slug, title, collection, published: true, views: 900 - i * 170, helpful: 40 - i * 7, notHelpful: 3 + i })),
    comments: ["It doesn't say how to change the owner.", "A screenshot would help."].map((comment, i) => ({
      article: { slug: ARTICLES[i]![0], title: ARTICLES[i]![1] },
      comment,
      at: at(range),
    })),
    failedSearches: ["dark mode", "single sign-on", "rate limits"].map((query, i) => ({ query, count: 24 - i * 7, before: 0, dismissed: false })),
  };
}

export function sampleAiReport(range: ReportRange): Awaited<ReturnType<typeof aiReport>> {
  const daily = { handled: wave(range.days, 30), escalated: wave(range.days, 4, 2) };
  const handled = sum(daily.handled);
  const [handledBefore, escalatedBefore] = [waveBefore(range, 30), waveBefore(range, 4, 2)];
  const turn = (question: string) => ({ question, answer: "Open Settings, then…", status: "answered" as const, helpful: null, escalated: false, conversation: null });
  return {
    ...span(range),
    daily: {
      ...daily,
      answered: daily.handled,
      helpful: daily.handled.map((n) => Math.round(n / 4)),
      notHelpful: daily.handled.map((n) => Math.round(n / 20)),
      rated: daily.handled.map((n) => Math.round(n / 4) + Math.round(n / 20)),
    },
    totals: {
      conversations: handled + sum(daily.escalated),
      escalated: sum(daily.escalated),
      answered: handled,
      helpful: Math.round(handled / 4),
      notHelpful: Math.round(handled / 20),
      rated: Math.round(handled / 4) + Math.round(handled / 20),
    },
    before: {
      conversations: handledBefore + escalatedBefore,
      escalated: escalatedBefore,
      answered: handledBefore,
      helpful: Math.round(handledBefore / 4),
      notHelpful: Math.round(handledBefore / 20),
      rated: Math.round(handledBefore / 4) + Math.round(handledBefore / 20),
    },
    conversations: ["How do I invite my team?", "Can I export my data?", "Where are my invoices?"].map((question, i) => ({
      id: `sample-${i}`,
      lastAt: at(range),
      source: "widget" as const,
      asker: null,
      escalated: i === 2,
      answered: 1,
      helpful: i === 0 ? 1 : 0,
      notHelpful: 0,
      turns: [turn(question)],
    })),
    pastHistory: 0,
    listed: 3,
  };
}

export function sampleInboxReport(range: ReportRange): Awaited<ReturnType<typeof inboxReport>> {
  const created = wave(range.days, 12);
  const daily = { created, fromAi: created.map((n) => Math.round(n / 5)) };
  const conversations = sum(created);
  const before = waveBefore(range, 12);
  return {
    ...span(range),
    daily,
    totals: { conversations, fromAi: sum(daily.fromAi), replied: conversations, medianFirstReply: 2700, openNow: 8 },
    before: { conversations: before, fromAi: Math.round(before / 5), medianFirstReply: 3300 },
    origins: { widget: Math.round(conversations / 2), email: Math.round(conversations / 4), escalation: Math.round(conversations / 5), api: 0 },
    teammates: [
      { id: "sample-1", name: "Alex", replies: 140, conversations: 90 },
      { id: "sample-2", name: "Sam", replies: 85, conversations: 60 },
    ],
  };
}

export function sampleGaps(range: ReportRange): Awaited<ReturnType<typeof docsGaps>> {
  return ["Do you have a mobile app?", "How do I change the owner?", "Is there an API rate limit?"].map((question, i) => ({
    question,
    noAnswer: 9 - i * 3,
    notHelpful: i,
    escalated: i === 0 ? 2 : 0,
    lastAsked: at(range),
    answer: null,
    cause: "no_relevant_section" as const,
  }));
}
