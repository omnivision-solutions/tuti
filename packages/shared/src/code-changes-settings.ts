import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

import { log } from "./log";

/**
 * Autopilot's values for code changes (docs/plan.md, Autopilot's docs agent): each one a setting
 * with its default, type and range, read from its own environment variable, named from its path
 * (`decisions.movesForward.maybe` → CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE). So a server can
 * tune Autopilot (another model with the values that suit it) without a release. A new value is a
 * new leaf below: its variable, its check at start-up and its row in the README follow.
 */

/** A value: its check, default, range in words (and as numbers or options, for a project's Advanced tuning), and what it does. */
type Leaf<V> = { schema: z.ZodType<V>; default: V; range: string; meaning: string; alias?: string; min?: number; max?: number; options?: readonly string[] };
type Tree = { [key: string]: Tree | Leaf<unknown> };

const probability = (value: number, meaning: string): Leaf<number> => ({
  schema: z.coerce.number().min(0).max(1),
  default: value,
  range: "a number from 0 to 1",
  meaning,
  min: 0,
  max: 1,
});

const integer = (value: number, min: number, max: number, meaning: string): Leaf<number> => ({
  schema: z.coerce.number().int().min(min).max(max),
  default: value,
  range: `a whole number from ${min} to ${max}`,
  meaning,
  min,
  max,
});

/** For a section that needs one (and for tests): one of a few named values. */
export const enumSetting = <const T extends readonly [string, ...string[]]>(values: T, value: T[number], meaning: string): Leaf<T[number]> => ({
  schema: z.enum(values),
  default: value,
  range: `one of ${values.join(", ")}`,
  meaning,
  options: values,
});

/** For a section that needs one (and for tests): true or false. */
export const booleanSetting = (value: boolean, meaning: string): Leaf<boolean> => ({
  schema: z.enum(["true", "false"]).transform((raw) => raw === "true"),
  default: value,
  range: "true or false",
  meaning,
});

const number = (value: number, min: number, max: number, meaning: string): Leaf<number> => ({
  schema: z.coerce.number().min(min).max(max),
  default: value,
  range: `a number from ${min} to ${max}`,
  meaning,
  min,
  max,
});

const model = (value: string, meaning: string, alias?: string, range = "a model id"): Leaf<string> => ({
  schema: z.string().max(200).regex(/^\S+$/),
  default: value,
  range,
  meaning,
  ...(alias && { alias }),
});

const odds = (what: string, maybe: number, likely: number) => ({
  maybe: probability(maybe, `${what}: proposed, as "maybe", from this probability`),
  likely: probability(likely, `${what}: proposed as likely from this probability`),
});

export const CODE_CHANGES_SETTINGS = {
  decisions: {
    // The Decisions API model (bounded answers with probabilities), never a chat model: the docs agent's models are
    // their own sections. DECISION_MODEL, its old name, is an alias of this one only.
    model: model(
      "nace-ai/drex-max",
      "The decision model, a Decisions API model through OpenRouter (not a chat model): it answers the gate, what a pull request does to posts and articles, and whether edits call for Verify. The default did best on code changes' evaluation set. `DECISION_MODEL` still works; this wins if both are set",
      "DECISION_MODEL",
    ),
    gate: probability(0.5, "The probability that users see the change, below which there's nothing to do"),
    resolves: odds("Resolving a post", 0.4, 0.75),
    movesForward: odds("Moving a post forward", 0.4, 0.75),
    // Links aren't proposed for the team: one past autoLink is applied by itself, any other is dropped.
    links: {
      maybe: probability(0.65, "Linking a post: below this the pull request isn't linked to it at all (links are only applied by themselves, see `CODE_CHANGES_DECISIONS_AUTO_LINK`)"),
      likely: probability(0.85, "Linking a post: an applied link is labelled likely from this probability"),
    },
    autoLink: probability(0.95, 'A link Autopilot applies by itself from this probability (with "Link posts by itself" on); at least `CODE_CHANGES_DECISIONS_LINKS_MAYBE`'),
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
      "The double-check's model: when the docs agent proposes a new article (see `CODE_CHANGES_REDECIDE_WHEN_NEW_ARTICLE`), it decides the pull request again from scratch, with the same tools, and its answer is used. `off` skips the double-check",
      undefined,
      "a model id, or off",
    ),
    rounds: integer(12, 1, 50, "Its rounds of tool calls at most, before it must answer"),
    whenNewArticle: probability(0.2, "The double-check runs when the docs agent proposes a new article this sure or more"),
  },
  write: {
    model: model(
      "anthropic/claude-sonnet-5.5",
      "The model that writes each edit and new article, with the same tools, and Autopilot's other text (the summary, reasons, the changelog line) and Verify's. A project's own pick for Autopilot wins, then `AI_MODEL_CODE_CHANGES`, then `AI_MODEL`, then this",
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

const PREFIX = "CODE_CHANGES_";

/** A setting's variable: CODE_CHANGES_ and its path, camelCase as SNAKE_CASE. */
export function settingName(path: readonly string[]): string {
  return PREFIX + path.map((part) => part.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()).join("_");
}

const isLeaf = (node: Tree | Leaf<unknown>): node is Leaf<unknown> => "schema" in node;

/** The tree with each leaf replaced by what `visit` makes of it. */
function walk(node: Tree | Leaf<unknown>, path: string[], visit: (leaf: Leaf<unknown>, name: string) => unknown): unknown {
  if (isLeaf(node)) {
    return visit(node, settingName(path));
  }
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child, [...path, key], visit)]));
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/**
 * Reads the settings from `env` (a blank variable is unset). Throws, naming each bad variable, its
 * value and what it must be. Returns the values, every variable's value in use (a changed one with
 * its default) and the CODE_CHANGES_ variables that name no setting, each with the nearest name.
 */
