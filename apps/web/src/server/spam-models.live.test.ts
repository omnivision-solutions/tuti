import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { judgeSpam, type SpamInput, spamModels, spamModelsOn, spamSignals } from "./spam-models";

/**
 * The spam filter's model checks on the evaluation set (`pnpm test:live`, with OPENAI_API_KEY, an OpenRouter key; a
 * config file at TUTI_CONFIG with `spam.decisions.model` and `spam.chat.model` for others than the defaults), for real.
 * The checks stay watch-only (docs/plan.md, Inbox automation, W4) until this shows almost no real mail caught. Without
 * the key it's skipped: "not run", never "passed". Prints each answer, to tune the bands or compare models.
 *
 * Real labelled conversations never go in this repository: the set is the private evaluations repository's
 * (`spam/cases.json`, cloned into packages/jobs/src/evals/ as Autopilot's is), read when it's there. Here are only a few
 * made-up examples, so the case runs anywhere.
 */

type Case = { name: string; spam: boolean; sender: string; displayName?: string | null; subject: string; text: string; replyTo?: string | null };

const MADE_UP: Case[] = [
  { name: "a customer's bug", spam: false, sender: "kim@acme.example", displayName: "Kim Lee", subject: "Export fails", text: "Hi, exporting to CSV gives me an empty file since this morning. Can you look?" },
  { name: "a prospect", spam: false, sender: "sam@northwind.example", subject: "Pricing for 40 seats", text: "We're comparing tools for our support team of 40. Is there an annual discount?" },
  { name: "an angry user", spam: false, sender: "lee@contoso.example", subject: "!!!", text: "Your app deleted my notes AGAIN. Fix it or refund me." },
  { name: "an SEO pitch", spam: true, sender: "growth@rankfast.example", subject: "Get to #1 on Google", text: "Hi team, I noticed your site isn't ranking for key terms. Our agency guarantees page one in 30 days. Reply for a free audit." },
  {
    name: "phishing",
    spam: true,
    sender: "notice@secure-mail.example",
    displayName: "Facebook Admin",
    subject: "Your page will be disabled",
    text: "Your page violated our policies and will be disabled in 24 hours. Appeal now: https://bit.ly/fb-appeal-form",
    replyTo: "appeals@other.example",
  },
];

/** The private set, where it's cloned beside this checkout's Autopilot evaluation. */
const PRIVATE = new URL("../../../../packages/jobs/src/evals/spam/cases.json", import.meta.url);
const CASES: Case[] = existsSync(PRIVATE) ? (JSON.parse(readFileSync(PRIVATE, "utf8")) as Case[]) : MADE_UP;

/** The evaluation's spend isn't a project's. */
const meter = async () => {};

const inputOf = (c: Case): SpamInput => ({
  sender: c.sender,
  name: c.displayName ?? null,
  subject: c.subject,
  text: c.text,
  signals: spamSignals({ name: c.displayName ?? null, sender: c.sender, text: c.text, replyTo: c.replyTo }),
  guidance: "",
  examples: { spam: [], notSpam: [] },
});

test.skipIf(!spamModelsOn())(`spam checks with ${JSON.stringify(spamModels())}`, { timeout: 600_000 }, async () => {
  const rows: { name: string; expected: string; got: string; why: string }[] = [];
  // A few at a time: a large set mustn't hit the provider all at once.
  for (let i = 0; i < CASES.length; i += 5) {
    await Promise.all(
      CASES.slice(i, i + 5).map(async (c) => {
        const judgement = await judgeSpam(inputOf(c), spamModels(), meter);
        rows.push({ name: c.name, expected: c.spam ? "spam" : "not spam", got: judgement === null ? "no answer" : judgement.spam ? "spam" : "not spam", why: judgement?.why ?? "" });
      }),
    );
  }
  console.table(rows);
  const real = rows.filter((row) => row.expected === "not spam");
  const spam = rows.filter((row) => row.expected === "spam");
  const caught = real.filter((row) => row.got === "spam").length / Math.max(real.length, 1);
  const found = spam.filter((row) => row.got === "spam").length / Math.max(spam.length, 1);
  console.log(spamModels(), { realMailCaught: caught, spamFound: found });
  // What switching the checks on waits for: almost no real mail caught. How much spam they find is for tuning.
  expect(caught).toBeLessThanOrEqual(0.01);
});
