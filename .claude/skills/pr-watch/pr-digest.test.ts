import { describe, expect, it } from "vitest";
import { digest, keepWaiting } from "./pr-digest.mjs";

const head = "a".repeat(40);
const reviewed = "b".repeat(40);
const viewer = "maintainer";
const run = (name: string, conclusion: string | null = "success") => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  started_at: "2026-01-01T00:00:00Z",
  html_url: `https://github.com/example/project/actions/runs/1/job/${name.length}`,
});
const user = (login: string) => ({ login, type: login.endsWith("[bot]") ? "Bot" : "User" });
const comment = (id: number, login: string, body: string, at = "2026-01-01T00:00:00Z", edited = at) => ({
  id,
  user: user(login),
  body,
  created_at: at,
  updated_at: edited,
  html_url: `https://github.com/example/project/pull/1#issuecomment-${id}`,
});
const inlineComment = (id: number, login: string, at: string, edited = at, replyTo?: number) => ({
  ...comment(id, login, "Handle the retry", at, edited),
  path: "src/a.ts",
  line: 3,
  in_reply_to_id: replyTo,
});
const thread = (rootId: number, isResolved: boolean) => ({ id: `T${rootId}`, isResolved, comments: { nodes: [{ databaseId: rootId }] } });
const review = (id: number, login: string, state: string, at: string, body = "") => ({
  id,
  user: user(login),
  state,
  body,
  submitted_at: at,
  html_url: `https://github.com/example/project/pull/1#pullrequestreview-${id}`,
});
const files = (...names: string[]) => names.map((filename) => ({ filename }));

// A green PR: CI and CodeRabbit passed on the head, nothing to answer.
function observe(changes: Record<string, unknown> = {}) {
  return digest({
    pr: { number: 1, state: "OPEN", headRefOid: head, headRefName: "topic", mergeable: "MERGEABLE", labels: [{ name: "review:coderabbit" }] },
    viewer,
    runs: [run("Unit tests"), run("CodeRabbit")],
    statuses: [],
    threads: [],
    inline: [],
    conversation: [],
    reviews: [],
    now: Date.parse("2026-01-01T00:10:00Z"),
    ...changes,
  });
}
const withLabel = (name?: string) => ({
  pr: { number: 1, state: "OPEN", headRefOid: head, headRefName: "topic", mergeable: "MERGEABLE", labels: name ? [{ name }] : [] },
});

