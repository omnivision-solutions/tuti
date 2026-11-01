import { render } from "@react-email/render";
import { expect, test } from "vitest";

import { autopilotEmail } from "./autopilot-email";

const props = {
  projectName: "Acme",
  changes: [
    {
      title: "Email voters: the team's reply sent to the post's voters too",
      pullRequest: "acme/app#382",
      summary: "Teams can now email their reply on a post to everyone who voted for it.",
      reviewUrl: "https://app.example.com/review?select=likely",
      publishUrl: "https://app.example.com/act?token=publish",
      stopUrl: "https://app.example.com/act?token=stop",
      needsYou: [
        {
          kind: "Missing info",
          title: "Signing in to a portal",
          fact: "Publishes this edit",
          sure: 92,
          diff: [
            { kind: "same" as const, text: "Open the portal and pick Sign in." },
            { kind: "removed" as const, text: "Replies only show on the post." },
            { kind: "added" as const, text: "The team's replies are emailed to the post's voters." },
          ],
          approveUrl: "https://app.example.com/act?token=approve",
          editUrl: "https://app.example.com/review?select=edit",
        },
      ],
      goesOut: [{ kind: "Progress update", title: "Email my voters", fact: "Marks it in progress, with this comment", goesOut: "in 24 hours" }],
      wentOut: [],
      done: [{ kind: "Changelog line", title: "Changelog", fact: "Wrote this line in the changelog's draft", diff: [{ kind: "added" as const, text: "Replies can be emailed to voters" }] }],
    },
  ],
  totals: { goesOut: 1, wentOut: 0, needsYou: 1, done: 1, first: "in 24 hours" },
  more: 0,
  autopilotUrl: "https://app.example.com/autopilot",
  accountUrl: "https://app.example.com/account",
};

test("Autopilot's email: from Tuti Autopilot, what needs you first in a short subject, the updates by name under it, a coloured overview, then each list with how sure, edits as lines", async () => {
  const email = autopilotEmail(props);
  expect(email.fromName).toBe("Tuti Autopilot");
  expect(email.subject).toBe("1 needs you, 1 goes out in 24 hours · Email voters: the team's reply sent to the post's voters too");
  const [html, text] = await Promise.all([render(email.body), render(email.body, { plainText: true })]);
  // The preview, hidden: the line inboxes show under the subject.
  expect(html).toContain("Needs you: Signing in to a portal (missing info). Goes out in 24 hours: Email my voters (progress update). Done: Changelog (changelog line).");
  // The overview: a tile per list with anything in it, then each list under its band, in that order.
  const order = ["✋ 1 Needs your approval", "⏳ 1 Auto-updating in 24 hours", "📝 1 Only your team sees", "✋ Needs your approval", "⏳ Auto-updating in 24 hours", "📝 Only your team sees"];
  const at = order.map((line, i) => text.indexOf(line, i > 0 ? text.indexOf(order[i - 1]!) + 1 : 0));
  expect(at).not.toContain(-1);
  expect(text).not.toContain("Published already");
  // How sure, by the title; what Autopilot did, a line each.
  expect(text).toMatch(/Signing in to a portal\s+92% sure\s+Missing info · Publishes this edit/);
  expect(text).toContain("Changelog · wrote this line in the changelog's draft");
  expect(text).toContain("− Replies only show on the post.");
  expect(text).toContain("+ The team's replies are emailed to the post's voters.");
  expect(html).toContain("line-through");
  // Each button's link whole in plain text, not run into the next one's label.
  expect(text).toContain("https://app.example.com/act?token=approve Edit https://app.example.com/review?select=edit");
  expect(text).toContain("https://app.example.com/act?token=publish Stop https://app.example.com/act?token=stop");
});

test("the preview says when each update goes out, not just the first", async () => {
  const goesOut = [
    { kind: "Changelog line", title: "Changelog", fact: "Writes this line", goesOut: "now" },
    { kind: "Progress update", title: "Email my voters", fact: "Marks it in progress", goesOut: "in 24 hours" },
  ];
  const email = autopilotEmail({ ...props, changes: [{ ...props.changes[0]!, needsYou: [], done: [], goesOut }], totals: { ...props.totals, goesOut: 2, needsYou: 0, first: "now" } });
  expect(await render(email.body)).toContain("Goes out now: Changelog (changelog line). Goes out in 24 hours: Email my voters (progress update).");
});

test("with nothing for customers, the subject counts everything done for the team (shown or not); the digest says what still waits", async () => {
  const drafts = { ...props, changes: [{ ...props.changes[0]!, needsYou: [], goesOut: [] }], totals: { goesOut: 0, wentOut: 0, needsYou: 0, done: 7, first: "" } };
  // The preview names what was done.
  expect(await render(autopilotEmail(drafts).body)).toContain("Done: Changelog (changelog line).");
  // All of them, not just the one shown.
  expect(autopilotEmail(drafts).subject).toBe("7 done for your team · Email voters: the team's reply sent to the post's voters too");
  expect(autopilotEmail({ ...props, digest: true, totals: { ...props.totals, needsYou: 3, pullRequests: 2 } }).subject).toBe("3 still need you · 2 pull requests");
});

test("the logo comes from the app (no SVG in email), and not at all without its address", async () => {
  const before = process.env.APP_URL;
  try {
    process.env.APP_URL = "https://tuti.example";
    expect(await render(autopilotEmail(props).body)).toContain('src="https://tuti.example/email-logo.png"');
    delete process.env.APP_URL;
    expect(await render(autopilotEmail(props).body)).not.toContain("email-logo.png");
  } finally {
    process.env.APP_URL = before;
  }
});
