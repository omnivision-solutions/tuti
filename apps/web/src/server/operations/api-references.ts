import { isDeepStrictEqual } from "node:util";

import { type Prisma, prisma } from "@tuti/db";
import { freeDocsSlug, lockProject } from "@tuti/jobs";
import { type ApiDoc, type ApiReferenceState, onHelpCenter, OPENAPI_MAX_BYTES, readSpec, settle } from "@tuti/shared/api-reference";
import { z } from "zod";

import { SPEC_TOO_LARGE } from "@/lib/api-reference";

import { defineOperation, OperationError } from "./define";
import { customDocsSlug, customSlug, tabFor } from "./docs";

/**
 * API references in the docs (docs/plan.md, API reference in Docs): a team's OpenAPI or GraphQL spec,
 * read into a page per operation. The rules are in @tuti/shared/api-reference (readSpec, settle,
 * onHelpCenter); these store what they give and the team's choices.
 */

const slug = z.string().trim().min(1).max(80);
const name = z.string().trim().min(1, "Name is required").max(80, "Keep the name to 80 characters");
const spec = z.string().max(OPENAPI_MAX_BYTES, SPEC_TOO_LARGE);
const keys = z.array(z.string().max(2000)).max(10_000);
const TREE_STYLES = ["folders", "headings", "entry"] as const;
const baseUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https:\/\//i.test(value) && URL.canParse(value), "Enter an address that starts with https://");

/** The spec as a doc to store; one that can't be read, or has nothing to show, is refused with the reader's sentence. */
function read(text: string): ApiDoc {
  const result = readSpec(text);
  if ("error" in result) {
    throw new OperationError(400, "invalid_input", result.error);
  }
  if (result.doc.operations.length === 0) {
    throw new OperationError(400, "invalid_input", "This spec has no operations to show.");
  }
  // As it's stored (no undefined values), so a doc read again compares equal to the stored one.
  const doc = JSON.parse(JSON.stringify(result.doc)) as ApiDoc;
  if (UNSTORABLE.test(text) || unstorable(doc)) {
    throw new OperationError(
      400,
      "invalid_input",
      "This spec has a character that can't be stored: a null character (\\u0000) or half of a surrogate pair (\\ud800–\\udfff). Remove it and try again.",
    );
  }
  return doc;
}

/** What PostgreSQL stores in neither text nor JSON: a null character, or a surrogate without its other half. */
const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string anywhere in `value` (JSON; a key too) has one. */
function unstorable(value: unknown): boolean {
  if (typeof value === "string") return UNSTORABLE.test(value);
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(value) ? value.some(unstorable) : Object.entries(value).some(([key, inner]) => UNSTORABLE.test(key) || unstorable(inner));
}

/** The columns lists read, kept beside the state they count. */
const counts = (doc: ApiDoc, state: ApiReferenceState) => ({
  operationCount: doc.operations.length,
  shownCount: onHelpCenter(doc, state).operations.length,
  unseenCount: state.unseen.length,
});

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Everything about a reference but its `spec` and `doc`: those are large, so only apiReferences.get reads them. */
const summarySelect = {
  slug: true,
  name: true,
  tab: { select: { slug: true } },
  format: true,
  source: true,
  sourceUrl: true,
  repoId: true,
  path: true,
  ref: true,
  baseUrl: true,
  treeStyle: true,
  tryIt: true,
  operationCount: true,
  shownCount: true,
  unseenCount: true,
  publishedAt: true,
  syncedAt: true,
  changedAt: true,
  syncError: true,
} as const;
type SummaryRow = Prisma.ApiReferenceGetPayload<{ select: typeof summarySelect }>;

const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>;

const summary = ({ tab, format, source, treeStyle, operationCount, shownCount, unseenCount, publishedAt, ...row }: SummaryRow) => ({
  ...row,
  /** Its tab's slug (null: the docs have no tabs). */
  tab: tab?.slug ?? null,
  format: lower(format),
  source: lower(source),
  treeStyle: lower(treeStyle),
  /** How many operations the spec has, how many are on the help center, and how many a read added since the team last looked. */
  counts: { operations: operationCount, onHelpCenter: shownCount, new: unseenCount },
  published: publishedAt !== null,
});

const notFound = (slug: string) => new OperationError(404, "not_found", `There's no API reference “${slug}”`);

/** Where a reference going into tab `tabId` goes: last. */
async function lastIn(tx: Prisma.TransactionClient, projectId: string, tabId: string | null) {
  const last = await tx.apiReference.aggregate({ where: { projectId, tabId }, _max: { order: true } });
  return (last._max.order ?? -1) + 1;
}

