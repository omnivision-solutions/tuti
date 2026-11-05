import { posix } from "node:path";
import { Worker } from "node:worker_threads";

import { type Doc, toChunks, toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";
import { articleChunkText, type CodeChangesSettings, codeChangesSettings, embed, embeddingsEnabled, toVectorLiteral } from "@tuti/shared";
import { z } from "zod";

import { docOf } from "./article-layers";
import { maskSecrets } from "./pull-request";
import type { Repository } from "./repository";

/**
 * The docs agent's read-only tools (docs/plan.md, Autopilot's docs agent): the repository at the pull request's merge
 * commit, and the project's help center. Each answer is text for the model, capped; a mistake (bad arguments, an
 * unknown tool, a missing file, an invalid or slow pattern) comes back as a short sentence it can act on, never a throw.
 * A failure the model can't act on (the database, a worker that won't start) does throw, on purpose: the analysis fails
 * and its job retries it, rather than the agent answering from a help center it only half read.
 */

/**
 * Each tool's caps: the settings' `tools` (CODE_CHANGES_TOOLS_*). `searchMs`: the model writes the pattern, and a regular
 * expression can backtrack for ages; `embedMs`: how long one embeddings request may take before search says it failed.
 */
export type ToolLimits = CodeChangesSettings["tools"];
const toolLimits = (limits: Partial<ToolLimits> = {}): ToolLimits => ({ ...codeChangesSettings().tools, ...limits });

/**
 * What the tools read: the project's help center, and its repository at the merge commit (or why it's not there). When the
 * agent is done with it, `closeTools` ends the search worker it started.
 */
export type ToolContext = { projectId: string; repository: Repository | { unavailable: string }; limits?: Partial<ToolLimits> };

/** The tools, in OpenAI's function-calling format. */
export function docsAgentTools(limits: Partial<ToolLimits> = {}) {
  const { fileChars, searchLines, articles, maxArticles } = toolLimits(limits);
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
    type: "function" as const,
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    tool("list_files", "Paths in the repository at the merge commit, under a directory prefix (or all).", { prefix: { type: "string", description: "A directory, e.g. src/app; empty for all" } }, []),
    tool("read_file", `A file's text at the merge commit (after the change). Cut at ${fileChars.toLocaleString("en")} characters.`, { path: { type: "string" } }, ["path"]),
    tool(
      "search_code",
      `Lines in the repository (at the merge commit) matching a case-insensitive regular expression; at most ${searchLines}.`,
      { pattern: { type: "string", description: "A JavaScript regular expression" } },
      ["pattern"],
    ),
    tool("read_article", "A help center article's, draft's or waiting new article's text (Markdown) by slug.", { slug: { type: "string" } }, ["slug"]),
    tool(
      "search_articles",
      "The help center's articles and drafts nearest a query (by meaning): slug, title, state.",
      { query: { type: "string" }, k: { type: "integer", description: `How many (default ${articles}, at most ${maxArticles})` } },
      ["query"],
    ),
  ];
}

const ARGUMENTS = {
  list_files: z.object({ prefix: z.string().optional() }),
  read_file: z.object({ path: z.string() }),
  search_code: z.object({ pattern: z.string().min(1) }),
  read_article: z.object({ slug: z.string() }),
  search_articles: z.object({ query: z.string().min(1), k: z.number().int().positive().optional() }),
};

/** A tool call's answer for the model: `arguments` is its JSON text, as the model wrote it. */
export async function runTool(context: ToolContext, call: { name: string; arguments: string }): Promise<string> {
  const limits = toolLimits(context.limits);
  // Own names only: one the model makes up, like "constructor", isn't a tool.
  const schema = Object.hasOwn(ARGUMENTS, call.name) ? ARGUMENTS[call.name as keyof typeof ARGUMENTS] : undefined;
  if (!schema) {
    return `There's no tool named ${call.name}.`;
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return `The arguments aren't JSON: ${call.arguments.slice(0, 200)}`;
  }
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return `Bad arguments for ${call.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")}`;
  }
  const input = parsed.data as Record<string, unknown>;
  switch (call.name as keyof typeof ARGUMENTS) {
    case "list_files":
      return withRepository(context, (repository) => listFiles(repository, (input.prefix as string | undefined) ?? "", limits));
    case "read_file":
      return withRepository(context, (repository) => readFile(repository, input.path as string, limits));
    case "search_code":
      return withRepository(context, (repository) => searchCode(repository, input.pattern as string, limits));
    case "read_article":
      return readArticle(context.projectId, input.slug as string, limits);
    case "search_articles":
      return searchArticles(context, input.query as string, Math.min((input.k as number | undefined) ?? limits.articles, limits.maxArticles));
  }
}

