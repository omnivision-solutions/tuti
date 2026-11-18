import { parse as parseYaml } from "yaml";

import { readGraphql } from "./graphql";
import { OPENAPI_MAX_BYTES, readOpenApi } from "./openapi";
import type { ApiDoc, ApiGroup, ApiOperation, ApiSchema, ApiType } from "./types";

/**
 * A reference between reads of its spec: which reader a spec goes to, what the team chose about its
 * pages (kept when the spec is read again), and what of it readers may see.
 */

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a spec with the reader for what it is: an introspection result (JSON with `__schema`, or
 * `data.__schema`) and text that is neither JSON nor a YAML mapping are GraphQL's, everything else
 * OpenAPI's. A line of a schema file can read as a YAML mapping ("schema { query: Query }"), so a
 * mapping without `openapi` or `swagger` is tried as a schema file first. Never throws.
 */
export function readSpec(text: string, options: { endpoint?: string } = {}): { doc: ApiDoc } | { error: string } {
  // Not text, or too long: OpenAPI's reader says so.
  if (typeof text !== "string" || text.length > OPENAPI_MAX_BYTES) return readOpenApi(text);
  const clean = text.replace(/^﻿/, "");
  let json: unknown;
  try {
    json = JSON.parse(clean);
  } catch {
    let yaml: unknown = null;
    try {
      yaml = parseYaml(clean, { logLevel: "error" });
    } catch {
      // Not YAML either.
    }
    if (isObj(yaml) && ("openapi" in yaml || "swagger" in yaml)) return readOpenApi(text);
    const graphql = readGraphql(clean, options);
    return "error" in graphql && isObj(yaml) ? readOpenApi(text) : graphql;
  }
  const introspection = isObj(json) && (json.__schema !== undefined || (isObj(json.data) && json.data.__schema !== undefined));
  return introspection ? readGraphql(clean, options) : readOpenApi(text);
}

/** What the team chose about a reference's pages, kept across reads of its spec. Stored as JSON. */
export type ApiReferenceState = {
  /** Each page's address, as first given: by an operation's key, and by `type:<name>` for a type. Keys that left the spec keep theirs. */
  slugs: Record<string, string>;
  /** Keys of the operations that are off the help center. */
  hiddenOperations: string[];
  /** Keys of the groups that are off the help center, with every operation in them. */
  hiddenGroups: string[];
  /** Keys of the operations a read added since the team last looked. */
  unseen: string[];
  /** Groups' keys in the team's order; groups it doesn't name follow in the spec's. */
  groupOrder: string[];
};

const typeKey = (name: string) => `type:${name}`;

/**
 * A newly read doc, with the team's choices carried over from the one before (`previous`; null: the
 * first read):
 *
 * - An operation seen before (by its key) and a type (by its name) keep the slug they first had. Every
 *   slug ever given stays taken, by keys that left the spec too (one that comes back is where it was),
 *   so anything else proposing it gets a number.
 * - Operations the doc before didn't have are `unseen`, and start hidden while any operation of the
 *   doc before is off the help center: a renamed tag or a moved path never publishes what was hidden. A first read hides nothing
 *   and marks nothing.
 * - An operation that was off the help center stays off: one whose hidden tag was renamed (its key is
 *   the same, its group a new one) is hidden by itself.
 * - Keys that left the spec leave `unseen`, and stay in `slugs`, `hiddenOperations` and `hiddenGroups`.
 * - The groups keep the team's order, new ones after them in the spec's.
 */