describe("pr-digest", () => {
  it("is green when CI and the PR's bot passed on the head", () => {
    expect(observe().verdict).toBe("green");
  });

  it("counts a bot's commit status as its review", () => {
    expect(observe({ runs: [run("Unit tests")], statuses: [{ context: "CodeRabbit", state: "success" }] }).verdict).toBe("green");
  });

  describe("review bot", () => {
    it("treats a missing bot status as pending, not a pass", () => {
      const result = observe({ runs: [run("Unit tests")] });
      expect(result.verdict).toBe("pending");
      expect(result.lines).toContain("BOT CodeRabbit: missing on the head");
    });

    it("requires the labelled bot, not the other one", () => {
      const runs = [run("Unit tests"), run("CodeRabbit", "skipped")];
      expect(observe({ ...withLabel("review:greptile"), runs }).verdict).toBe("pending");
      expect(observe({ ...withLabel("review:greptile"), runs: [...runs, run("Greptile Review")] }).verdict).toBe("green");
    });

    it("waits while the bot reviews", () => {
      expect(observe({ runs: [run("Unit tests"), run("CodeRabbit", null)] }).verdict).toBe("pending");
    });

    describe("Greptile out of credits", () => {
      const greptile = { ...withLabel("review:greptile"), runs: [run("Unit tests")] };
      const swap = "gh pr edit 1 --remove-label review:greptile --add-label review:coderabbit && gh pr comment 1 --body '@coderabbitai review'";
      const bot = (result: { lines: string[] }) => result.lines.find((l) => l.startsWith("BOT"));

      it("waits 20 minutes for its review, then says to move the PR to CodeRabbit", () => {
        expect(observe(greptile).verdict).toBe("pending");
        const silent = observe({ ...greptile, now: Date.parse("2026-01-01T00:21:00Z") });
        expect(silent.verdict).toBe("no-bot");
        expect(bot(silent)).toBe(`BOT Greptile Review: silent for 21 minutes since the push or @greptileai. Don't wait: move the PR to CodeRabbit with ${swap}`);
        expect(keepWaiting({ ...silent, pending: 1 }, new Set(silent.keys))).toBe(false);
      });

      it("counts the 20 minutes from the latest @greptileai, and any reply since as an answer", () => {
        const now = Date.parse("2026-01-01T00:30:00Z");
        const mention = comment(50, viewer, "@greptileai review the latest", "2026-01-01T00:15:00Z");
        expect(observe({ ...greptile, now, conversation: [mention] }).verdict).toBe("pending");
        const reply = { ...review(52, "greptile-apps[bot]", "COMMENTED", "2026-01-01T00:12:00Z"), commit_id: head };
        expect(observe({ ...greptile, now: Date.parse("2026-01-01T00:25:00Z"), reviews: [reply] }).verdict).toBe("pending");
        // A late review of the previous commit isn't a reply about the head.
        expect(observe({ ...greptile, now: Date.parse("2026-01-01T00:25:00Z"), reviews: [{ ...reply, commit_id: reviewed }] }).verdict).toBe("no-bot");
      });

      it("says to move the PR right away when Greptile says it ran out of credits", () => {
        const notice = comment(53, "greptile-apps[bot]", "Your organization has run out of review credits. [Add credits](https://example.com) to resume code reviews.");
        const result = observe({ ...greptile, conversation: [notice] });
        expect(result.verdict).toBe("no-bot");
        expect(bot(result)).toBe(`BOT Greptile Review: it can't review (out of credits). Don't wait: move the PR to CodeRabbit with ${swap}`);
        // Asked again after the notice: it may have credits now.
        const asked = comment(54, viewer, "@greptileai", "2026-01-01T00:05:00Z");
        expect(observe({ ...greptile, conversation: [notice, asked] }).verdict).toBe("pending");
        // An earlier review that still counts needs no swap.
        const counted = observe({ ...greptile, conversation: [notice], earlier: { sha: reviewed, files: files("docs/plan.md") } });
        expect(counted.verdict).toBe("green");
        expect(bot(counted)).toContain("only tests and docs changed since");
      });

      it("expires a notice once Greptile reviews or comments again, and reads one posted as a review on an earlier commit", () => {
        const notice = review(56, "greptile-apps[bot]", "COMMENTED", "2026-01-01T00:01:00Z", "To keep reviewing, [Reactivate Greptile](https://example.com)");
        expect(observe({ ...greptile, reviews: [{ ...notice, commit_id: reviewed }] }).verdict).toBe("no-bot");
        const later = { ...review(57, "greptile-apps[bot]", "APPROVED", "2026-01-01T00:02:00Z"), commit_id: reviewed };
        expect(observe({ ...greptile, reviews: [{ ...notice, commit_id: reviewed }, later] }).verdict).toBe("pending");
        const summary = comment(59, "greptile-apps[bot]", "<h3>Greptile Summary</h3>", "2026-01-01T00:02:00Z");
        expect(observe({ ...greptile, reviews: [{ ...notice, commit_id: reviewed }], conversation: [summary] }).verdict).toBe("pending");
      });

      it("times silence from the latest @greptileai when no check has registered", () => {
        const mention = comment(58, viewer, "@greptileai", "2026-01-01T00:00:00Z");
        const result = observe({ ...greptile, runs: [], conversation: [mention], now: Date.parse("2026-01-01T00:21:00Z") });
        expect(result.verdict).toBe("no-bot");
        expect(observe({ ...greptile, runs: [], now: Date.parse("2026-01-01T09:00:00Z") }).verdict).toBe("pending");
        const queued = { ...run("Lint", null), started_at: null };
        expect(observe({ ...greptile, runs: [queued], conversation: [mention], now: Date.parse("2026-01-01T00:21:00Z") }).verdict).toBe("no-bot");
      });

      it("doesn't take a finding that quotes the notice for the notice", () => {
        const finding = review(55, "greptile-apps[bot]", "COMMENTED", "2026-01-01T00:05:00Z", "LOCKOUT misses the text 'run out of review credits' when it wraps");
        expect(observe({ ...greptile, reviews: [{ ...finding, commit_id: head }] }).verdict).toBe("open-comments");
      });
    });

    it("reports an unlabelled PR as having no bot", () => {
      expect(observe(withLabel()).verdict).toBe("no-bot");
    });

    it("accepts an earlier review when only tests and docs changed since", () => {
      const runs = [run("Unit tests")];
      const earlier = { sha: reviewed, files: files("docs/plan.md", "e2e/a.spec.ts", "apps/web/src/a.db.test.ts", ".claude/skills/x/SKILL.md") };
      expect(observe({ runs, earlier }).verdict).toBe("green");

      const result = observe({ runs, earlier: { sha: reviewed, files: files("docs/plan.md", "apps/web/src/a.ts") } });
      expect(result.verdict).toBe("pending");
      expect(result.lines.find((l: string) => l.startsWith("BOT"))).toContain("changed since: apps/web/src/a.ts.");
    });

    it("counts a file moved into docs as a code change", () => {
      const earlier = { sha: reviewed, files: [{ filename: "docs/a.ts", previous_filename: "apps/web/src/a.ts" }] };
      expect(observe({ runs: [run("Unit tests")], earlier }).verdict).toBe("pending");
    });

    it("doesn't wait for the bot's new review when the earlier one counts", () => {
      const earlier = { sha: reviewed, files: files("docs/plan.md") };
      expect(observe({ runs: [run("Unit tests"), run("CodeRabbit", null)], earlier }).verdict).toBe("green");
      const statuses = [{ context: "CodeRabbit", state: "pending" }];
      expect(observe({ runs: [run("Unit tests")], statuses, earlier }).verdict).toBe("green");
    });
  });

  describe("checks", () => {
    it("fails on a failed check run or commit status", () => {
      expect(observe({ runs: [run("Unit tests", "failure"), run("CodeRabbit")] }).verdict).toBe("failures");
      expect(observe({ statuses: [{ context: "deploy", state: "error" }] }).verdict).toBe("failures");
    });

    it("waits when no check has registered yet", () => {
      expect(observe({ runs: [], statuses: [{ context: "CodeRabbit", state: "success" }] }).verdict).toBe("pending");
    });
  });

  describe("comments", () => {
    const root = inlineComment(10, "reviewer", "2026-01-01T00:00:00Z");
    const reply = inlineComment(11, viewer, "2026-01-02T00:00:00Z", undefined, 10);

    it("blocks an unresolved thread even after a reply", () => {
      expect(observe({ inline: [root, reply], threads: [thread(10, false)] }).verdict).toBe("open-comments");
      expect(observe({ inline: [root, reply], threads: [thread(10, true)] }).verdict).toBe("green");
    });

    it("needs a reply to a person's follow-up, not a bot's", () => {
      const followUp = (login: string) => inlineComment(12, login, "2026-01-03T00:00:00Z", undefined, 10);
      const open = observe({ inline: [root, reply, { ...followUp("reviewer"), body: "And the timeout?" }], threads: [thread(10, true)] });
      expect(open.verdict).toBe("open-comments");
      expect(open.lines).toContain("  And the timeout?");
      expect(observe({ inline: [root, reply, followUp("coderabbitai[bot]")], threads: [thread(10, true)] }).verdict).toBe("green");
      const answer = inlineComment(13, viewer, "2026-01-04T00:00:00Z", undefined, 10);
      expect(observe({ inline: [root, reply, followUp("reviewer"), answer], threads: [thread(10, true)] }).verdict).toBe("green");
    });

    it("blocks a resolved thread with no reply", () => {
      expect(observe({ inline: [root], threads: [thread(10, true)] }).verdict).toBe("open-comments");
    });

    it("reopens a person's comment edited after the reply, not a bot's", () => {
      const edited = { ...root, updated_at: "2026-01-03T00:00:00Z" };
      expect(observe({ inline: [edited, reply] }).verdict).toBe("open-comments");
      const botEdited = { ...edited, user: user("coderabbitai[bot]") };
      expect(observe({ inline: [botEdited, reply] }).verdict).toBe("green");
    });

    it("answers a conversation comment only with a later comment quoting its permalink", () => {
      const question = comment(20, "reviewer", "Why this?");
      const answer = (body: string) => comment(21, viewer, body, "2026-01-02T00:00:00Z");
      expect(observe({ conversation: [question] }).verdict).toBe("open-comments");
      expect(observe({ conversation: [question, answer(`Because. ${question.html_url}.`)] }).verdict).toBe("green");
      expect(observe({ conversation: [question, answer(`${question.html_url}1`)] }).verdict).toBe("open-comments");
      expect(observe({ conversation: [question, answer("#issuecomment-20")] }).verdict).toBe("open-comments");
      const botEdited = { ...comment(20, "greptile-apps[bot]", "Why this?"), updated_at: "2026-01-03T00:00:00Z" };
      expect(observe({ conversation: [botEdited, answer(question.html_url)] }).verdict).toBe("green");
    });

    it("needs a reply to a review body with findings, quoting its permalink", () => {
      const outside = review(5, "coderabbitai[bot]", "COMMENTED", "2026-01-01T00:00:00Z", "**Actionable comments posted: 1**\n<details><summary>⚠️ Outside diff range comments (1)</summary>…</details>");
      const open = observe({ reviews: [outside] });
      expect(open.verdict).toBe("open-comments");
      expect(open.lines.join("\n")).toContain("Outside diff range comments (1)…");
      expect(observe({ reviews: [review(5, "reviewer", "COMMENTED", "2026-01-01T00:00:00Z", "Split this up")] }).verdict).toBe("open-comments");
      const answer = comment(21, viewer, `Fixed: ${outside.html_url}`, "2026-01-02T00:00:00Z");
      expect(observe({ reviews: [outside], conversation: [answer] }).verdict).toBe("green");
      const header = review(5, "coderabbitai[bot]", "COMMENTED", "2026-01-01T00:00:00Z", "**Actionable comments posted: 2**");
      expect(observe({ reviews: [header] }).verdict).toBe("green");
      const person = review(7, "reviewer", "COMMENTED", "2026-01-01T00:00:00Z", "Looks fine");
      const answered = comment(22, viewer, person.html_url, "2026-01-02T00:00:00Z");
      expect(observe({ reviews: [person], conversation: [answered] }).verdict).toBe("green");
      expect(observe({ reviews: [{ ...person, edited_at: "2026-01-03T00:00:00Z" }], conversation: [answered] }).verdict).toBe("open-comments");
      expect(observe({ reviews: [{ ...outside, edited_at: "2026-01-03T00:00:00Z" }], conversation: [answer] }).verdict).toBe("green");
      const collapsed = review(8, "reviewer", "COMMENTED", "2026-01-01T00:00:00Z", "<details><summary>One question</summary>Why poll?</details>");
      expect(observe({ reviews: [collapsed] }).verdict).toBe("open-comments");
      const approval = review(6, "greptile-apps[bot]", "APPROVED", "2026-01-01T00:00:00Z", '<!-- greptile-auto-approve {"headSha":"a"} -->\n');
      expect(observe({ reviews: [approval] }).verdict).toBe("green");
    });

    it.each([
      ["coderabbitai[bot]", "<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"],
      ["coderabbitai[bot]", "<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: v2:0 -->\n<details><summary>Action performed</summary>Review triggered.</details>"],
      ["greptile-apps[bot]", "To keep reviewing, [Reactivate Greptile](https://example.com)"],
      ["greptile-apps[bot]", "Your organization has run out of review credits. [Add credits](https://example.com) to resume code reviews."],
      ["greptile-apps[bot]", "<h3>Greptile Summary</h3>"],
      ["github-actions[bot]", "<!-- tuti-e2e-screenshots -->\n### Screenshots"],
      ["github-actions[bot]", "@greptileai"],
      ["github-actions[bot]", "@coderabbitai review"],
      ["reviewer", "@coderabbitai review"],
    ])("skips %s chrome", (login, body) => {
      expect(observe({ conversation: [comment(30, login, body)] }).verdict).toBe("green");
    });

    it("doesn't skip the same text from a person or a real bot finding", () => {
      expect(observe({ conversation: [comment(30, "reviewer", "<!-- tuti-e2e-screenshots -->\n### Screenshots")] }).verdict).toBe("open-comments");
      expect(observe({ conversation: [comment(30, "coderabbitai[bot]", "Please fix this")] }).verdict).toBe("open-comments");
      expect(observe({ conversation: [comment(30, "github-actions[bot]", "@greptileai the deploy step failed")] }).verdict).toBe("open-comments");
    });

    it("blocks a change request until that reviewer approves", () => {
      const changes = review(1, "reviewer", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z");
      expect(observe({ reviews: [changes] }).verdict).toBe("open-comments");
      expect(observe({ reviews: [changes, review(2, "reviewer", "COMMENTED", "2026-01-02T00:00:00Z")] }).verdict).toBe("open-comments");
      expect(observe({ reviews: [changes, review(2, "reviewer", "APPROVED", "2026-01-02T00:00:00Z")] }).verdict).toBe("green");
    });

    it("strips markup and terminal controls from bodies", () => {
      const body = "<!-- marker -->Fix \x1b]0;title\x07 this<details><summary>Prompt</summary>long</details> now &lt;slug&gt;";
      const result = observe({ conversation: [comment(40, "reviewer", body)] });
      expect(result.lines).toContain("  Fix ]0;title this now <slug>");
    });
  });

  it("is out of sync when the local branch, the head or the base disagree", () => {
    expect(observe({ local: { sha: reviewed, upstream: head } }).verdict).toBe("out-of-sync");
    expect(observe({ local: { sha: head, upstream: "" } }).verdict).toBe("green");
    expect(observe({ headMoved: true }).verdict).toBe("out-of-sync");
    expect(observe({ pr: { ...withLabel("review:coderabbit").pr, mergeable: "CONFLICTING" } }).verdict).toBe("out-of-sync");
  });

  describe("--watch", () => {
    it("keeps waiting on known findings, wakes on a new one or when nothing is pending", () => {
      const running = { runs: [run("Unit tests", null), run("CodeRabbit")] };
      const before = observe({ ...running, conversation: [comment(20, "reviewer", "Why?")] });
      const seen = new Set<string>(before.keys);
      expect(keepWaiting(before, seen)).toBe(true);
      expect(keepWaiting(observe({ ...running, conversation: [comment(20, "reviewer", "Why?"), comment(21, "reviewer", "And?")] }), seen)).toBe(false);
      expect(keepWaiting(observe({ ...running, runs: [run("Unit tests", "failure"), run("CodeRabbit", null)] }), seen)).toBe(false);
      expect(keepWaiting(observe(), seen)).toBe(false);
    });
  });
});