const withRepository = (context: ToolContext, use: (repository: Repository) => string | Promise<string>) =>
  "unavailable" in context.repository ? `The repository isn't available (${context.repository.unavailable}); work from the diff.` : use(context.repository);

/** The text, cut at `max` characters, saying so. */
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[cut at ${max.toLocaleString("en")} characters]` : text);

/** A path as the archive has it: no leading `./` or `/`; one that climbs out (`../`) matches nothing. */
const normal = (path: string) => posix.normalize(path.trim() || ".").replace(/^(\.\/|\/)+/, "").replace(/^\.$|\/$/g, "");

function listFiles({ files, skipped }: Repository, prefix: string, limits: ToolLimits): string {
  const folder = normal(prefix);
  const under = (path: string) => !folder || path === folder || path.startsWith(`${folder}/`);
  const paths = [...[...files.keys()].filter(under), ...[...skipped.keys()].filter(under).map((path) => `${path} (left out: ${skipped.get(path)})`)].sort();
  return paths.length === 0 ? `No files under ${prefix || "the repository"}.` : cut(paths.join("\n"), limits.listChars);
}

function readFile({ files, skipped }: Repository, path: string, limits: ToolLimits): string {
  const at = normal(path);
  const text = files.get(at);
  if (text !== undefined) {
    return cut(maskSecrets(text), limits.fileChars);
  }
  const why = skipped.get(at);
  return why ? `${at} isn't readable here: ${why}.` : `There's no file at ${path} in the repository.`;
}

/** Longest line shown: a minified file's one line would fill the answer. */
const LINE_CHARS = 300;

// Plain JavaScript, run in a worker thread that holds the repository's files: it's terminated when a search takes too long.
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { files } = workerData;
// Started and holding the files: from here a search's time limit counts.
parentPort.postMessage("ready");
parentPort.on("message", ({ pattern, max }) => {
  const found = [];
  try {
    const re = new RegExp(pattern, "i");
    search: for (const [path, text] of files) {
      const lines = text.split("\\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          found.push([path, i + 1, lines[i].slice(0, ${LINE_CHARS})]);
          if (found.length > max) break search;
        }
      }
    }
    parentPort.postMessage(found);
  } catch (error) {
    // The pattern's own failure (a stack overflow, say): the model's to fix, so it hears why.
    parentPort.postMessage({ failed: String(error && error.message || error) });
  }
});
`;

/**
 * Each repository's search worker, given its files once (each masked whole: a line cut first could leave part of a
 * secret unmasked, and a pattern matched against unmasked text would tell the model whether a guessed secret is there).
 * One per repository, so an analysis holds at most two copies of its files, however many searches the model asks for;
 * its searches run one at a time (`queues`). `closeTools` ends it.
 */
const workers = new WeakMap<Repository, { worker: Worker; ready: Promise<unknown> }>();
const queues = new WeakMap<Repository, Promise<unknown>>();
/** Repositories whose agent is done (`closeTools`): no search starts a worker for them again. */
const closed = new WeakSet<Repository>();

function searchWorker(repository: Repository) {
  let search = workers.get(repository);
  if (!search) {
    const files = [...repository.files].map(([path, text]) => [path, maskSecrets(text)]);
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { files } });
    // A worker nobody ended can't keep the process from exiting.
    worker.unref();
    const ready = new Promise((resolve, reject) => {
      worker.once("message", resolve).once("error", reject).once("exit", () => reject(new Error("the search worker stopped")));
    });
    ready.catch(() => {});
    search = { worker, ready };
    workers.set(repository, search);
  }
  return search;
}

async function endWorker(repository: Repository, worker: Worker) {
  if (workers.get(repository)?.worker === worker) {
    workers.delete(repository);
  }
  await worker.terminate();
}

type Found = [string, number, string][] | { failed: string } | null | "closed";

/**
 * One search in the repository's worker; null when it took too long (the worker is ended, and the next search starts
 * another), "closed" once `closeTools` has run.
 */
async function searchOnce(repository: Repository, pattern: string, limits: ToolLimits): Promise<Found> {
  if (closed.has(repository)) {
    return "closed";
  }
  const { worker, ready } = searchWorker(repository);
  try {
    // The time limit is the search's own, not the worker's start (a busy machine can take a while to start a thread).
    await ready;
  } catch (error) {
    if (closed.has(repository)) {
      return "closed";
    }
    await endWorker(repository, worker);
    throw error;
  }
  return new Promise<Found>((resolve, reject) => {
    const settle = (done: () => void) => {
      clearTimeout(timer);
      worker.off("message", onMessage).off("error", onError).off("exit", onExit);
      done();
    };
    const onMessage = (found: Found) => settle(() => resolve(found));
    // A worker that fails (it won't start, it runs out of memory) throws: the analysis fails and is retried.
    const onError = (error: Error) => settle(() => (void endWorker(repository, worker), reject(error)));
    const onExit = () => settle(() => (closed.has(repository) ? resolve("closed") : reject(new Error("the search worker stopped"))));
    const timer = setTimeout(() => settle(() => (void endWorker(repository, worker), resolve(null))), limits.searchMs);
    worker.on("message", onMessage).once("error", onError).once("exit", onExit);
    worker.postMessage({ pattern, max: limits.searchLines });
  });
}

