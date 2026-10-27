import { describe, expect, it } from "vitest";
import { digest, keepWaiting } from "./pr-digest.mjs";

const head = "a".repeat(40);
const reviewed = "b".repeat(40);
const viewer = "maintainer";
const run = (name: string, conclusion: string | null = "success") => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
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
      const approval = review(6, "greptile-apps[bot]", "APPROVED", "2026-01-01T00:00:00Z", '<!-- greptile-auto-approve {"headSha":"a"} -->\n');
      expect(observe({ reviews: [approval] }).verdict).toBe("green");
    });

    it.each([
      ["coderabbitai[bot]", "<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"],
      ["greptile-apps[bot]", "To keep reviewing, [Reactivate Greptile](https://example.com)"],
      ["greptile-apps[bot]", "<h3>Greptile Summary</h3>"],
      ["github-actions[bot]", "<!-- tuti-e2e-screenshots -->\n### Screenshots"],
      ["github-actions[bot]", "@greptileai"],
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
