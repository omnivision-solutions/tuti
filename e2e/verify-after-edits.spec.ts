import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextDocsAgentAnswer, nextModelReply } from "./model";

test("two pull requests' edits piling up on an article: Autopilot starts Verify, and its history says why", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Change the theme ${id}`;
  const before = "Pick Light in Settings.";
  const { slug: articleSlug } = await api("/articles", { title: article, body: before });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);
  const snapshot = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({ repo: "acme/app", commit: "c0ffee1234567", files: { "src/theme.ts": "export const themes = ['light', 'dark', 'system'];" } }),
  });
  expect(snapshot.ok).toBe(true);

  // Each pull request edits the article's one section; the second rewrites what the first wrote.
  const numbers = [randomInt(1_000, 500_000), randomInt(500_000, 1_000_000)];
  for (const [i, text] of ["Pick Light or Dark in Settings.", "Pick Light, Dark or System in Settings."].entries()) {
    const pr = `Themes ${i + 1} ${id}`;
    const summary = `You can now pick more themes (${i + 1}, ${id}).`;
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
    await nextDocsAgentAnswer(numbers[i]!, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
    // The edit's reply first: the proposals' reply matches its request too.
    await nextModelReply(JSON.stringify({ reason: "It names the themes.", sections: { "1": text } }), article);
    await nextModelReply(JSON.stringify({ why: "", changelog: "More themes", proposals: {} }), summary);
    if (i === 1) {
      // Two edits wait now, one rewriting the other: it says Verify, which picks its files and finds the newest true.
      await nextDecision({ verify: 0.9 }, `"article":"${article}","pull_requests_edits_waiting":2`);
      await nextModelReply(JSON.stringify({ files: ["src/theme.ts"] }), article);
      await nextModelReply(JSON.stringify({ statements: [{ statement: "Light, Dark or System", verdict: "current", evidence: ["src/theme.ts"], note: "" }], reason: "", sections: {} }), article);
    }
    await mergePullRequest(installationId, { number: numbers[i]!, title: pr, files: [{ filename: "src/theme.ts", patch: "+'dark'" }] });
  }

  await owner.goto(`/app/${slug}/docs/${articleSlug}?verify`);
  const run = owner.getByRole("complementary", { name: "Article tools" }).getByRole("region", { name: /^Checked / });
  await expect(run).toContainText(`Started by Autopilot: 2 pull requests' edits wait on it, PR #${numbers[1]} rewriting a section an earlier one changed.`);
  await expect(run).toContainText("1 statement still true · 0 out of date · 0 it can't tell");
  await checkpoint(owner, "verify-started-by-autopilot", { fullPage: false });
});
