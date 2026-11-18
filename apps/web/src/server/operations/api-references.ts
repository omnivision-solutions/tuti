import { type Prisma, prisma } from "@tuti/db";
import { fetchSpec, freeDocsSlug, lockProject, readStorable, referenceCounts, respec, specUrlRefusal, syncApiReference as syncReference } from "@tuti/jobs";
import { type ApiDoc, type ApiReferenceState, onHelpCenter, OPENAPI_MAX_BYTES, settle } from "@tuti/shared/api-reference";
import { z } from "zod";

import { SPEC_TOO_LARGE } from "@/lib/api-reference";

import { type Actor, defineOperation, OperationError } from "./define";
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
/** Where a URL source's spec is (fetchSpec says what it may be: https, public). */
const sourceUrl = z.string().trim().min(1, "Enter the spec's address").max(2000, "Keep the address to 2,000 characters");

/** The spec as a doc to store; one that can't be read, or has nothing to show, is refused with the reader's sentence. */
function read(text: string, from?: string): ApiDoc {
  const result = readStorable(text, from);
  if ("error" in result) {
    throw new OperationError(400, "invalid_input", result.error);
  }
  return result.doc;
}

/**
 * The text at a URL source's address and the address that served it (fetchSpec's limits), or a refusal saying why it
 * couldn't be read. Counted against the team's fetch limits (`context`) unless it's refused before anything is fetched.
 */
export async function fetched(url: string, context: { actor: Actor; projectId: string }): Promise<{ text: string; url: string }> {
  const refused = specUrlRefusal(url);
  if (refused) {
    throw new OperationError(400, "invalid_input", refused);
  }
  await countSpecFetch(context);
  const result = await fetchSpec(url);
  if ("error" in result) {
    throw new OperationError(400, "invalid_input", result.error);
  }
  return result;
}

/** Specs the team may have Tuti fetch: per member (across their projects; an API key counts as whoever made it) a minute, and per project an hour. */
export const FETCHES_PER_MEMBER_PER_MINUTE = 10;
export const FETCHES_PER_PROJECT_PER_HOUR = 120;

/**
 * Counts a fetch the team asked for (Fetch, adding from a URL, Sync now) against its limits, or refuses it: each one
 * makes our server wait up to 15 seconds for an address the team picks. One at a time per project, so fetches at once
 * can't overrun the limits together. The 6-hourly sync isn't counted.
 */
export async function countSpecFetch({ actor, projectId }: { actor: Actor; projectId: string }): Promise<void> {
  const userId = actor.kind === "user" ? actor.userId : actor.createdById;
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const over = await prisma.$transaction(async (tx) => {
    // Locks of their own (classes 11 and 12), always in that order: they wait on nothing else of the project's.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(11, hashtext(${projectId}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(12, hashtext(${userId}))`;
    await tx.apiReferenceFetch.deleteMany({ where: { projectId, createdAt: { lt: hourAgo } } });
    const [byMember, byProject] = await Promise.all([
      // Across their projects: being on many is no more fetches a minute.
      tx.apiReferenceFetch.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 60_000) } } }),
      tx.apiReferenceFetch.count({ where: { projectId, createdAt: { gt: hourAgo } } }),
    ]);
    if (byMember >= FETCHES_PER_MEMBER_PER_MINUTE) return "That's a lot of fetches. Try again in a minute.";
    if (byProject >= FETCHES_PER_PROJECT_PER_HOUR) return "This project fetched a lot of specs in the last hour. Try again later.";
    await tx.apiReferenceFetch.create({ data: { projectId, userId } });
    return null;
  });
  if (over) {
    throw new OperationError(429, "rate_limited", over);
  }
}

