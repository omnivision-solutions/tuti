import { posix } from "node:path";
import { Worker } from "node:worker_threads";

import { type Doc, toChunks, toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";
import { articleChunkText, embed, embeddingsEnabled, toVectorLiteral } from "@tuti/shared";
import { z } from "zod";

import { docOf } from "./article-layers";
import { maskSecrets } from "./pull-request";
import type { Repository } from "./repository";

/**
 * The docs agent's read-only tools (docs/plan.md, Autopilot's docs agent): the repository at the pull request's merge
 * commit, and the project's help center. Each answer is text for the model, capped; a mistake (bad arguments, an
 * unknown tool, a missing file, an invalid or slow pattern) comes back as a short sentence it can act on, never a throw.
 */

/** Each tool's caps. */
export const TOOL_LIMITS = {
  listChars: 30_000,
  fileChars: 60_000,
  searchLines: 60,
  searchChars: 20_000,
  /** How long a search may take: the model writes the pattern, and a regular expression can backtrack for ages. */
  searchMs: 5_000,
  articleChars: 20_000,
  articles: 8,
  maxArticles: 20,
};
export type ToolLimits = typeof TOOL_LIMITS;

/** What the tools read: the project's help center, and its repository at the merge commit (or why it's not there). */
export type ToolContext = { projectId: string; repository: Repository | { unavailable: string }; limits?: Partial<ToolLimits> };

/** The tools, in OpenAI's function-calling format. */
export function docsAgentTools(limits: Partial<ToolLimits> = {}) {
  const { fileChars, searchLines } = { ...TOOL_LIMITS, ...limits };
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
    tool("read_article", "A help center article's or draft's text (Markdown) by slug.", { slug: { type: "string" } }, ["slug"]),
    tool(
      "search_articles",
      "The help center's articles and drafts nearest a query (by meaning): slug, title, state.",
      { query: { type: "string" }, k: { type: "integer", description: `How many (default ${TOOL_LIMITS.articles}, at most ${TOOL_LIMITS.maxArticles})` } },
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
  const limits = { ...TOOL_LIMITS, ...context.limits };
  const schema = ARGUMENTS[call.name as keyof typeof ARGUMENTS];
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

// Plain JavaScript, run in a worker thread: it's terminated when the search takes too long.
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { pattern, files, max } = workerData;
const re = new RegExp(pattern, "i");
const found = [];
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
`;

async function searchCode({ files }: Repository, pattern: string, limits: ToolLimits): Promise<string> {
  try {
    new RegExp(pattern, "i");
  } catch (error) {
    return `Invalid pattern: ${(error as Error).message}`;
  }
  // ponytail: the files are copied to each search's worker; a long-lived worker holding them if searches get slow.
  const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { pattern, files: [...files], max: limits.searchLines } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await new Promise<[string, number, string][] | null>((resolve, reject) => {
      timer = setTimeout(() => resolve(null), limits.searchMs);
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    if (!found) {
      return "Search took too long; try a simpler pattern.";
    }
    if (found.length === 0) {
      return `No lines match ${pattern}.`;
    }
    const lines = found.slice(0, limits.searchLines).map(([path, line, text]) => `${path}:${line}: ${maskSecrets(text)}`);
    const more = found.length > limits.searchLines ? `\n[more lines match; the first ${limits.searchLines} are shown]` : "";
    return cut(lines.join("\n"), limits.searchChars) + more;
  } catch (error) {
    return `Search failed: ${(error as Error).message}`;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
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
    return `There's no article or draft with the slug ${slug}.`;
  }
  // Its newest text: the unpublished changes, where Autopilot's other edits wait too.
  const newest = article.changes ?? article;
  return cut(`Title: ${newest.title}\nState: ${stateOf(article)}\n\n${toMarkdown(docOf(newest))}`, limits.articleChars);
}

/** Drafts aren't embedded (only published articles' sections are): each search's tool context embeds them once. */
const draftVectors = new WeakMap<ToolContext, Promise<{ id: string; vector: number[] }[]>>();
/** The drafts embedded for a search, newest first. ponytail: a cap, not all of them; embed drafts as they're saved if projects keep more. */
const DRAFTS_EMBEDDED = 100;
/** Texts per embeddings request (OpenAI takes up to 2,048, and a cap on tokens). */
const EMBED_BATCH = 100;

async function embedDrafts(projectId: string) {
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
    vectors.push(...(await embed(texts.slice(at, at + EMBED_BATCH).map((t) => t.text))));
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
  if (!embeddingsEnabled()) {
    return "Searching by meaning isn't available on this server; use read_article with a slug you know.";
  }
  let nearest: { id: string; distance: number }[];
  try {
    if (!draftVectors.has(context)) {
      draftVectors.set(context, embedDrafts(context.projectId));
    }
    const [[vector], drafts] = await Promise.all([embed([query]), draftVectors.get(context)!]);
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
      WHERE a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
      ORDER BY best.distance
      LIMIT ${k}`;
    const byDraft = new Map<string, number>();
    for (const draft of drafts) {
      byDraft.set(draft.id, Math.min(byDraft.get(draft.id) ?? Infinity, cosineDistance(vector!, draft.vector)));
    }
    nearest = [...published, ...[...byDraft].map(([id, distance]) => ({ id, distance }))].sort((a, b) => a.distance - b.distance).slice(0, k);
  } catch (error) {
    draftVectors.delete(context);
    return `Searching articles failed: ${(error as Error).message}`;
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