export const listApiReferences = defineOperation({
  name: "apiReferences.list",
  summary:
    "List the docs' API references in order (by tab, then their order in it): each one's slug, name, tab, format (`openapi` or `graphql`), where its spec is read from (`source`), how many operations it has, how many are on the help center and how many are new (`counts`), whether it's published, when it was last read (`syncedAt`) and last changed (`changedAt`), and why the last read failed (`syncError`)",
  method: "GET",
  path: "/api-references",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({
    apiReferences: (
      await prisma.apiReference.findMany({ where: { projectId }, orderBy: [{ tab: { order: "asc" } }, { order: "asc" }, { name: "asc" }], select: summarySelect })
    ).map(summary),
  }),
});

export const getApiReference = defineOperation({
  name: "apiReferences.get",
  summary:
    "Get an API reference as the team sees it: its groups in the team's order and its operations (each with whether it's on the help center, `onHelpCenter`, whether the team took it off itself, `hidden`: it's off too while a group it's in is, and whether a read added it since the team last looked, `new`), its types (one has a page only while an operation on the help center uses it), what the reader couldn't read (`warnings`, by kind: how many and the first 20 places), how it sits in the docs' tree (`treeStyle`), where requests go when the spec's servers have no host (`baseUrl`), and whether readers can send requests from its pages (`tryIt`). `spec=true` adds the spec's text",
  method: "GET",
  path: "/api-references/{slug}",
  scope: "read",
  access: "team",
  input: z.object({ slug, spec: z.union([z.boolean(), z.stringbool()]).default(false) }),
  run: async ({ projectId }, input) => {
    const row = await prisma.apiReference.findUnique({
      where: { projectId_slug: { projectId, slug: input.slug } },
      select: { ...summarySelect, doc: true, state: true, spec: input.spec },
    });
    if (!row) {
      throw notFound(input.slug);
    }
    const { doc: storedDoc, state: storedState, spec: text, ...rest } = row;
    const doc = storedDoc as unknown as ApiDoc;
    const state = storedState as unknown as ApiReferenceState;
    const shown = onHelpCenter(doc, state);
    const shownOperations = new Set(shown.operations.map((operation) => operation.key));
    const shownTypes = new Set(shown.types.map((type) => type.name));
    const hiddenGroups = new Set(state.hiddenGroups);
    const hiddenOperations = new Set(state.hiddenOperations);
    const unseen = new Set(state.unseen);
    const place = new Map(state.groupOrder.map((key, at) => [key, at]));
    const warnings = new Map<string, { code: string; message: string; count: number; where: string[] }>();
    for (const warning of doc.warnings) {
      const kind = warnings.get(warning.code) ?? { code: warning.code, message: warning.message, count: 0, where: [] };
      kind.count++;
      if (kind.where.length < 20) {
        kind.where.push(warning.where);
      }
      warnings.set(warning.code, kind);
    }
    return {
      ...summary(rest),
      /** The API's own name, version and description, from the spec. */
      title: doc.title,
      version: doc.version,
      description: doc.description,
      groups: doc.groups
        .map((group) => ({ ...group, onHelpCenter: !hiddenGroups.has(group.key) }))
        .sort((a, b) => (place.get(a.key) ?? place.size) - (place.get(b.key) ?? place.size)),
      groupOrder: state.groupOrder,
      operations: doc.operations.map(({ key, slug, title, kind, path, group, alsoIn, deprecated }) => ({
        key,
        slug,
        title,
        kind,
        path,
        group,
        alsoIn: alsoIn ?? [],
        deprecated,
        onHelpCenter: shownOperations.has(key),
        hidden: hiddenOperations.has(key),
        new: unseen.has(key),
      })),
      types: doc.types.map(({ name, slug, kind }) => ({ name, slug, kind, onHelpCenter: shownTypes.has(name) })),
      warnings: [...warnings.values()],
      ...(input.spec && { spec: text }),
    };
  },
});

