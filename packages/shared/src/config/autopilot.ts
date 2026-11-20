import { z } from "zod";

/**
 * The config file's `autopilot` section: Autopilot's values for code changes (docs/plan.md, Autopilot's docs agent),
 * each a leaf with its default, type and range. So a server can tune Autopilot (another model with the values that suit
 * it) without a release. The leaves are the one definition: the section's schema is built from them, and a project's
 * Advanced tuning (code-changes-tuning.ts) reads their ranges. A new value is a new leaf below.
 */

/** A value: its check, default, range in words (and as numbers or options, for a project's Advanced tuning), and what it does. */
export type Leaf<V> = { schema: z.ZodType<V>; default: V; range: string; meaning: string; min?: number; max?: number; options?: readonly string[] };
type Tree = { [key: string]: Tree | Leaf<unknown> };

const probability = (value: number, meaning: string): Leaf<number> => ({
  schema: z.number().min(0).max(1),
  default: value,
  range: "a number from 0 to 1",
  meaning,
  min: 0,
  max: 1,
});

const integer = (value: number, min: number, max: number, meaning: string): Leaf<number> => ({
  schema: z.number().int().min(min).max(max),
  default: value,
  range: `a whole number from ${min} to ${max}`,
  meaning,
  min,
  max,
});

const enumSetting = <const T extends readonly [string, ...string[]]>(values: T, value: T[number], meaning: string): Leaf<T[number]> => ({
  schema: z.enum(values),
  default: value,
  range: `one of ${values.join(", ")}`,
  meaning,
  options: values,
});

const number = (value: number, min: number, max: number, meaning: string): Leaf<number> => ({
  schema: z.number().min(min).max(max),
  default: value,
  range: `a number from ${min} to ${max}`,
  meaning,
  min,
  max,
});

const model = (value: string, meaning: string, range = "a model id"): Leaf<string> => ({
  schema: z.string().max(200).regex(/^\S+$/),
  default: value,
  range,
  meaning,
});

const odds = (what: string, maybe: number, likely: number) => ({
  maybe: probability(maybe, `${what}: proposed, as "maybe", from this probability`),
  likely: probability(likely, `${what}: proposed as likely from this probability`),
});

