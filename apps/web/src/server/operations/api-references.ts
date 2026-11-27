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
import { countSpecFetch } from "./fetch-limits";
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
const repoId = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647, "That isn't a repository's id")
  .describe("GitHub's id for the repository, as githubRepositories.list gives it")
  .meta({ examples: [123456789] });
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
  )
  .describe("The file's path in the repository")
  .meta({ examples: ["openapi.yaml"] });
// What git allows in a branch's name, roughly: no spaces, control characters or ~^:?*[\ (GitHub answers the rest).
const branch = z
  .string()
  .trim()
  .min(1, "Enter a branch")
  .max(255, "Keep the branch to 255 characters")
  .regex(/^[^\s~^:?*[\\\x00-\x1f\x7f]+$/, "That isn't a branch's name")
  // Nor ".." (git refuses it), which would move the branch's lookup elsewhere on GitHub's API.
  .refine((ref) => !ref.includes(".."), "That isn't a branch's name")
  .describe("A branch; left out, the repository's default branch")
  .meta({ examples: ["main"] });

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

export { countSpecFetch, FETCHES_PER_MEMBER_PER_MINUTE, FETCHES_PER_PROJECT_PER_HOUR } from "./fetch-limits";

const counts = referenceCounts;

/** The reference a path names. */
const referenceSlug = slug.describe("The API reference's slug: its address in the docs").meta({ examples: ["public-api"] });

/** An API reference as lists and changes return it (`summary`): everything but its spec and what it read into. */
const reference = z.object({
  slug: z
    .string()
    .describe("Its address in the docs (`/docs/<slug>`): from its name when it was added, and kept when it's renamed")
    .meta({ examples: ["public-api"] }),
  name: z.string().describe("Its name in the docs' tree").meta({ examples: ["Public API"] }),
  tab: z.string().nullable().describe("Its tab's slug; null when the docs have no tabs").meta({ examples: ["developers"] }),
  format: z.enum(["openapi", "graphql"]).describe("What the spec is: OpenAPI, or a GraphQL schema").meta({ examples: ["openapi"] }),
  source: z
    .enum(["upload", "url", "github"])
    .describe(
      "Where the spec is read from: text uploaded and replaced by hand (apiReferences.replace), an address (`sourceUrl`) or a file on GitHub (`repoId`, `path`, `ref`), read again every 6 hours and on apiReferences.sync",
    )
    .meta({ examples: ["url"] }),
  sourceUrl: z
    .string()
    .nullable()
    .describe("The address a `url` reference's spec is read from, as a URL parser writes it; null otherwise")
    .meta({ examples: ["https://api.example.com/openapi.json"] }),
  repoId: z
    .number()
    .int()
    .nullable()
    .describe("GitHub's id for a `github` reference's repository (githubRepositories.list); null otherwise")
    .meta({ examples: [null] }),
  path: z.string().nullable().describe("The file's path in that repository; null otherwise").meta({ examples: [null] }),
  ref: z.string().nullable().describe("The branch the file is read on; null otherwise").meta({ examples: [null] }),
  baseUrl: z
    .string()
    .nullable()
    .describe("Where requests go when the spec's servers have no host; null when none is set")
    .meta({ examples: ["https://api.example.com"] }),
  treeStyle: z
    .enum(TREE_STYLES)
    .describe("How it sits in the docs' tree: each group a folder (`folders`) or a heading (`headings`), or one `entry` that lists the operations")
    .meta({ examples: ["folders"] }),
  tryIt: z.boolean().describe("Whether readers can send requests from its pages").meta({ examples: [true] }),
  counts: z
    .object({
      operations: z.number().int().describe("How many operations the spec has").meta({ examples: [24] }),
      onHelpCenter: z.number().int().describe("How many of them are on the help center").meta({ examples: [22] }),
      new: z.number().int().describe("How many a read added since the team last looked").meta({ examples: [2] }),
    })
    .describe("Its operations, counted"),
  published: z.boolean().describe("Whether it's on the help center: a draft is on it nowhere").meta({ examples: [true] }),
  syncedAt: z.string().describe("When the spec was last read successfully").meta({ examples: ["2026-11-19T09:00:00.000Z"] }),
  syncTriedAt: z.string().describe("When its source was last read, whether that worked or not").meta({ examples: ["2026-11-19T09:00:00.000Z"] }),
  changedAt: z.string().describe("When a read last changed what the spec has").meta({ examples: ["2026-11-18T16:30:00.000Z"] }),
  syncError: z
    .string()
    .nullable()
    .describe("Why the last read failed, or found no operations, so the pages stayed as they were; null once one works")
    .meta({ examples: [null] }),
});

/** What a new spec did (respec), by operations' keys. */
const specChanges = z
  .object({
    added: z.number().int().describe("How many operations the new spec added").meta({ examples: [2] }),
    removed: z.number().int().describe("How many it removed").meta({ examples: [0] }),
    changed: z.boolean().describe("Whether anything at all changed: the pages are rebuilt only then").meta({ examples: [true] }),
  })
  .meta({ id: "SpecChanges", description: "What a new spec did to the reference's operations, by their keys" });

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
    "List the docs' API references in order: by tab, then their order in it.",
  method: "GET",
  path: "/api-references",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z
    .object({
      apiReferences: z.array(reference.meta({ id: "ApiReference", description: "An API reference in the docs" })).describe("Every API reference, in order"),
    })
    .describe("The docs' API references"),
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
    "Get an API reference as the team sees it: its groups in the team's order, its operations and types, which of them are on the help center, and what the spec's reader couldn't read.",
  method: "GET",
  path: "/api-references/{slug}",
  scope: "read",
  access: "team",
  input: z.object({
    slug: referenceSlug,
    spec: z
      .union([z.boolean(), z.stringbool()])
      .default(false)
      .describe("`true` adds the spec's text (`spec`)")
      .meta({ examples: [true] }),
  }),
  output: reference
    .extend({
      title: z.string().describe("The API's own name, from the spec; empty when it has none").meta({ examples: ["Acme API"] }),
      version: z.string().nullable().describe("The API's version, from the spec").meta({ examples: ["1.0.0"] }),
      description: z.string().describe("The API's description, from the spec, in Markdown").meta({ examples: ["The Acme REST API."] }),
      groups: z
        .array(
          z.object({
            key: z
              .string()
              .describe("What the team's order and choices go by: its name in the spec (an OpenAPI tag), or GraphQL's `queries`, `mutations` and `subscriptions`")
              .meta({ examples: ["Posts"] }),
            name: z.string().describe("Its name").meta({ examples: ["Posts"] }),
            description: z.string().describe("What it's for, from the spec, in Markdown").meta({ examples: ["Everything about posts."] }),
            onHelpCenter: z.boolean().describe("Whether the team left the group on the help center").meta({ examples: [true] }),
          }),
        )
        .describe("Its groups, in the team's order"),
      groupOrder: z.array(z.string()).describe("The groups' keys the team ordered, in that order; the others come after").meta({ examples: [["Posts"]] }),
      operations: z
        .array(
          z.object({
            key: z
              .string()
              .describe("What it's known by across reads, so the team's choices stay: its method and path with each parameter's name left out, or `mutation createPost`")
              .meta({ examples: ["GET /posts/{}"] }),
            slug: z.string().describe("Its page's address under the reference").meta({ examples: ["list-posts"] }),
            title: z.string().describe("Its title on its page").meta({ examples: ["List posts"] }),
            kind: z
              .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "query", "mutation", "subscription"])
              .describe("Its method, or GraphQL's `query`, `mutation` or `subscription`")
              .meta({ examples: ["GET"] }),
            path: z.string().describe("OpenAPI: its path with its parameters. GraphQL: the field's name").meta({ examples: ["/posts/{number}"] }),
            group: z.string().describe("The key of the group it's listed in").meta({ examples: ["Posts"] }),
            alsoIn: z.array(z.string()).describe("The keys of the other groups it's in").meta({ examples: [[]] }),
            deprecated: z.boolean().describe("Whether the spec marks it deprecated").meta({ examples: [false] }),
            onHelpCenter: z
              .boolean()
              .describe("Whether it's on the help center: it's off when the team took it off itself (`hidden`), and while a group it's in is")
              .meta({ examples: [true] }),
            hidden: z.boolean().describe("Whether the team took it off the help center itself").meta({ examples: [false] }),
            new: z.boolean().describe("Whether a read added it since the team last looked").meta({ examples: [false] }),
          }),
        )
        .describe("Its operations, in the spec's order"),
      types: z
        .array(
          z.object({
            name: z.string().describe("Its name in the spec").meta({ examples: ["Post"] }),
            slug: z.string().describe("Its page's address under the reference").meta({ examples: ["post"] }),
            kind: z.enum(["object", "input", "enum", "scalar", "union", "interface"]).describe("What kind of type it is").meta({ examples: ["object"] }),
            onHelpCenter: z.boolean().describe("Whether it has a page: only while an operation on the help center uses it").meta({ examples: [true] }),
          }),
        )
        .describe("Its named types (OpenAPI's schemas, GraphQL's types)"),
      warnings: z
        .array(
          z.object({
            code: z.string().describe("The kind of problem").meta({ examples: ["UNKNOWN_REF"] }),
            message: z.string().describe("The problem in a sentence").meta({ examples: ["A $ref names a schema the spec doesn't have"] }),
            count: z.number().int().describe("How many places have it").meta({ examples: [1] }),
            where: z.array(z.string()).describe("The first 20 places in the spec").meta({ examples: [["POST /posts › responses › 400"]] }),
          }),
        )
        .describe("What the reader couldn't read, by kind: its pages are built without it"),
      spec: z.string().optional().describe("The spec's text, with `spec=true`").meta({ examples: ["openapi: 3.1.0\n…"] }),
    })
    .describe("The API reference"),
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
    "Add an API reference to the docs, published, with a page per operation. A spec that can't be read or fetched, or has no operations, is refused with the reason. Fetches the team asks for (from a URL or GitHub, syncs) are limited: 10 a minute per member across projects, 120 an hour per project (429).",
  method: "POST",
  path: "/api-references",
  scope: "write",
  access: "team",
  errors: [429],
  input: z
    .object({
      name: name.describe("Its name in the docs' tree; its slug comes from it, one no tab, collection or article has").meta({ examples: ["Public API"] }),
      spec: spec
        .describe("The spec's text, 5 MB at most: OpenAPI 3.0 or 3.1 in JSON or YAML, a GraphQL schema file, or a GraphQL endpoint's introspection result")
        .optional(),
      url: sourceUrl
        .describe("The address the spec is at instead: https, a public address, 5 MB at most. Its relative servers are on the address that served it")
        .meta({ examples: ["https://api.example.com/openapi.json"] })
        .optional(),
      github: githubSource
        .describe("Adding from GitHub instead: a file in a repository the project added, 5 MB at most; also read again when a pull request into the branch that changes the file merges")
        .optional(),
      tab: slug.describe("The tab it goes in, last, by slug; left out, the first one, if the docs have tabs").meta({ examples: ["developers"] }).optional(),
    })
    .refine(
      (input) => [input.spec, input.url, input.github].filter((given) => given !== undefined).length === 1,
      "Give one of the spec's text (spec), its address (url) or its file on GitHub (github)",
    )
    .meta({ oneOf: [{ required: ["spec"] }, { required: ["url"] }, { required: ["github"] }] }),
  output: reference.describe("The API reference added"),
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
    "Change an API reference: the fields given, the rest kept. An operation is off the help center when it's hidden or a group it's in is. In `groupOrder`, `hide`, `show`, `hideGroups` and `showGroups`, a key the reference doesn't have is refused.",
  method: "PATCH",
  path: "/api-references/{slug}",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: referenceSlug,
    name: name.describe("Its name in the docs' tree; its address stays").meta({ examples: ["Public API"] }).optional(),
    newSlug: customSlug
      .describe("A new address: lowercase letters, digits and hyphens, one no tab, collection, article or other reference has (409 otherwise)")
      .meta({ examples: ["public-api-v2"] })
      .optional(),
    tab: slug.describe("The tab it moves to, by slug: it goes last there").meta({ examples: ["developers"] }).optional(),
    published: z.boolean().describe("Whether it's on the help center").optional(),
    treeStyle: z
      .enum(TREE_STYLES)
      .describe("How it sits in the docs' tree: each group a folder (`folders`) or a heading (`headings`), or one `entry` that lists the operations")
      .optional(),
    groupOrder: keys.describe("The groups' order, by their keys: the ones left out come after them").meta({ examples: [["Posts", "Comments"]] }).optional(),
    baseUrl: baseUrl
      .nullable()
      .describe("Where requests go when the spec's servers have no host: an https address; null removes it")
      .meta({ examples: ["https://api.example.com"] })
      .optional(),
    tryIt: z.boolean().describe("Whether readers can send requests from its pages").optional(),
    hide: keys.describe("Operations to take off the help center, by their keys (`GET /posts/{}`)").meta({ examples: [["DELETE /posts/{}"]] }).optional(),
    show: keys.describe("Operations to put back on the help center, by their keys").optional(),
    hideGroups: keys.describe("Whole groups to take off the help center, by their keys (`hide` takes operations by theirs)").meta({ examples: [["Internal"]] }).optional(),
    showGroups: keys.describe("Whole groups to put back on the help center, by their keys").optional(),
    seen: z
      .union([z.literal(true), keys])
      .describe(
        "Says the team has looked: `true`, and nothing is new any more; or the keys of the operations it saw, and what a read added since is still new (a key it doesn't have is passed over)",
      )
      .optional(),
  }),
  output: reference.describe("The API reference as changed"),
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
    "Replace an uploaded API reference's spec. The team's choices stay: an operation (by its key) and a type (by its name) keep their addresses, and what's hidden stays hidden. What the new spec adds is new until the team has looked, and starts off the help center while any earlier operation is off it.",
  method: "POST",
  path: "/api-references/{slug}/replace",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: referenceSlug,
    spec: spec.describe(
      "The new spec's text, as in apiReferences.create. One that can't be read, or has no operations, changes nothing and is refused with the reason",
    ),
  }),
  output: reference.extend({ changes: specChanges }).describe("The answer: the API reference with its new spec; `changes` says what the new spec did"),
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
    "Read a URL's or a GitHub file's API reference again now, as the 6-hourly sync does, with apiReferences.replace's rules: the team's choices stay. An uploaded reference is refused: replace its spec instead. Counted against the fetch limits apiReferences.create gives (429).",
  method: "POST",
  path: "/api-references/{slug}/sync",
  scope: "write",
  access: "team",
  errors: [409, 429],
  input: z.object({
    slug: referenceSlug,
    url: sourceUrl
      .describe(
        "A URL reference's new address, read from now on (kept as a URL parser writes it). It's read first, with apiReferences.create's checks: one that can't be is refused (400) with the source left as it was; so is one overtaken by another change of the source, or by a sync (409)",
      )
      .meta({ examples: ["https://api.example.com/openapi.json"] })
      .optional(),
    github: z
      .object({ repoId: repoId.optional(), path: repoPath.optional(), ref: branch.meta({ description: "A branch; left out, the one it's read from now", examples: ["main"] }).optional() })
      .describe("A GitHub file reference's new file: any of its `repoId`, `path` and `ref`, the rest kept. Read first, as `url` is")
      .optional(),
  }),
  output: reference
    .extend({
      changes: specChanges
        .nullable()
        .describe(
          "What this sync did, as replace's. Null when the read fails or finds no operations (`failure`), or when another sync (the 6-hourly one, a second Sync now, a change of its source) overtook this one: it writes nothing, as that one's answer is newer",
        ),
      failure: z
        .string()
        .nullable()
        .describe("Why the read failed or found no operations: the reference keeps the pages as they were, and `syncError` (the reference's page too) says it until a sync works. Null otherwise")
        .meta({ examples: [null] }),
    })
    .describe("The rest of the answer is the API reference as it is once this sync is done"),
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
  input: z.object({ slug: referenceSlug }),
  output: z.object({ deleted: z.string().describe("The deleted reference's slug").meta({ examples: ["public-api"] }) }).describe("The API reference deleted"),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.apiReference.deleteMany({ where: { projectId, slug: input.slug } });
    if (count === 0) {
      throw notFound(input.slug);
    }
    return { deleted: input.slug };
  },
});