export const createApiReference = defineOperation({
  name: "apiReferences.create",
  summary:
    "Add an API reference to the docs from a spec's text (`spec`, 5 MB at most): OpenAPI 3.0 or 3.1 in JSON or YAML, a GraphQL schema file, or a GraphQL endpoint's introspection result. It goes in `tab` (left out, the first one, if the docs have tabs) after the others there, published, with a page per operation; its slug comes from the name, and no tab, collection or article has it. A spec that can't be read, or has no operations, is refused with the reason",
  method: "POST",
  path: "/api-references",
  scope: "write",
  access: "team",
  input: z.object({ name, spec, tab: slug.optional() }),
  example: { name: "API reference", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" },
  run: async ({ projectId }, input) => {
    const { doc, state } = settle(null, read(input.spec));
    return summary(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const tabId = await tabFor(tx, projectId, { slug: input.tab, parentId: null });
        return tx.apiReference.create({
          data: {
            projectId,
            tabId,
            slug: await freeDocsSlug(tx, projectId, input.name, "reference"),
            name: input.name,
            order: await lastIn(tx, projectId, tabId),
            format: doc.format === "graphql" ? "GRAPHQL" : "OPENAPI",
            spec: input.spec,
            doc: json(doc),
            state: json(state),
            ...counts(doc, state),
            publishedAt: new Date(),
          },
          select: summarySelect,
        });
      }),
    );
  },
});

export const updateApiReference = defineOperation({
  name: "apiReferences.update",
  summary:
    "Change an API reference: its `name` (its address stays), its address (`newSlug`: one no tab, collection, article or other reference has; 409 otherwise), its `tab` (it goes last there), whether it's `published`, how it sits in the docs' tree (`treeStyle`: each group a folder, `folders`; a heading, `headings`; or one `entry`), the groups' order (`groupOrder`: groups' keys, the ones left out after them), where requests go when the spec's servers have no host (`baseUrl`, an https address; null removes it), and whether readers can send requests from its pages (`tryIt`). `hide` and `show` take operations off and put them on the help center by their keys (\"GET /posts\"), `hideGroups` and `showGroups` whole groups by theirs; an operation is off when it's hidden or a group it's in is. `seen` says the team has looked: `true`, and nothing is new any more; or the keys of the operations it saw, and what a read added since is still new (a key it doesn't have is passed over). In the others, a key the reference doesn't have is refused",
  method: "PATCH",
  path: "/api-references/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    name: name.optional(),
    newSlug: customSlug.optional(),
    tab: slug.optional(),
    published: z.boolean().optional(),
    treeStyle: z.enum(TREE_STYLES).optional(),
    groupOrder: keys.optional(),
    baseUrl: baseUrl.nullable().optional(),
    tryIt: z.boolean().optional(),
    hide: keys.optional(),
    show: keys.optional(),
    hideGroups: keys.optional(),
    showGroups: keys.optional(),
    seen: z.union([z.literal(true), keys]).optional(),
  }),
  example: { hide: ["DELETE /posts/{}"], hideGroups: ["Internal"], treeStyle: "headings" },
  run: async ({ projectId }, input) =>
    summary(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        // The doc is large: read only for a change that's checked against it.
        const choosing = [input.hide, input.show, input.hideGroups, input.showGroups, input.groupOrder].some((list) => list !== undefined);
        const row = await tx.apiReference.findUnique({
          where: { projectId_slug: { projectId, slug: input.slug } },
          select: { id: true, slug: true, tabId: true, publishedAt: true, state: true, doc: choosing },
        });
        if (!row) {
          throw notFound(input.slug);
        }
        const data: Prisma.ApiReferenceUncheckedUpdateInput = {};
        // A set, not a list: it may hold thousands of keys, and this runs with the project locked.
        const seen = input.seen === true || input.seen === undefined ? input.seen : new Set(input.seen);
        const unseen = (state: ApiReferenceState) => (seen === undefined ? state.unseen : seen === true ? [] : state.unseen.filter((key) => !seen.has(key)));
        if (choosing) {
          const doc = row.doc as unknown as ApiDoc;
          const state = row.state as unknown as ApiReferenceState;
          // Sets, not lists: each list may hold thousands of keys, and this runs with the project locked.
          const known = (given: string[] | undefined, has: Set<string>, what: string) => {
            const unknown = (given ?? []).find((key) => !has.has(key));
            if (unknown !== undefined) {
              throw new OperationError(400, "invalid_input", `This reference has no ${what} “${unknown.slice(0, 200)}”`);
            }
            return given ?? [];
          };
          const operations = new Set(doc.operations.map((operation) => operation.key));
          const groups = new Set(doc.groups.map((group) => group.key));
          const [hide, show] = [known(input.hide, operations, "operation"), known(input.show, operations, "operation")];
          const [hideGroups, showGroups] = [known(input.hideGroups, groups, "group"), known(input.showGroups, groups, "group")];
          const [shown, shownGroups] = [new Set(show), new Set(showGroups)];
          const next: ApiReferenceState = {
            ...state,
            hiddenOperations: [...new Set([...state.hiddenOperations.filter((key) => !shown.has(key)), ...hide])],
            hiddenGroups: [...new Set([...state.hiddenGroups.filter((key) => !shownGroups.has(key)), ...hideGroups])],
            unseen: unseen(state),
            groupOrder: [...new Set([...known(input.groupOrder, groups, "group"), ...state.groupOrder])],
          };
          Object.assign(data, { state: json(next), ...counts(doc, next) });
        } else if (seen) {
          const state = row.state as unknown as ApiReferenceState;
          const left = unseen(state);
          Object.assign(data, { state: json({ ...state, unseen: left }), unseenCount: left.length });
        }
        if (input.tab !== undefined) {
          const tabId = await tabFor(tx, projectId, { slug: input.tab, parentId: null });
          if (tabId !== row.tabId) {
            Object.assign(data, { tabId, order: await lastIn(tx, projectId, tabId) });
          }
        }
        if (input.newSlug !== undefined && input.newSlug !== row.slug) {
          data.slug = await customDocsSlug(tx, projectId, input.newSlug, row, "reference");
        }
        return tx.apiReference.update({
          where: { id: row.id },
          data: {
            ...data,
            ...(input.name !== undefined && { name: input.name }),
            ...(input.published !== undefined && { publishedAt: input.published ? (row.publishedAt ?? new Date()) : null }),
            ...(input.treeStyle !== undefined && { treeStyle: input.treeStyle.toUpperCase() as Uppercase<(typeof TREE_STYLES)[number]> }),
            ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
            ...(input.tryIt !== undefined && { tryIt: input.tryIt }),
          },
          select: summarySelect,
        });
      }),
    ),
});

