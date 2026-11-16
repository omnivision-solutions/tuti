import { render } from "@react-email/render";
import { expect, test, vi } from "vitest";

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

test("Autopilot's email: from Tuti Autopilot, what needs you first in a short subject, the updates by name under it, an overview's tiles, then each list's cards with how sure, edits as lines", async () => {
  const email = autopilotEmail(props);
  expect(email.fromName).toBe("Tuti Autopilot");
  expect(email.subject).toBe("1 needs you, 1 goes out in 24 hours · Email voters: the team's reply sent to the post's voters too");
  const [html, text] = await Promise.all([render(email.body), render(email.body, { plainText: true })]);
  // The preview, hidden: the line inboxes show under the subject.
  expect(html).toContain("Needs you: Signing in to a portal (missing info). Goes out in 24 hours: Email my voters (progress update). Done: Changelog (changelog line).");
  // The pull request and its title on top; the overview: a tile per list with anything in it, then each list under its heading, in that order.
  expect(text).toContain("Acme · acme/app#382");
  expect(html).toMatch(/<h1[^>]*>Email voters: the team&#x27;s reply sent to the post&#x27;s voters too<\/h1>/);
  const order = ["1 Needs your approval", "1 Auto-updating in 24 hours", "1 Only your team sees", "✋ Needs your approval", "⏳ Auto-updating", "📝 Only your team sees"];
  const at = order.map((line, i) => text.indexOf(line, i > 0 ? text.indexOf(order[i - 1]!) + 1 : 0));
  expect(at).not.toContain(-1);
  expect(text).not.toContain("Published already");
  // Each a card: its kind and title, how sure, then what it does. What only the team sees doesn't show its lines.
  expect(text).toMatch(/Missing info Signing in to a portal\s+92% sure\s+Publishes this edit/);
  expect(text).toMatch(/Changelog line Changelog\s+Wrote this line in the changelog's draft/);
  expect(text).not.toContain("+ Replies can be emailed to voters");
  expect(text).toContain("− Replies only show on the post.");
  expect(text).toContain("+ The team's replies are emailed to the post's voters.");
  expect(html).toContain("line-through");
  // Each button's link whole in plain text, not run into the next one's label.
  expect(text).toContain("https://app.example.com/act?token=approve Review first https://app.example.com/review?select=edit");
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
  try {
    vi.stubEnv("APP_URL", "https://tuti.example");
    expect(await render(autopilotEmail(props).body)).toContain('src="https://tuti.example/api/email-tuti.png"');
    vi.stubEnv("APP_URL", undefined);
    expect(await render(autopilotEmail(props).body)).not.toContain("email-tuti.png");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("several changes going out by themselves: each one's Publish now and Stop say which, by number (short enough not to wrap); the tile, when the first goes", async () => {
  const second = { ...props.changes[0]!, pullRequest: "acme/app#383", needsYou: [], done: [] };
  const text = await render(autopilotEmail({ ...props, changes: [props.changes[0]!, second], totals: { ...props.totals, goesOut: 2 } }).body, { plainText: true });
  expect(text).toContain("Publish #382 now");
  expect(text).toContain("Stop #383");
  expect(text).not.toContain("Publish acme/app#382 now");
  expect(text).toContain("2 Auto-updating, first in 24 hours");
});

test("two repositories' pull requests with one number: their buttons name the repository too", async () => {
  const second = { ...props.changes[0]!, pullRequest: "acme/ios#382", needsYou: [], done: [] };
  const text = await render(autopilotEmail({ ...props, changes: [props.changes[0]!, second], totals: { ...props.totals, goesOut: 2 } }).body, { plainText: true });
  expect(text).toContain("Publish acme/app#382 now");
  expect(text).toContain("Stop acme/ios#382");
});

test("what went out by itself shows what customers saw; what only the team sees, a line", async () => {
  const went = { kind: "Progress update", title: "Email my voters", fact: "In progress, with this comment", sure: 97, diff: [{ kind: "added" as const, text: "Live now" }] };
  const text = await render(autopilotEmail({ ...props, changes: [{ ...props.changes[0]!, wentOut: [went] }], totals: { ...props.totals, wentOut: 1 } }).body, { plainText: true });
  expect(text).toMatch(/✅ Published already\s+Progress update Email my voters\s+97% sure\s+In progress, with this comment\s+\+ Live now/);
  expect(text).not.toContain("+ Replies can be emailed to voters");
});

test("an update's card keeps its one-click buttons: Approve and Review first side by side, Publish now and Stop under what goes out, and its kind's colours", async () => {
  const html = await render(autopilotEmail(props).body);
  // The link's text, from its own <a href="…"> to its closing tag (plain search: the URLs aren't patterns).
  const button = (href: string) => {
    const start = html.indexOf(`<a href="${href}"`);
    return start < 0 ? null : html.slice(start, html.indexOf("</a>", start));
  };
  expect(button("https://app.example.com/act?token=approve")).toContain("Approve");
  expect(button("https://app.example.com/review?select=edit")).toContain("Review first");
  expect(button("https://app.example.com/act?token=publish")).toContain("Publish now");
  expect(button("https://app.example.com/act?token=stop")).toContain("Stop");
  // Two buttons in one row: cells side by side, not stacked.
  expect(html).toMatch(/Approve[\s\S]*?<\/td><td[^>]*>[\s\S]*?Review first/);
  // Out of date and missing info in the edit colour; a progress update in the progress colour.
  expect(html).toMatch(/color:#7d5002;background-color:#ebe5d9[^>]*>Missing info</);
  expect(html).toMatch(/color:#155aa7;background-color:#dce6f2[^>]*>Progress update</);
  // "+N more in Tuti" still links to Autopilot.
  const more = await render(autopilotEmail({ ...props, more: 3 }).body, { plainText: true });
  expect(more).toContain("+3 more in Tuti https://app.example.com/autopilot");
});
