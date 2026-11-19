import { type Prisma, prisma } from "@tuti/db";
import {
  dropHidden,
  fetchGithubSpec,
  fetchSpec,
  freeDocsSlug,
  GITHUB_NOT_ADDED,
  indexReference,
  lockProject,
  readStorable,
  referenceCounts,
  repoPathRefusal,
  respec,
  specUrlRefusal,
  syncApiReference as syncReference,
} from "@tuti/jobs";
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

/** A file in a repository the project added on GitHub: GitHub's id for the repository, the file's path, and a branch. */
// Stored as a 32-bit Int: a larger one is no repository's.
const repoId = z.number().int().positive().max(2_147_483_647, "That isn't a repository's id");
const repoPath = z
  .string()
  .trim()
  .transform((path) => path.replace(/^\/+/, ""))
  .pipe(
    z
      .string()
      .min(1, "Enter the file's path in the repository")
      .max(1000, "Keep the path to 1,000 characters")
      .refine((path) => !repoPathRefusal(path), "Enter the file's path in the repository, like openapi.yaml"),
  );
// What git allows in a branch's name, roughly: no spaces, control characters or ~^:?*[\ (GitHub answers the rest).
const branch = z
  .string()
  .trim()
  .min(1, "Enter a branch")
  .max(255, "Keep the branch to 255 characters")
  .regex(/^[^\s~^:?*[\\\x00-\x1f\x7f]+$/, "That isn't a branch's name")
  // Nor ".." (git refuses it), which would move the branch's lookup elsewhere on GitHub's API.
  .refine((ref) => !ref.includes(".."), "That isn't a branch's name");

/** A file on GitHub, as adding a reference from one takes it (`ref` left out: the repository's default branch). */
export const githubSource = z.object({ repoId, path: repoPath, ref: branch.optional() });

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

/**
 * The file in a repository the project added on GitHub, and the branch it was read on (`ref` left out: the repository's
 * default branch), or a refusal saying why it couldn't be read. Counted against the team's fetch limits as a URL is,
 * unless the repository isn't the project's (nothing is read then).
 */
export async function fetchedFromGithub(source: { repoId: number; path: string; ref?: string | null }, context: { actor: Actor; projectId: string }) {
  if (!(await prisma.githubRepository.count({ where: { repoId: source.repoId, connection: { projectId: context.projectId } } }))) {
    throw new OperationError(400, "invalid_input", GITHUB_NOT_ADDED);
  }
  await countSpecFetch(context);
  const result = await fetchGithubSpec(context.projectId, source);
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

/**
 * A URL source's address as it's kept: as a URL parser writes it ("https:Example.com/x" is "https://example.com/x"),
 * so the 6-hourly job's grouping by host, in SQL, sees the host its reads go to. An address that doesn't parse is
 * kept as given (it's refused before it would be).
 */
const stored = (url: string) => URL.parse(url.trim())?.href ?? url;

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
  title: "List API references",
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
  title: "Get an API reference",
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
  title: "Create an API reference",
  summary:
    "Add an API reference to the docs from a spec: its text (`spec`, 5 MB at most), the address it's at (`url`: https, a public address, 5 MB at most, read again every 6 hours and on apiReferences.sync; its relative servers are on the address that served it), or a file in a repository the project added on GitHub (`github`: GitHub's id for the repository, `repoId`, as githubRepositories.list gives it; the file's `path` in it; and a branch, `ref`, left out for the repository's default branch; 5 MB at most, read again when a pull request into the branch that changes the file merges, every 6 hours and on apiReferences.sync). Each is OpenAPI 3.0 or 3.1 in JSON or YAML, a GraphQL schema file, or a GraphQL endpoint's introspection result. It goes in `tab` (left out, the first one, if the docs have tabs) after the others there, published, with a page per operation; its slug comes from the name, and no tab, collection or article has it. A spec that can't be read or fetched, or has no operations, is refused with the reason. Fetches the team asks for (adding from a URL or GitHub, apiReferences.sync) are limited: 10 a minute per member (across their projects), 120 an hour per project (429)",
  method: "POST",
  path: "/api-references",
  scope: "write",
  access: "team",
  input: z
    .object({ name, spec: spec.optional(), url: sourceUrl.optional(), github: githubSource.optional(), tab: slug.optional() })
    .refine(
      (input) => [input.spec, input.url, input.github].filter((given) => given !== undefined).length === 1,
      "Give one of the spec's text (spec), its address (url) or its file on GitHub (github)",
    ),
  example: { name: "API reference", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" },
  run: async (context, input) => {
    const { projectId } = context;
    let text = input.spec;
    let from: string | undefined;
    let ref: string | undefined;
    if (input.url !== undefined) {
      ({ text, url: from } = await fetched(input.url, context));
    } else if (input.github) {
      ({ text, ref } = await fetchedFromGithub(input.github, context));
    }
    const { doc, state } = settle(null, read(text!, from));
    const { id, ...created } = await prisma.$transaction(async (tx) => {
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
          ...(input.url !== undefined && { source: "URL", sourceUrl: stored(input.url) }),
          ...(input.github && { source: "GITHUB", repoId: input.github.repoId, path: input.github.path, ref }),
          spec: text!,
          doc: json(doc),
          state: json(state),
          ...counts(doc, state),
          publishedAt: new Date(),
        },
        select: { ...summarySelect, id: true },
      });
    });
    await indexReference(id);
    return summary(created);
  },
});