export const replaceApiReference = defineOperation({
  name: "apiReferences.replace",
  summary:
    "Replace an uploaded API reference's spec with a new one (`spec`, as in apiReferences.create). The team's choices stay: an operation there before (by its key) and a type (by its name) keep their addresses, and what's hidden stays hidden. What the new spec adds is new until the team has looked, and starts off the help center while any operation the spec had before is off it. The answer says what the new spec did, by operations' keys (`changes`: how many it `added` and `removed`, and whether anything at all `changed`). A spec that can't be read, or has no operations, changes nothing and is refused with the reason",
  method: "POST",
  path: "/api-references/{slug}/replace",
  scope: "write",
  access: "team",
  input: z.object({ slug, spec }),
  example: { spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '2'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" },
  run: async ({ projectId }, input) => {
    const next = read(input.spec);
    return prisma.$transaction(async (tx) => {
        // Locked, so a choice saved meanwhile (apiReferences.update) isn't written over.
        await lockProject(tx, projectId);
        const row = await tx.apiReference.findUnique({
          where: { projectId_slug: { projectId, slug: input.slug } },
          select: { id: true, source: true, doc: true, state: true },
        });
        if (!row) {
          throw notFound(input.slug);
        }
        if (row.source !== "UPLOAD") {
          throw new OperationError(409, "not_uploaded", "This reference's spec is read from where it lives, so it can't be replaced by hand");
        }
        const { doc, state } = settle({ doc: row.doc as unknown as ApiDoc, state: row.state as unknown as ApiReferenceState }, next);
        const now = new Date();
        const before = new Set((row.doc as unknown as ApiDoc).operations.map((operation) => operation.key));
        const after = new Set(doc.operations.map((operation) => operation.key));
        const changed = !isDeepStrictEqual(doc, row.doc);
        const updated = await tx.apiReference.update({
          where: { id: row.id },
          data: {
            format: doc.format === "graphql" ? "GRAPHQL" : "OPENAPI",
            spec: input.spec,
            doc: json(doc),
            state: json(state),
            ...counts(doc, state),
            syncedAt: now,
            ...(changed && { changedAt: now }),
            syncError: null,
          },
          select: summarySelect,
        });
        return {
          ...summary(updated),
          changes: { added: [...after].filter((key) => !before.has(key)).length, removed: [...before].filter((key) => !after.has(key)).length, changed },
        };
    });
  },
});

export const deleteApiReference = defineOperation({
  name: "apiReferences.delete",
  summary: "Delete an API reference, with its pages and the team's choices about them",
  method: "DELETE",
  path: "/api-references/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.apiReference.deleteMany({ where: { projectId, slug: input.slug } });
    if (count === 0) {
      throw notFound(input.slug);
    }
    return { deleted: input.slug };
  },
});