async function searchCode(repository: Repository, pattern: string, limits: ToolLimits): Promise<string> {
  try {
    new RegExp(pattern, "i");
  } catch (error) {
    return `Invalid pattern: ${(error as Error).message}`;
  }
  if (closed.has(repository)) {
    return "The analysis is over: nothing more is searched.";
  }
  // One at a time: the model may ask for several searches at once, and the worker answers them in turn.
  const found = (queues.get(repository) ?? Promise.resolve()).then(() => searchOnce(repository, pattern, limits));
  queues.set(repository, found.catch(() => {}));
  const result = await found;
  if (!result) {
    return "Search took too long; try a simpler pattern.";
  }
  if (result === "closed") {
    return "The analysis is over: nothing more is searched.";
  }
  if (!Array.isArray(result)) {
    return `Search failed on that pattern (${result.failed}); try a simpler one.`;
  }
  if (result.length === 0) {
    return `No lines match ${pattern}.`;
  }
  const lines = result.slice(0, limits.searchLines).map(([path, line, text]) => `${path}:${line}: ${text}`);
  const more = result.length > limits.searchLines ? `\n[more lines match; the first ${limits.searchLines} are shown]` : "";
  return cut(lines.join("\n"), limits.searchChars) + more;
}

/**
 * Ends what the tools hold for an agent run: the repository's search worker (a thread with its own copy of the files).
 * Call it when the run is done, whether it succeeded or not (a time limit included): a search running or waiting then
 * answers "The analysis is over", and no search starts a worker for the repository again.
 */
export async function closeTools(context: ToolContext): Promise<void> {
  draftVectors.delete(context);
  if ("unavailable" in context.repository) {
    return;
  }
  const repository = context.repository;
  closed.add(repository);
  const search = workers.get(repository);
  if (search) {
    await endWorker(repository, search.worker);
  }
}

/** Not sample content (never embedded, left out of Home) nor deleted. */
const live = { deletedAt: null, sample: false };

const stateOf = (article: { publishedAt: Date | null; changes: unknown }) =>
  !article.publishedAt ? "draft" : article.changes ? "published, with unpublished changes (shown here)" : "published";

async function readArticle(projectId: string, slug: string, limits: ToolLimits): Promise<string> {
  const article = await prisma.article.findFirst({
    where: { projectId, slug, ...live },
    select: { title: true, body: true, content: true, publishedAt: true, changes: { select: { title: true, body: true, content: true } } },
  });
  if (!article) {
    return (await readWaiting(projectId, slug, limits)) ?? `There's no article or draft with the slug ${slug}.`;
  }
  // Its newest text: the unpublished changes, where Autopilot's other edits wait too.
  const newest = article.changes ?? article;
  return cut(`Title: ${newest.title}\nState: ${stateOf(article)}\n\n${toMarkdown(docOf(newest))}`, limits.articleChars);
}

/** How a new article waiting for the team is named to the agent, as an article's slug (its draft has none yet). */
export const waitingSlug = (actionId: string) => `new:${actionId}`;

/**
 * A new article another pull request proposed that waits for the team, by its slug (waitingSlug), so the agent knows
 * what it covers (and proposes no duplicate); null if none. Its text is fixed: the agent's edits to it are dropped.
 */
async function readWaiting(projectId: string, slug: string, limits: ToolLimits): Promise<string | null> {
  const id = slug.startsWith(waitingSlug("")) ? slug.slice(waitingSlug("").length) : null;
  const waiting =
    id &&
    (await prisma.codeChangeAction.findFirst({
      where: { id, kind: "NEW_ARTICLE", status: { in: ["PENDING", "SCHEDULED", "STALE"] }, codeChange: { projectId } },
      select: { payload: true },
    }));
  if (!waiting) {
    return null;
  }
  const draft = (waiting.payload ?? {}) as { title?: string; content?: unknown; body?: string };
  return cut(`Title: ${draft.title ?? ""}\nState: a new article waiting for the team's approval\n\n${toMarkdown(docOf({ content: draft.content ?? null, body: draft.body ?? "" }))}`, limits.articleChars);
}