export function readCodeChangesSettings<T extends Tree = typeof CODE_CHANGES_SETTINGS>(
  env: NodeJS.ProcessEnv = process.env,
  tree: T = CODE_CHANGES_SETTINGS as unknown as T,
): { values: Values<T>; inUse: Record<string, string>; unknown: { name: string; nearest: string }[] } {
  const errors: string[] = [];
  const inUse: Record<string, string> = {};
  const values = walk(tree, [], (leaf, name) => {
    // The variable the value comes from: its own, else its old name (an alias), so a message names the one that's set.
    const from = env[name]?.trim() ? name : leaf.alias && env[leaf.alias]?.trim() ? leaf.alias : undefined;
    const raw = from && env[from]!.trim();
    if (!from || !raw) {
      inUse[name] = String(leaf.default);
      return leaf.default;
    }
    const parsed = leaf.schema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`${from} is "${raw}": it must be ${leaf.range}`);
      return leaf.default;
    }
    const via = from === name ? "" : `, from ${from}`;
    inUse[name] = parsed.data === leaf.default ? `${String(parsed.data)}${via}` : `${String(parsed.data)} (changed${via}; default ${String(leaf.default)})`;
    return parsed.data;
  }) as Values<T>;
  // A pair's maybe can't be above its likely: every proposal kept would read as likely.
  const pairs = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    const { maybe, likely } = node as { maybe?: unknown; likely?: unknown };
    if (typeof maybe === "number" && typeof likely === "number" && maybe > likely) {
      errors.push(`${settingName([...path, "maybe"])} (${maybe}) is above ${settingName([...path, "likely"])} (${likely}): it must be at most that`);
    }
    for (const [key, child] of Object.entries(node)) {
      pairs(child, [...path, key]);
    }
  };
  pairs(values, []);
  // A link is only kept from links.maybe: a bar for linking by itself under it would never be reached.
  const decisions = (values as { decisions?: { autoLink?: number; links?: { maybe?: number } } }).decisions;
  if (decisions?.autoLink !== undefined && decisions.links?.maybe !== undefined && decisions.autoLink < decisions.links.maybe) {
    errors.push(
      `${settingName(["decisions", "autoLink"])} (${decisions.autoLink}) is below ${settingName(["decisions", "links", "maybe"])} (${decisions.links.maybe}): links under that aren't kept, so it must be at least that`,
    );
  }
  // Search articles' default count can't be above its most: each search would be cut to it without a word.
  const tools = (values as { tools?: { articles?: number; maxArticles?: number } }).tools;
  if (tools?.articles !== undefined && tools.maxArticles !== undefined && tools.articles > tools.maxArticles) {
    errors.push(
      `${settingName(["tools", "articles"])} (${tools.articles}) is above ${settingName(["tools", "maxArticles"])} (${tools.maxArticles}): it must be at most that`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Autopilot's settings: ${errors.join("; ")}`);
  }
  const names = Object.keys(inUse);
  const unknown = Object.keys(env)
    .filter((name) => name.startsWith(PREFIX) && !(name in inUse))
    .map((name) => ({ name, nearest: names.reduce((best, known) => (distance(name, known) < distance(name, best) ? known : best)) }));
  return { values, inUse, unknown };
}

let cached: CodeChangesSettings | undefined;

/** The server's settings, read from process.env once. */
export function serverCodeChangesSettings(): CodeChangesSettings {
  return (cached ??= readCodeChangesSettings().values);
}

const analysing = new AsyncLocalStorage<CodeChangesSettings>();

/**
 * The settings in use: inside withCodeChangesSettings (a project's analysis, with its Advanced tuning), those; else the
 * server's. So every step of an analysis reads the project's values without each one being handed them.
 */
export function codeChangesSettings(): CodeChangesSettings {
  return analysing.getStore() ?? serverCodeChangesSettings();
}

/** Runs `fn` (and everything it starts) with `settings` as codeChangesSettings(). */
export function withCodeChangesSettings<T>(settings: CodeChangesSettings, fn: () => T): T {
  return analysing.run(settings, fn);
}

/** A leaf of the schema by its path ("decide.rounds"), for its range. */
export function settingLeaf(path: string): Leaf<unknown> {
  const leaf = path.split(".").reduce<Tree | Leaf<unknown>>((node, key) => (node as Tree)[key]!, CODE_CHANGES_SETTINGS as unknown as Tree);
  return leaf as Leaf<unknown>;
}

/** For tests that change the variables: the next codeChangesSettings() reads them again. */
export function resetCodeChangesSettings(): void {
  cached = undefined;
}

/** At start-up (web and worker): stops on a bad value, warns of a likely typo, logs the values in use. */
export function checkCodeChangesSettings(): void {
  const { values, inUse, unknown } = readCodeChangesSettings();
  cached = values;
  for (const { name, nearest } of unknown) {
    log.warn(`${name} isn't one of Autopilot's settings: a typo for ${nearest}?`);
  }
  log.info("Autopilot's settings", inUse);
}

/** The README's table of the settings (a test keeps the two in step). */
export function codeChangesSettingsTable(): string {
  const rows: string[] = [];
  walk(CODE_CHANGES_SETTINGS, [], (leaf, name) =>
    rows.push(`| \`${name}\` | \`${String(leaf.default)}\` | ${leaf.range} | ${leaf.meaning} |`),
  );
  return ["| Variable | Default | Range | |", "|---|---|---|---|", ...rows].join("\n");
}