export function settle(previous: { doc: ApiDoc; state: ApiReferenceState } | null, next: ApiDoc): { doc: ApiDoc; state: ApiReferenceState } {
  const before = previous?.state;
  const slugs: Record<string, string> = { ...before?.slugs };
  const taken = new Set(Object.values(slugs));
  const slugFor = (key: string, proposed: string) => {
    let slug = slugs[key];
    if (slug === undefined) {
      slug = proposed;
      for (let n = 2; taken.has(slug); n++) {
        slug = `${proposed}-${n}`;
      }
      taken.add(slug);
      slugs[key] = slug;
    }
    return slug;
  };
  const operations = next.operations.map((operation) => ({ ...operation, slug: slugFor(operation.key, operation.slug) }));
  const types = next.types.map((type) => ({ ...type, slug: slugFor(typeKey(type.name), type.slug) }));

  const known = new Set(previous?.doc.operations.map((operation) => operation.key));
  const keys = new Set(operations.map((operation) => operation.key));
  const added = previous ? [...keys].filter((key) => !known.has(key)) : [];
  // Hidden as the team sees it: an operation of the doc before that's off. A kept key of something
  // that left the spec hides nothing they could show again, so it doesn't count.
  const hidesSomething = previous !== null && onHelpCenter(previous.doc, previous.state).operations.length < previous.doc.operations.length;
  const doc = { ...next, operations, types };
  const state: ApiReferenceState = {
    slugs,
    hiddenOperations: [...new Set([...(before?.hiddenOperations ?? []), ...(hidesSomething ? added : [])])],
    hiddenGroups: before?.hiddenGroups ?? [],
    unseen: [...new Set([...(before?.unseen ?? []).filter((key) => keys.has(key)), ...added])],
    groupOrder: [...new Set([...(before?.groupOrder ?? []), ...next.groups.map((group) => group.key)])],
  };
  if (previous && hidesSomething) {
    const wasOn = new Set(onHelpCenter(previous.doc, previous.state).operations.map((operation) => operation.key));
    const opened = onHelpCenter(doc, state).operations.filter((operation) => known.has(operation.key) && !wasOn.has(operation.key));
    state.hiddenOperations.push(...opened.map((operation) => operation.key));
  }
  return { doc, state };
}

/** The named types a schema uses, wherever in it. */
function refsIn(schema: ApiSchema | null | undefined, into: Set<string>) {
  if (!schema) return;
  if (schema.ref !== undefined) into.add(schema.ref);
  refsIn(schema.items, into);
  for (const inner of [...(schema.properties ?? []), ...(schema.oneOf ?? [])]) {
    refsIn(inner, into);
  }
}

/**
 * What readers may see of a reference; the portal, search, the sitemap and `llms.txt` show nothing
 * else. An operation is off when it's hidden or its group, or another group it's tagged with, is. The
 * groups are in the team's order, without those that have no operation left. A type is there only
 * while an operation that's there uses it, itself or through another such type, so hiding an
 * internal endpoint never leaves its schema's fields public.
 */
export function onHelpCenter(doc: ApiDoc, state: ApiReferenceState): { groups: ApiGroup[]; operations: ApiOperation[]; types: ApiType[] } {
  const hiddenOperations = new Set(state.hiddenOperations);
  const hiddenGroups = new Set(state.hiddenGroups);
  const operations = doc.operations.filter(
    (operation) => !hiddenOperations.has(operation.key) && ![operation.group, ...(operation.alsoIn ?? [])].some((group) => hiddenGroups.has(group)),
  );
  const listed = new Set(operations.map((operation) => operation.group));
  const place = new Map(state.groupOrder.map((key, at) => [key, at]));
  // Sorting is stable: groups the order doesn't name stay in the spec's order, last.
  const groups = doc.groups.filter((group) => listed.has(group.key)).sort((a, b) => (place.get(a.key) ?? place.size) - (place.get(b.key) ?? place.size));

  const used = new Set<string>();
  for (const operation of operations) {
    for (const schema of [...operation.params.map((param) => param.schema), operation.body?.schema, ...operation.responses.map((response) => response.schema)]) {
      refsIn(schema, used);
    }
  }
  const byName = new Map(doc.types.map((type) => [type.name, type]));
  // A set is gone through in the order it's added to, with what's added on the way.
  for (const name of used) {
    refsIn(byName.get(name)?.schema, used);
  }
  return { groups, operations, types: doc.types.filter((type) => used.has(type.name)) };
}
