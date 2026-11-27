import { existsSync, readFileSync } from "node:fs";

import { decisionsAvailable } from "@tuti/shared";
import { expect, test } from "vitest";

import { readMessage } from "./ai-turn";
import type { Turn } from "./operations/docs-ask";

/**
 * "Is this asking for a person?" (and "does it need a reply at all?") on the evaluation set (`pnpm test:live`, with OPENAI_API_KEY, an OpenRouter key), for
 * real: the decision model the AI's turn asks before it searches the docs (docs/plan.md, Inbox automation, W12). A user
 * who asks for a person and gets the AI again is the failure the plan is built against, so it must miss almost none;
 * calling a question a request for a person only hands one over early. Without the key it's skipped: "not run", never
 * "passed". Prints each answer.
 *
 * Real conversations never go in this repository: the set is the private evaluations repository's (`person/cases.json`,
 * cloned into packages/jobs/src/evals/ as the spam filter's is), read when it's there. Here are only a few made-up
 * examples, so the case runs anywhere.
 */

/** `reply`: whether it needs one (true unless said). */
type Case = { name: string; person: boolean; reply?: boolean; message: string; earlier?: Turn[] };

const MADE_UP: Case[] = [
  { name: "asks for a human", person: true, message: "Can I talk to a human please?" },
  { name: "asks for a call", person: true, message: "This isn't helping. Could someone from your team call me?" },
  { name: "after an answer", person: true, message: "a person please", earlier: [{ question: "How do I export?", answer: "Go to Settings → Export." }] },
  {
    name: "accepts an offer",
    person: true,
    message: "yes please",
    earlier: [{ question: "Can you refund my last invoice?", answer: "Our team handles refunds. Would you like me to connect you with someone?" }],
  },
  { name: "a question", person: false, message: "How do I invite my team?" },
  { name: "frustrated, no person", person: false, message: "Export is broken AGAIN, the file is empty. What now?" },
  { name: "thanks", person: false, reply: false, message: "Thanks, that worked!", earlier: [{ question: "How do I export?", answer: "Go to Settings → Export." }] },
];

/** The private set, where it's cloned beside this checkout's Autopilot evaluation. */
const PRIVATE = new URL("../../../../packages/jobs/src/evals/person/cases.json", import.meta.url);
const CASES: Case[] = existsSync(PRIVATE) ? (JSON.parse(readFileSync(PRIVATE, "utf8")) as Case[]) : MADE_UP;

/** The evaluation's spend isn't a project's: nothing is recorded. */
const meter = async () => {};

test.skipIf(!decisionsAvailable())("asking for a person, and needing a reply", { timeout: 600_000 }, async () => {
  const rows: { name: string; expected: boolean; got: boolean | "no answer"; needsReply: boolean; gotReply: boolean | "no answer" }[] = [];
  // A few at a time: a large set mustn't hit the provider all at once.
  for (let i = 0; i < CASES.length; i += 5) {
    await Promise.all(
      CASES.slice(i, i + 5).map(async (c) => {
        const read = await readMessage({ message: c.message, earlier: c.earlier ?? [] }, meter).catch(() => null);
        rows.push({ name: c.name, expected: c.person, got: read?.person ?? "no answer", needsReply: c.reply ?? true, gotReply: read?.needsReply ?? "no answer" });
      }),
    );
  }
  console.table(rows);
  // A run that proves nothing fails: a model that didn't answer (a wrong key, a model down).
  expect(rows.filter((row) => row.got === "no answer")).toEqual([]);
  const asked = rows.filter((row) => row.expected);
  const missed = asked.filter((row) => row.got !== true).length / Math.max(asked.length, 1);
  const early = rows.filter((row) => !row.expected && row.got === true).length / Math.max(rows.length - asked.length, 1);
  // A message that needs a reply and is taken for thanks is never answered: that one must be rare too.
  const unanswered = rows.filter((row) => row.needsReply && row.gotReply === false).length / Math.max(rows.filter((row) => row.needsReply).length, 1);
  console.log({ requestsForAPersonMissed: missed, questionsHandedOverEarly: early, repliesSkipped: unanswered });
  expect(unanswered).toBeLessThanOrEqual(0.02);
  expect(asked.length).toBeGreaterThan(0);
  expect(missed).toBeLessThanOrEqual(0.05);
  expect(early).toBeLessThanOrEqual(0.1);
});
