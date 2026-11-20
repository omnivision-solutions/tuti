import { readFileSync } from "node:fs";

import { z } from "zod";

import { log } from "../log";
import { ai, AI_REPLACED } from "./ai";
import { media, MEDIA_REPLACED } from "./media";

/**
 * The deployment's config file: a JSON file at TUTI_CONFIG (a path), mounted into the web app and the worker alike. It
 * holds what an operator tunes, by feature; secrets and where things are (URLs, hosts, keys) stay in env vars, and no
 * value is read from both. Every key is optional: what the file leaves out is its default, defined here, beside its
 * feature. Without a file, every value is its default.
 *
 * One file per feature in this folder, each a section of the schema below, read as config().<section>. A new value is a
 * new key in its section, with its default and description: the JSON Schema (`pnpm test -u` rewrites
 * tuti.config.schema.json) and docs/self-hosting.md's table follow from it.
 */
export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  media,
  ai,
});

export type Config = z.output<typeof configSchema>;

/** Env vars a section replaced, with their keys: one still set is a server not yet moved over. */
export const CONFIG_REPLACED: Record<string, string> = { ...MEDIA_REPLACED, ...AI_REPLACED };

let loaded: { path: string; config: Config } | null = null;

/** This server's config: the file's values, each one it leaves out its default. Throws, naming the problem, on a file that can't be read or isn't valid. */
export function config(): Config {
  const path = process.env.TUTI_CONFIG?.trim() ?? "";
  if (loaded?.path !== path) {
    loaded = { path, config: read(path) };
  }
  return loaded.config;
}

function read(path: string): Config {
  if (!path) {
    return configSchema.parse({});
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`TUTI_CONFIG (${path}) can't be read: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`TUTI_CONFIG (${path}) isn't JSON: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`TUTI_CONFIG (${path}) isn't valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** At start-up, on the web app and the worker: a bad file, or a variable the file replaced still set, stops it. */
export function checkConfig(): void {
  const replaced = Object.keys(CONFIG_REPLACED).filter((name) => process.env[name]?.trim());
  if (replaced.length > 0) {
    throw new Error(`Set in the config file (TUTI_CONFIG) now, not in env vars: ${replaced.map((name) => `${name} → ${CONFIG_REPLACED[name]}`).join(", ")}`);
  }
  config();
  log.info(`Config: ${process.env.TUTI_CONFIG?.trim() || "no TUTI_CONFIG file, every default"}`);
}

type JsonSchema = { type?: string; description?: string; default?: unknown; properties?: Record<string, JsonSchema> };

/** docs/self-hosting.md's table of every key, its default and what it's for (a test keeps the two in step). */
export function configTable(): string {
  const rows: string[] = [];
  const walk = (schema: JsonSchema, path: string[]) => {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key === "$schema") {
        continue;
      }
      if (child.type === "object") {
        walk(child, [...path, key]);
      } else {
        rows.push(`| \`${[...path, key].join(".")}\` | \`${JSON.stringify(child.default)}\` | ${child.description ?? ""} |`);
      }
    }
  };
  walk(z.toJSONSchema(configSchema, { io: "input" }) as JsonSchema, []);
  return ["| Key | Default | |", "|---|---|---|", ...rows].join("\n");
}