/** Drafts aren't embedded (only published articles' sections are): each search's tool context embeds them once. */
const draftVectors = new WeakMap<ToolContext, Promise<{ id: string; vector: number[] }[]>>();
/** The drafts embedded for a search, newest first. ponytail: a cap, not all of them; embed drafts as they're saved if projects keep more. */
const DRAFTS_EMBEDDED = 100;
/** Texts per embeddings request (OpenAI takes up to 2,048, and a cap on tokens). */
const EMBED_BATCH = 100;

/** An embeddings request that failed: unlike the database's failures, one the agent is told about and can work around. */
class EmbeddingFailed extends Error {}
const embedding = (texts: string[], ms: number) =>
  // A stalled request ends as a failure the agent hears about, not an analysis that never finishes.
  embed(texts, AbortSignal.timeout(ms)).catch((error: unknown) => {
    throw new EmbeddingFailed(error instanceof Error ? error.message : String(error));
  });

async function embedDrafts(projectId: string, ms: number) {
  const drafts = await prisma.article.findMany({
    where: { projectId, publishedAt: null, ...live },
    orderBy: { updatedAt: "desc" },
    take: DRAFTS_EMBEDDED,
    select: { id: true, title: true, body: true, content: true, keywords: true },
  });
  // Sections, as published articles' are embedded, so their distances compare.
  const texts = drafts.flatMap((draft) =>
    toChunks(docOf(draft) as Doc).map((chunk, i) => ({ id: draft.id, text: articleChunkText(draft.title, chunk, i === 0 ? draft.keywords : []) })),
  );
  const vectors: number[][] = [];
  for (let at = 0; at < texts.length; at += EMBED_BATCH) {
    vectors.push(...(await embedding(texts.slice(at, at + EMBED_BATCH).map((t) => t.text), ms)));
  }
  return texts.map((t, i) => ({ id: t.id, vector: vectors[i]! }));
}

function cosineDistance(a: number[], b: number[]) {
  let [dot, aa, bb] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(aa * bb) || 1);
}

async function searchArticles(context: ToolContext, query: string, k: number): Promise<string> {
  const ms = toolLimits(context.limits).embedMs;
  if (!embeddingsEnabled()) {
    return "Searching by meaning isn't available on this server; use read_article with a slug you know.";
  }
  let nearest: { id: string; distance: number }[];
  try {
    if (!draftVectors.has(context)) {
      draftVectors.set(context, embedDrafts(context.projectId, ms));
    }
    const [[vector], drafts] = await Promise.all([embedding([query], ms), draftVectors.get(context)!]);
    // A published article's distance is its nearest section's, as the pipeline finds articles.
    const published = await prisma.$queryRaw<{ id: string; distance: number }[]>`
      SELECT a.id, best.distance
      FROM (
        SELECT DISTINCT ON (c."articleId") c."articleId", c.embedding <=> ${toVectorLiteral(vector!)}::vector AS distance
        FROM article_chunk c
        WHERE c."projectId" = ${context.projectId}
        ORDER BY c."articleId", distance
      ) best
      JOIN article a ON a.id = best."articleId"
      WHERE a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a."sample" = false
      ORDER BY best.distance
      LIMIT ${k}`;
    const byDraft = new Map<string, number>();
    for (const draft of drafts) {
      byDraft.set(draft.id, Math.min(byDraft.get(draft.id) ?? Infinity, cosineDistance(vector!, draft.vector)));
    }
    nearest = [...published, ...[...byDraft].map(([id, distance]) => ({ id, distance }))].sort((a, b) => a.distance - b.distance).slice(0, k);
  } catch (error) {
    draftVectors.delete(context);
    // The embeddings service failing is the model's to work around; the database failing fails the analysis (it's retried).
    if (!(error instanceof EmbeddingFailed)) {
      throw error;
    }
    return `Searching articles failed: ${error.message}`;
  }
  if (nearest.length === 0) {
    return "The help center has no articles or drafts to search.";
  }
  const articles = await prisma.article.findMany({
    where: { id: { in: nearest.map((n) => n.id) } },
    select: { id: true, slug: true, title: true, publishedAt: true, changes: { select: { title: true } } },
  });
  const byId = new Map(articles.map((article) => [article.id, article]));
  const lines = nearest.flatMap(({ id, distance }) => {
    const article = byId.get(id);
    return article ? [`${article.slug}\t${article.changes?.title ?? article.title}\t${article.publishedAt ? "published" : "draft"}\t${distance.toFixed(3)}`] : [];
  });
  return ["slug\ttitle\tstate\tdistance", ...lines].join("\n");
}
