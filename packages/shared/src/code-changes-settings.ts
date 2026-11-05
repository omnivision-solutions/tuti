import { z } from "zod";

import { log } from "./log";

/**
 * Autopilot's values for code changes (docs/plan.md, Autopilot's docs agent): each one a setting
 * with its default, type and range, read from its own environment variable, named from its path
 * (`decisions.movesForward.maybe` → CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE). So a server can
 * tune Autopilot (another model with the values that suit it) without a release. A new value is a
 * new leaf below: its variable, its check at start-up and its row in the README follow.
 */

type Leaf<V> = { schema: z.ZodType<V>; default: V; range: string; meaning: string; alias?: string };
type Tree = { [key: string]: Tree | Leaf<unknown> };

const probability = (value: number, meaning: string): Leaf<number> => ({
  schema: z.coerce.number().min(0).max(1),
  default: value,
  range: "a number from 0 to 1",
  meaning,
});

const integer = (value: number, min: number, max: number, meaning: string): Leaf<number> => ({
  schema: z.coerce.number().int().min(min).max(max),
  default: value,
  range: `a whole number from ${min} to ${max}`,
  meaning,
});

/** For a section that needs one (and for tests): one of a few named values. */
export const enumSetting = <const T extends readonly [string, ...string[]]>(values: T, value: T[number], meaning: string): Leaf<T[number]> => ({
  schema: z.enum(values),
  default: value,
  range: `one of ${values.join(", ")}`,
  meaning,
});

/** For a section that needs one (and for tests): true or false. */
export const booleanSetting = (value: boolean, meaning: string): Leaf<boolean> => ({
  schema: z.enum(["true", "false"]).transform((raw) => raw === "true"),
  default: value,
  range: "true or false",
  meaning,
});

const model = (value: string, meaning: string, alias?: string): Leaf<string> => ({
  schema: z.string().max(200).regex(/^\S+$/),
  default: value,
  range: "a model id",
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
    links: odds("Linking a post", 0.65, 0.85),
    autoLink: probability(0.95, 'A link Autopilot applies by itself from this probability (with "Link posts by itself" on)'),
  },
  propose: {
    edit: odds("Editing an article", 0.4, 0.75),
    newArticle: odds("A new article", 0.5, 0.8),
  },
  context: {
    diffChars: integer(20_000, 1_000, 500_000, "The pull request's diff the decision model reads, in characters; files past it are only listed"),
    fileChars: integer(6_000, 500, 500_000, "One file's share of the diff at most, in characters"),
    bodyChars: integer(4_000, 0, 100_000, "The pull request's description it reads, in characters"),
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

/** The settings in use, read from process.env once. */
export function codeChangesSettings(): CodeChangesSettings {
  return (cached ??= readCodeChangesSettings().values);
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