export const updateApiReference = defineOperation({
  name: "apiReferences.update",
  title: "Update an API reference",
  summary:
    "Change an API reference: its `name` (its address stays), its address (`newSlug`: one no tab, collection, article or other reference has; 409 otherwise), its `tab` (it goes last there), whether it's `published`, how it sits in the docs' tree (`treeStyle`: each group a folder, `folders`; a heading, `headings`; or one `entry`), the groups' order (`groupOrder`: groups' keys, the ones left out after them), where requests go when the spec's servers have no host (`baseUrl`, an https address; null removes it), and whether readers can send requests from its pages (`tryIt`). `hide` and `show` take operations off and put them on the help center by their keys (\"GET /posts\"), `hideGroups` and `showGroups` whole groups by theirs; an operation is off when it's hidden or a group it's in is. `seen` says the team has looked: `true`, and nothing is new any more; or the keys of the operations it saw, and what a read added since is still new (a key it doesn't have is passed over). In the others, a key the reference doesn't have is refused",
  method: "PATCH",
  path: "/api-references/{slug}",
  scope: "write",
  access: "team",
  errors: [409],
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
  run: async ({ projectId }, input) => {
    const { id, ...updated } = await prisma.$transaction(async (tx) => {
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
        await dropHidden(tx, row.id, onHelpCenter(doc, next).operations.map((operation) => operation.key));
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
        select: { ...summarySelect, id: true },
      });
    });
    // What's on the help center, or the examples' address in each operation's Markdown, may have changed.
    if ([input.hide, input.show, input.hideGroups, input.showGroups, input.baseUrl].some((given) => given !== undefined)) {
      await indexReference(id);
    }
    return summary(updated);
  },
});

