import { type CodeChangesSettings, serverCodeChangesSettings, settingLeaf } from "./code-changes-settings";
import { planIncludes } from "./plans";

/**
 * Advanced tuning (docs/plan.md, Autopilot's docs agent, D6): the few of Autopilot's settings a project's owners may change
 * for its own analyses (Business), each inside the server's range. A project's value wins, else the server's
 * CODE_CHANGES_* variable, else the default in code. Server limits (the price cap, time limits, the repository's size,
 * the tools' caps, how many analyses at once) are never per project.
 */
export const TUNING = {
  "propose.edit.maybe": {
    label: "Fix an article from",
    tradeoff: "Lower: fewer articles left out of date, more fixes to dismiss. Higher: fewer to review, more missed.",
  },
  "propose.newArticle.maybe": {
    label: "Write a new article from",
    tradeoff: "Lower: fewer missing articles, more duplicates. Higher: fewer duplicates, more gaps left.",
  },
  "redecide.whenNewArticle": {
    label: "Double-check a new article from",
    tradeoff: "Lower: more new articles double-checked, which costs more. Higher: cheaper, more duplicates get through.",
  },
  "decide.rounds": {
    label: "Lookups before deciding",
    tradeoff: "More: fewer missed articles, costs more and takes longer. Fewer: cheaper, may miss articles.",
  },
  "write.rounds": {
    label: "Lookups before writing",
    tradeoff: "More: text closer to what the product does, costs more. Fewer: cheaper, more to fix by hand.",
  },
  "decide.reasoning": {
    label: "Thinking",
    tradeoff: "More: better decisions on hard changes, costs more and is slower. Off: cheapest and fastest.",
  },
  "context.diffChars": {
    label: "Change shown up front",
    tradeoff: "More: big changes understood at once, each request costs more. Less: cheaper; Autopilot looks up the rest for the docs, but what the changelog and posts hear about is decided from this much only (20,000 characters at most).",
  },
} as const;

export type TuningKey = keyof typeof TUNING;
export const TUNING_KEYS = Object.keys(TUNING) as TuningKey[];
export type TuningValue = number | string;
export type TuningRange = { kind: "probability" | "integer"; min: number; max: number } | { kind: "options"; options: readonly string[] };

/** A value of `settings` by its path ("decide.rounds"). */
export const settingAt = (settings: CodeChangesSettings, key: string): TuningValue =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], settings) as TuningValue;

function setAt<T>(node: T, [head, ...rest]: string[], value: unknown): T {
  const record = node as Record<string, unknown>;
  return { ...record, [head!]: rest.length > 0 ? setAt(record[head!], rest, value) : value } as T;
}

/**
 * A value's range on this server: the schema's; a "from" threshold (an edit's or a new article's maybe) at most the
 * server's likely, which the server's own check holds it to too.
 */
export function tuningRange(key: TuningKey, settings: CodeChangesSettings = serverCodeChangesSettings()): TuningRange {
  const leaf = settingLeaf(key);
  if (leaf.options) {
    return { kind: "options", options: leaf.options };
  }
  const likely = key.endsWith(".maybe") ? (settingAt(settings, key.replace(/maybe$/, "likely")) as number) : Infinity;
  return { kind: leaf.range.startsWith("a whole number") ? "integer" : "probability", min: leaf.min!, max: Math.min(leaf.max!, likely) };
}

/** A saved value as it's used: inside the range now (a range the server narrowed since clamps it), or undefined when it isn't one. */
export function clampTuning(key: TuningKey, value: unknown, settings: CodeChangesSettings = serverCodeChangesSettings()): TuningValue | undefined {
  const range = tuningRange(key, settings);
  if (range.kind === "options") {
    return typeof value === "string" && range.options.includes(value) ? value : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return range.kind === "integer" ? Math.round(clamped) : clamped;
}

/** A project's saved values (project.codeChangesTuning) that are tuning values at all, as stored. */
export function savedTuning(value: unknown): Partial<Record<TuningKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => (TUNING_KEYS as string[]).includes(key)))
    : {};
}

/**
 * What a project's analyses run with: the server's settings with the project's values over them, clamped to the server's
 * ranges, where its plan includes Advanced tuning (after a downgrade they're kept, not used). `values`: every tuning
 * value as used; `tuned`: those the project changed (different from the server's).
 */
export function tunedSettings(
  saved: unknown,
  plan: "FREE" | "PRO" | "BUSINESS",
  settings: CodeChangesSettings = serverCodeChangesSettings(),
): { settings: CodeChangesSettings; values: Record<TuningKey, TuningValue>; tuned: TuningKey[] } {
  const own = planIncludes(plan, "aiTuning") ? savedTuning(saved) : {};
  let tuned = settings;
  const changed: TuningKey[] = [];
  for (const key of TUNING_KEYS) {
    const value = clampTuning(key, own[key], settings);
    if (value !== undefined && value !== settingAt(settings, key)) {
      tuned = setAt(tuned, key.split("."), value);
      changed.push(key);
    }
  }
  const values = Object.fromEntries(TUNING_KEYS.map((key) => [key, settingAt(tuned, key)])) as Record<TuningKey, TuningValue>;
  return { settings: tuned, values, tuned: changed };
}