export const CODE_CHANGES_SETTINGS = {
  decisions: {
    // The Decisions API model (bounded answers with probabilities), never a chat model: the docs agent's models are
    // their own sections.
    model: model(
      "nace-ai/drex-max",
      "The decision model, a Decisions API model through OpenRouter (not a chat model): it answers the gate, what a pull request does to posts and articles, and whether edits call for Verify. The default did best on code changes' evaluation set",
    ),
    gate: probability(0.5, "The probability that users see the change, below which there's nothing to do"),
    resolves: odds("Resolving a post", 0.4, 0.75),
    movesForward: odds("Moving a post forward", 0.4, 0.75),
    // Links aren't proposed for the team: one past autoLink is applied by itself, any other is dropped.
    links: {
      maybe: probability(0.65, "Linking a post: below this the pull request isn't linked to it at all (links are only applied by themselves, see `autopilot.decisions.autoLink`)"),
      likely: probability(0.85, "Linking a post: an applied link is labelled likely from this probability"),
    },
    autoLink: probability(0.95, 'A link Autopilot applies by itself from this probability (with "Link posts by itself" on); at least `autopilot.decisions.links.maybe`'),
  },
  propose: {
    // Chosen for the docs agent on the evaluation set.
    edit: odds("Editing an article", 0.5, 0.75),
    newArticle: odds("A new article", 0.3, 0.8),
  },
  context: {
    diffChars: integer(60_000, 1_000, 500_000, "The pull request's diff the docs agent and the writers read, in characters (the decision model at most 20,000 of it); files past it are only listed"),
    fileChars: integer(6_000, 500, 500_000, "One file's share of the diff at most, in characters"),
    bodyChars: integer(4_000, 0, 100_000, "The pull request's description it reads, in characters"),
    outlineArticles: integer(1_000, 50, 20_000, "The help center's articles and drafts the docs agent is shown at most (published ones first); it finds the rest with its search"),
  },
  // The docs agent's steps: decide, double-check new articles, write.
  decide: {
    model: model("anthropic/claude-haiku-5.5", "The docs agent's model: with the tools, it decides what each merged pull request means for the help center (which articles to fix, which new ones it needs) in one answer"),
    rounds: integer(12, 1, 50, "Its rounds of tool calls at most, before it must answer"),
    maxTokens: integer(6_000, 500, 64_000, "The most it writes in one reply, in tokens (the double-check's too)"),
    temperature: number(0, 0, 2, "Its temperature (the double-check's too): 0 for the steadiest answers"),
    reasoning: enumSetting(["off", "low", "medium", "high"], "off", "How much it thinks before each reply, as OpenRouter's reasoning effort (the double-check's too); off asks for none"),
  },
  redecide: {
    model: model(
      "anthropic/claude-sonnet-5.5",
      "The double-check's model: when the docs agent proposes a new article (see `autopilot.redecide.whenNewArticle`), it decides the pull request again from scratch, with the same tools, and its answer is used; it's also Checks' model on the Balanced level, which reviews every article edit. `off` skips both, and every article edit then asks first, except on a level whose `ai.levels` row or Custom setting gives Checks its own model",
      "a model id, or off",
    ),
    rounds: integer(12, 1, 50, "Its rounds of tool calls at most, before it must answer"),
    whenNewArticle: probability(0.2, "The double-check runs when the docs agent proposes a new article this sure or more"),
  },
  write: {
    model: model(
      "anthropic/claude-sonnet-5.5",
      "The model that writes each edit and new article, with the same tools, and Autopilot's other text (the summary, reasons, the changelog line) and Verify's. A project's own pick for Autopilot wins, then `ai.features.codeChanges`, then `ai.model`, then this",
    ),
    rounds: integer(10, 1, 50, "Its rounds of tool calls at most, for each edit or new article"),
    maxTokens: integer(6_000, 500, 64_000, "The most it writes in one reply, in tokens"),
  },
  // The tools' caps (docs-agent-tools.ts).
  tools: {
    listChars: integer(30_000, 1_000, 500_000, "List files: the answer's characters at most"),
    fileChars: integer(60_000, 1_000, 500_000, "Read a file: its characters at most"),
    searchLines: integer(60, 1, 1_000, "Search the code: the lines at most"),
    searchChars: integer(20_000, 1_000, 500_000, "Search the code: the answer's characters at most"),
    searchMs: integer(5_000, 100, 60_000, "Search the code: how long one search may take, in milliseconds (the model writes the pattern)"),
    articleChars: integer(20_000, 1_000, 500_000, "Read an article: its characters at most"),
    articles: integer(8, 1, 50, "Search articles: how many it finds when the model doesn't say"),
    maxArticles: integer(20, 1, 50, "Search articles: how many it finds at most"),
    embedMs: integer(30_000, 1_000, 300_000, "Search articles: how long one embeddings request may take, in milliseconds"),
  },
  // Server limits: never per project.
  limits: {
    timeoutMinutes: integer(10, 1, 60, "How long one pull request's analysis may take, in minutes; past it the analysis fails and is tried again"),
    callTimeoutSeconds: integer(120, 10, 900, "How long one request to the docs agent's models may take, in seconds"),
    concurrentAnalyses: integer(4, 1, 20, "How many pull requests the worker analyses at once, on the whole server (retries included); the rest wait their turn. Each holds a worker slot for up to the analysis's time limit, and its repository in memory"),
    archiveBytes: integer(50_000_000, 1_000_000, 1_000_000_000, "The repository's text the docs agent may read, in bytes; over it, it works from the diff (and the analysis says so)"),
    readBytes: integer(1_000_000_000, 1_000_000, 10_000_000_000, "The repository's archive unpacked, everything in it, in bytes at most"),
    fileBytes: integer(1_000_000, 10_000, 100_000_000, "One file in the repository, in bytes at most; bigger ones are left out"),
    downloadMs: integer(120_000, 5_000, 900_000, "How long downloading the repository may take, in milliseconds"),
  },
  verify: {
    after: probability(0.7, "How sure the decision model must be that edits piling up on an article call for Verify, before Autopilot starts one"),
  },
};