const counts = referenceCounts;

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
  syncTriedAt: true,
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
    "Add an API reference to the docs from a spec: its text (`spec`, 5 MB at most), or the address it's at (`url`: https, a public address, 5 MB at most, read again every 6 hours and on apiReferences.sync; its relative servers are on the address that served it). Either is OpenAPI 3.0 or 3.1 in JSON or YAML, a GraphQL schema file, or a GraphQL endpoint's introspection result. It goes in `tab` (left out, the first one, if the docs have tabs) after the others there, published, with a page per operation; its slug comes from the name, and no tab, collection or article has it. A spec that can't be read or fetched, or has no operations, is refused with the reason. Fetches the team asks for (adding from a URL, apiReferences.sync) are limited: 10 a minute per member (across their projects), 120 an hour per project (429)",
  method: "POST",
  path: "/api-references",
  scope: "write",
  access: "team",
  input: z
    .object({ name, spec: spec.optional(), url: sourceUrl.optional(), tab: slug.optional() })
    .refine((input) => (input.spec === undefined) !== (input.url === undefined), "Give the spec's text (spec) or its address (url), not both"),
  example: { name: "API reference", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" },
  run: async (context, input) => {
    const { projectId } = context;
    const { text, url: from } = input.url === undefined ? { text: input.spec!, url: undefined } : await fetched(input.url, context);
    const { doc, state } = settle(null, read(text, from));
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
            ...(input.url !== undefined && { source: "URL", sourceUrl: input.url }),
            spec: text,
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
      const { data, changes } = respec(row, input.spec, next);
      return { ...summary(await tx.apiReference.update({ where: { id: row.id }, data, select: summarySelect })), changes };
    });
  },
});

export const syncApiReference = defineOperation({
  name: "apiReferences.sync",
  summary:
    "Read a URL's API reference again now, as the 6-hourly sync does, with the same rules as apiReferences.replace: the team's choices stay, and what's new is new until the team has looked. The answer says what it did (`changes`, as replace's). A read that fails, or finds no operations, keeps the pages as they were: `changes` is null and `syncError` says why (the reference's page says so too, until a sync works). A sync that another (the 6-hourly one, or a second Sync now) overtook writes nothing, as that one's answer is newer: `changes` is null. With `url`, the reference is read from that address from now on: it's fetched and read first, with apiReferences.create's checks, and one that can't be is refused (400) with the address left as it was; so is one overtaken by another change of the address (409). An uploaded reference is refused: replace its spec instead. Counted against the fetch limits apiReferences.create gives (429)",
  method: "POST",
  path: "/api-references/{slug}/sync",
  scope: "write",
  access: "team",
  input: z.object({ slug, url: sourceUrl.optional() }),
  example: { url: "https://api.example.com/openapi.json" },
  run: async (context, input) => {
    const { projectId } = context;
    const row = await prisma.apiReference.findUnique({ where: { projectId_slug: { projectId, slug: input.slug } }, select: { id: true, source: true, sourceUrl: true } });
    if (!row) {
      throw notFound(input.slug);
    }
    if (row.source !== "URL") {
      throw new OperationError(409, "not_url", "This reference's spec isn't read from a URL: upload a new version instead");
    }
    if (input.url !== undefined && input.url !== row.sourceUrl) {
      // A new address: read whole before it's kept, so one that doesn't work leaves the reference as it was.
      const { text, url: from } = await fetched(input.url, context);
      const next = read(text, from);
      return prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        // Only over the address it started from: a teammate's change that landed meanwhile is newer, and stays.
        const current = await tx.apiReference.findFirst({ where: { id: row.id, sourceUrl: row.sourceUrl }, select: { doc: true, state: true } });
        if (!current) {
          if (await tx.apiReference.count({ where: { id: row.id } })) {
            throw new OperationError(409, "source_changed", "Someone changed the address meanwhile. Reload to see it, and try again.");
          }
          throw notFound(input.slug);
        }
        // A sync of the old address still on its way finds the address changed, and writes nothing.
        const { data, changes } = respec(current, text, next);
        return { ...summary(await tx.apiReference.update({ where: { id: row.id }, data: { ...data, sourceUrl: input.url }, select: summarySelect })), changes };
      });
    }
    // An address refused before anything is fetched costs nothing: the sync still says why, uncounted.
    if (!specUrlRefusal(row.sourceUrl ?? "")) {
      await countSpecFetch(context);
    }
    const result = await syncReference(row.id);
    // Deleted, or its address changed, while it was read: what it is now.
    const now = await prisma.apiReference.findUnique({ where: { id: row.id }, select: summarySelect });
    if (!now) {
      throw notFound(input.slug);
    }
    return { ...summary(now), changes: result && "changes" in result ? result.changes : null };
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