export const replaceApiReference = defineOperation({
  name: "apiReferences.replace",
  title: "Replace a reference's spec",
  summary:
    "Replace an uploaded API reference's spec with a new one (`spec`, as in apiReferences.create). The team's choices stay: an operation there before (by its key) and a type (by its name) keep their addresses, and what's hidden stays hidden. What the new spec adds is new until the team has looked, and starts off the help center while any operation the spec had before is off it. The answer says what the new spec did, by operations' keys (`changes`: how many it `added` and `removed`, and whether anything at all `changed`). A spec that can't be read, or has no operations, changes nothing and is refused with the reason",
  method: "POST",
  path: "/api-references/{slug}/replace",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({ slug, spec }),
  example: { spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '2'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" },
  run: async ({ projectId }, input) => {
    const next = read(input.spec);
    const { id, ...replaced } = await prisma.$transaction(async (tx) => {
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
      const { data, changes, shown } = respec(row, input.spec, next);
      await dropHidden(tx, row.id, shown);
      return { id: row.id, ...summary(await tx.apiReference.update({ where: { id: row.id }, data, select: summarySelect })), changes };
    });
    if (replaced.changes.changed) {
      await indexReference(id);
    }
    return replaced;
  },
});

export const syncApiReference = defineOperation({
  name: "apiReferences.sync",
  title: "Sync an API reference",
  summary:
    "Read a URL's or a GitHub file's API reference again now, as the 6-hourly sync does, with the same rules as apiReferences.replace: the team's choices stay, and what's new is new until the team has looked. The answer says what it did (`changes`, as replace's). A read that fails, or finds no operations, keeps the pages as they were: `changes` is null and `failure` says why (and `syncError`, the reference's page too, until a sync works). A sync that another (the 6-hourly one, a second Sync now, a change of its source) overtook writes nothing, as that one's answer is newer: `changes` and `failure` are null. The rest of the answer is the reference as it is once this sync is done. With `url` (a URL's reference), or `github` (a GitHub file's: any of its `repoId`, `path` and `ref`, the rest kept), the reference is read from there from now on: it's read first, with apiReferences.create's checks, and one that can't be is refused (400) with the source left as it was; so is one overtaken by another change of the source, or by a sync (409). The address is kept as a URL parser writes it. An uploaded reference is refused: replace its spec instead. Counted against the fetch limits apiReferences.create gives (429)",
  method: "POST",
  path: "/api-references/{slug}/sync",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({ slug, url: sourceUrl.optional(), github: z.object({ repoId: repoId.optional(), path: repoPath.optional(), ref: branch.optional() }).optional() }),
  example: { url: "https://api.example.com/openapi.json" },
  run: async (context, input) => {
    const { projectId } = context;
    const row = await prisma.apiReference.findUnique({
      where: { projectId_slug: { projectId, slug: input.slug } },
      select: { id: true, source: true, sourceUrl: true, repoId: true, path: true, ref: true, syncTriedAt: true },
    });
    if (!row) {
      throw notFound(input.slug);
    }
    if (row.source === "UPLOAD") {
      throw new OperationError(409, "uploaded", "This reference's spec was uploaded: upload a new version instead");
    }
    if (input.url !== undefined && row.source !== "URL") {
      throw new OperationError(409, "not_url", "This reference is read from GitHub: change its repository, path or branch instead");
    }
    if (input.github !== undefined && row.source !== "GITHUB") {
      throw new OperationError(409, "not_github", "This reference is read from a URL: change its address instead");
    }
    const github = input.github && { repoId: input.github.repoId ?? row.repoId!, path: input.github.path ?? row.path!, ref: input.github.ref ?? row.ref! };
    const elsewhere = input.url !== undefined ? stored(input.url) !== row.sourceUrl : github !== undefined && (github.repoId !== row.repoId || github.path !== row.path || github.ref !== row.ref);
    if (elsewhere) {
      // A new source: read whole before it's kept, so one that doesn't work leaves the reference as it was.
      const { text, url: from } = input.url !== undefined ? await fetched(input.url, context) : { ...(await fetchedFromGithub(github!, context)), url: undefined };
      const next = read(text, from);
      const { id, ...moved } = await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        // Only over the reference as it started from: every change and sync moves syncTriedAt on, so a teammate's change
        // that landed meanwhile stays, even one back to this source (A to C to A). A sync landing meanwhile refuses it
        // too: the rare price of telling those apart without a counter.
        const { sourceUrl, repoId, path, ref, syncTriedAt } = row;
        const current = await tx.apiReference.findFirst({ where: { id: row.id, sourceUrl, repoId, path, ref, syncTriedAt }, select: { doc: true, state: true } });
        if (!current) {
          if (await tx.apiReference.count({ where: { id: row.id } })) {
            throw new OperationError(409, "source_changed", `The ${input.url !== undefined ? "address" : "file"} changed or was synced meanwhile. Reload to see it, and try again.`);
          }
          throw notFound(input.slug);
        }
        // A sync of the old source still on its way finds it changed, and writes nothing.
        const { data, changes, shown } = respec(current, text, next);
        const updated = await tx.apiReference.update({
          where: { id: row.id },
          data: { ...data, ...(input.url !== undefined ? { sourceUrl: stored(input.url) } : github) },
          select: summarySelect,
        });
        await dropHidden(tx, row.id, shown);
        return { id: row.id, ...summary(updated), changes, failure: null as string | null };
      });
      if (moved.changes.changed) {
        await indexReference(id);
      }
      return moved;
    }
    // A source refused before anything is fetched costs nothing: the sync still says why, uncounted. The sync is of
    // the source checked here: one changed or synced meanwhile is left alone (`expected`), unfetched.
    const refused =
      row.source === "URL"
        ? specUrlRefusal(row.sourceUrl ?? "")
        : !(await prisma.githubRepository.count({ where: { repoId: row.repoId ?? -1, connection: { projectId } } }));
    if (!refused) {
      await countSpecFetch(context);
    }
    const result = await syncReference(row.id, { expected: row });
    // The reference as it is now; what this sync did is `changes` and `failure`, its own, whatever landed since.
    const now = await prisma.apiReference.findUnique({ where: { id: row.id }, select: summarySelect });
    if (!now) {
      throw notFound(input.slug);
    }
    return { ...summary(now), changes: result && "changes" in result ? result.changes : null, failure: result && "error" in result ? result.error : null };
  },
});

export const deleteApiReference = defineOperation({
  name: "apiReferences.delete",
  title: "Delete an API reference",
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