type Values<T> = T extends Leaf<infer V> ? V : { readonly [K in keyof T]: Values<T[K]> };
export type CodeChangesSettings = Values<typeof CODE_CHANGES_SETTINGS>;

const isLeaf = (node: Tree | Leaf<unknown>): node is Leaf<unknown> => "schema" in node;

/** A leaf's key, or each key under a branch: its schema, described with its range and defaulted, so a partly filled section keeps the other defaults. */
function section(node: Tree | Leaf<unknown>): z.ZodType {
  if (isLeaf(node)) {
    return node.schema.describe(`${node.meaning} (${node.range})`).default(node.default);
  }
  return z.strictObject(Object.fromEntries(Object.entries(node).map(([key, child]) => [key, section(child)]))).prefault({});
}

const key = (path: string[]) => `autopilot.${path.join(".")}`;

/** The checks between values, each naming the keys. */
function consistent(values: CodeChangesSettings, ctx: z.RefinementCtx) {
  const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  // A pair's maybe can't be above its likely: every proposal kept would read as likely.
  const pairs = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    const { maybe, likely } = node as { maybe?: unknown; likely?: unknown };
    if (typeof maybe === "number" && typeof likely === "number" && maybe > likely) {
      issue([...path, "maybe"], `${maybe} is above ${key([...path, "likely"])} (${likely}): it must be at most that`);
    }
    for (const [name, child] of Object.entries(node)) {
      pairs(child, [...path, name]);
    }
  };
  pairs(values, []);
  // A link is only kept from links.maybe: a bar for linking by itself under it would never be reached.
  const { autoLink, links } = values.decisions;
  if (autoLink < links.maybe) {
    issue(["decisions", "autoLink"], `${autoLink} is below ${key(["decisions", "links", "maybe"])} (${links.maybe}): links under that aren't kept, so it must be at least that`);
  }
  // Search articles' default count can't be above its most: each search would be cut to it without a word.
  const { articles, maxArticles } = values.tools;
  if (articles > maxArticles) {
    issue(["tools", "articles"], `${articles} is above ${key(["tools", "maxArticles"])} (${maxArticles}): it must be at most that`);
  }
}

export const autopilot = (section(CODE_CHANGES_SETTINGS) as z.ZodType<CodeChangesSettings>).superRefine(consistent);

/** The env var a leaf was read from before the config file: CODE_CHANGES_ and its path, camelCase as SNAKE_CASE. */
const variable = (path: string[]) => `CODE_CHANGES_${path.map((part) => part.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()).join("_")}`;

function replaced(node: Tree | Leaf<unknown>, path: string[]): [string, string][] {
  return isLeaf(node) ? [[variable(path), key(path)]] : Object.entries(node).flatMap(([name, child]) => replaced(child, [...path, name]));
}

/** The variables this section replaced (each CODE_CHANGES_ one, and DECISION_MODEL, the decision model's old name): setting one stops start-up (checkConfig). */
export const AUTOPILOT_REPLACED: Record<string, string> = {
  ...Object.fromEntries(replaced(CODE_CHANGES_SETTINGS, [])),
  DECISION_MODEL: key(["decisions", "model"]),
};

/** A leaf of the tree by its path ("decide.rounds"), for its range. */
export function settingLeaf(path: string): Leaf<unknown> {
  return path.split(".").reduce<Tree | Leaf<unknown>>((node, name) => (node as Tree)[name]!, CODE_CHANGES_SETTINGS as unknown as Tree) as Leaf<unknown>;
}
