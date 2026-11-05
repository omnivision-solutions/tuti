import { codeChangesSettings, decisionsAvailable } from "@tuti/shared";
import { expect, test } from "vitest";

import { thresholds } from "./code-change-decisions";
import { ARTICLES, CASES, fixtureRepository } from "./code-change-eval";
import { decideDocs, type HelpCenterFixture, outlineMarkdown } from "./docs-agent";
import { closeTools, runTool, type ToolContext } from "./docs-agent-tools";

/**
 * The docs agent on the evaluation set (`pnpm test:live`, with OPENAI_API_KEY; CODE_CHANGES_DECIDE_MODEL and
 * CODE_CHANGES_REDECIDE_MODEL for others than the defaults), for real: each case's pull request on its fixture
 * repository, with the tools, and the set's articles as the help center. Each kind of verdict must match what a team
 * member would expect, with the propose cutoffs in use. Without the key it's skipped: "not run", never "passed". Prints
 * the agent's answers, to tune the cutoffs or compare models.
 */
// Chat with tools at OpenRouter (the default models are its ids), as the decisions evaluation beside it.
const live = decisionsAvailable();

/** The evaluation's spend isn't a project's. */
const meter = async () => {};

/** The set's articles, all published, in no collection; searching them lists them all (there are only a few). */
const articles = Object.entries(ARTICLES).map(([slug, [title]]) => ({ id: slug, slug, title, publishedAt: new Date(), collectionId: null }));
const helpCenter: HelpCenterFixture = {
  outline: outlineMarkdown({ collections: [], articles, waiting: [], cap: Infinity }),
  articles,
  collections: [],
  run: async (context, call) => {
    if (call.name === "read_article") {
      const slug = (JSON.parse(call.arguments || "{}") as { slug?: string }).slug ?? "";
      const article = ARTICLES[slug as keyof typeof ARTICLES];
      return article ? `Title: ${article[0]}\nState: published\n\n${article[1]}` : `There's no article or draft with the slug ${slug}.`;
    }
    if (call.name === "search_articles") {
      return ["slug\ttitle\tstate", ...Object.entries(ARTICLES).map(([slug, [title]]) => `${slug}\t${title}\tpublished`)].join("\n");
    }
    return runTool(context, call);
  },
};

const allowed = <T>(expected: T | T[], actual: T) => (Array.isArray(expected) ? expected.includes(actual) : expected === actual);

test.skipIf(!live)(`the docs agent with ${codeChangesSettings().decide.model}`, { timeout: 900_000 }, async () => {
  type Row = { kind: string; name: string; expected: unknown; got: unknown; answer: string; right: boolean };
  const rows: Row[] = [];
  await Promise.all(
    CASES.map(async (c) => {
      const context: ToolContext = { projectId: "evaluation", repository: fixtureRepository(c) };
      try {
        const decision = await decideDocs({ ...c.pr, mergeCommit: "fixture" }, context, meter, { fixture: helpCenter });
        const answer = [
          ...decision.edits.map((edit) => `edit ${edit.articleId} ${edit.problem} ${edit.probability.toFixed(2)}`),
          ...decision.newArticles.map((article) => `new "${article.title}" ${article.probability.toFixed(2)}`),
          `(${decision.model})`,
        ].join("; ");
        const edits = new Set(decision.edits.filter((edit) => edit.probability >= thresholds().ARTICLE_EDIT.maybe).map((edit) => edit.articleId));
        const newArticle = decision.newArticles.some((article) => article.probability >= thresholds().NEW_ARTICLE.maybe);
        if (!c.users) {
          rows.push({ kind: "internal", name: c.name, expected: "nothing", got: edits.size === 0 && !newArticle ? "nothing" : "docs", answer, right: edits.size === 0 && !newArticle });
        }
        for (const a of c.articles ?? []) {
          const got = edits.has(a.article) ? "ARTICLE_EDIT" : null;
          rows.push({ kind: "article", name: `${c.name}: ${a.article}`, expected: a.expect, got, answer, right: allowed(a.expect, got) });
        }
        if (c.newArticle !== undefined) {
          rows.push({ kind: "new article", name: c.name, expected: c.newArticle, got: newArticle, answer, right: allowed(c.newArticle, newArticle) });
        }
      } finally {
        await closeTools(context);
      }
    }),
  );
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  console.table(rows.map(({ right, ...row }) => ({ ...row, right: right ? "✓" : "✗" })));
  const accuracy = Object.fromEntries(
    ["internal", "article", "new article"].map((kind) => {
      const of = rows.filter((row) => row.kind === kind);
      return [kind, of.filter((row) => row.right).length / of.length];
    }),
  );
  console.log(codeChangesSettings().decide.model, accuracy);
  for (const [kind, value] of Object.entries(accuracy)) {
    expect({ kind, accuracy: value >= 0.8 }).toEqual({ kind, accuracy: true });
  }
});
