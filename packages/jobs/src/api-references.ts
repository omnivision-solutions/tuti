import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";

import { toPlainText } from "@tuti/content";
import { htmlToContent } from "@tuti/content/html";
import { type Prisma, prisma } from "@tuti/db";
import { contentHash, embed, EMBEDDING_MODEL, embeddingsEnabled, type JobInput, log as serverLog, toVectorLiteral } from "@tuti/shared";
import { type ApiDoc, type ApiReferenceState, type ApiServer, onHelpCenter, OPENAPI_MAX_BYTES, operationMarkdown, readSpec, settle, specHtml } from "@tuti/shared/api-reference";
import { isPrivate, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import { installationApi } from "./github-api";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { lockProject } from "./running-draft";

/**
 * API references read from where their spec lives (docs/plan.md, API reference in Docs, A10 and A11): a URL, or a file
 * in a repository the project added on GitHub, read when it's added, on Sync now and every 6 hours
 * (`syncApiReferences`); a repository's also when a pull request into its branch merges (`syncMergedApiReferences`).
 * The address is the team's, but our server fetches it, so it's treated as anyone's: https only, public addresses only
 * (on the address connected to, and on every redirect), a time and size limit, and nothing of ours (cookies,
 * credentials) sent. A repository is read with the app's installation, and only one the project added.
 */

export const SPEC_FETCH_TIMEOUT_MS = 15_000;
/** Redirects followed, each checked as the first address is. */
export const SPEC_MAX_REDIRECTS = 3;
/** How long after its last try a URL's reference is read again. */
export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * How a run spreads its reads: each host's references one at a time (no host gets two of Tuti's reads at once), 4 at
 * once, the hosts taking turns in the order of their oldest due reference (a host's next read waits behind the other
 * hosts', so every host with something due gets a read before any gets a second), and no read started after 8 minutes,
 * so the last ends inside the job's 10; the hourly job takes the rest next time. A host is bounded by that time, not by
 * a count: one answering in a second or two gets a hundred or more of its references read a run. The run reads its
 * candidates per host in SQL, at most SYNC_ROWS_PER_HOST each (more than a host gets through in a run), every host's
 * first before any host's second, so no number of busy hosts' backlogs fills the window and keeps another host's
 * reference waiting.
 */
const HOSTS_AT_ONCE = 4;
export const SYNC_BUDGET_MS = 8 * 60_000;
/** Whether a run's time is up: `ms` from now. Tests pass their own, counted in reads. */
export const budget = (ms: number) => {
  const until = Date.now() + ms;
  return () => Date.now() >= until;
};
export const SYNC_ROWS_PER_HOST = 500;
export const SYNC_CANDIDATES = 5_000;

export const SPEC_URL_TOO_LARGE = "The spec at this address is over 5 MB, the most an API reference reads.";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/** Why an address can't be fetched at all, before connecting; null when it can. */
function refusal(url: URL, allowLoopback: boolean): string | null {
  if (url.username || url.password) {
    return "Leave credentials out of the address: Tuti reads public specs only.";
  }
  if (loopback(url, allowLoopback) || process.env.WEBHOOK_ALLOW_PRIVATE_URLS === "true") {
    return url.protocol === "https:" || url.protocol === "http:" ? null : "Enter an address that starts with https://";
  }
  if (url.protocol !== "https:") {
    return "Enter an address that starts with https://";
  }
  // A name is checked on the address connected to (publicOnlyLookup); an IP address looks nothing up, so here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) && isPrivate(host) ? PRIVATE : null;
}

const PRIVATE = "Tuti reads specs only from public addresses.";

/** Tests only: a fake on this machine, over http. */
const loopback = (url: URL, allowLoopback: boolean) => allowLoopback && (url.hostname === "127.0.0.1" || url.hostname === "localhost");

/**
 * Why `url` would be refused before anything is fetched (it isn't an address, isn't https, has credentials or is a
 * private IP address), or null when it would be fetched: what's refused here costs nothing, so the team's fetch limits
 * count only the rest.
 */
export function specUrlRefusal(url: string): string | null {
  const parsed = URL.parse(url);
  return parsed ? refusal(parsed, false) : NOT_AN_ADDRESS;
}

const NOT_AN_ADDRESS = "Enter a full address, like https://example.com/openapi.json";

/**
 * The text at `url` and the address that served it (`url` after redirects: what its relative servers are on), or why
 * it couldn't be read, in words for the team. `allowLoopback` is for tests: a fake on this
 * machine over http (WEBHOOK_ALLOW_PRIVATE_URLS lets self-hosters, and journeys, read private addresses as webhooks do).
 */
export async function fetchSpec(url: string, { allowLoopback = false }: { allowLoopback?: boolean } = {}): Promise<{ text: string; url: string } | { error: string }> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { error: NOT_AN_ADDRESS };
  }
  // One limit for the whole read, redirects and body included.
  const signal = AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const refused = refusal(current, allowLoopback);
      if (refused) {
        return { error: refused };
      }
      const open = loopback(current, allowLoopback) || process.env.WEBHOOK_ALLOW_PRIVATE_URLS === "true";
      const response = await fetch(current, {
        redirect: "manual",
        signal,
        // undici's fetch keeps no cookies, and the address has no credentials: only these go.
        headers: { accept: "application/json, application/yaml, text/yaml, application/graphql, text/plain, */*", "user-agent": "Tuti-API-Reference/1" },
        ...(!open && { dispatcher: publicOnly }),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= SPEC_MAX_REDIRECTS) {
          return { error: "The address redirected too many times." };
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { error: `The address answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.` };
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > OPENAPI_MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        return { error: SPEC_URL_TOO_LARGE };
      }
      const bytes = await readUpTo(response.body as ReadableStream<Uint8Array> | null, OPENAPI_MAX_BYTES);
      return bytes ? { text: bytes.toString("utf8"), url: current.href } : { error: SPEC_URL_TOO_LARGE };
    }
  } catch (error) {
    const { name, cause } = error as { name?: string; cause?: { code?: string; name?: string } };
    if (name === "TimeoutError" || cause?.name === "TimeoutError" || signal.aborted) {
      return { error: `The address didn't answer within ${SPEC_FETCH_TIMEOUT_MS / 1000} seconds.` };
    }
    if (cause?.code === "EPRIVATE") {
      return { error: PRIVATE };
    }
    if (cause?.code === "ENOTFOUND" || cause?.code === "ENODATA") {
      return { error: `${current.hostname} can't be found.` };
    }
    return { error: `Couldn't reach ${current.hostname}.` };
  }
}

/** A stream's bytes, or null once it's over `max`: read no further than that. */
async function readUpTo(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (!stream) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks);
    }
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

export const GITHUB_NOT_ADDED = "This repository isn't one of the project's. Add it in Settings › Integrations › GitHub first.";

/**
 * Why `path` can't be a file's path in a repository, or null when it can. Its parts go into the contents API's address
 * as they are, so an empty, "." or ".." part (which would move the request elsewhere on GitHub's API) is refused.
 */
export function repoPathRefusal(path: string): string | null {
  return path.split("/").some((part) => part === "" || part === "." || part === "..") ? "Enter the file's path in the repository, like openapi.yaml" : null;
}

/**
 * The file at `path` on branch `ref` (left out: the repository's default branch) of repository `repoId`, read with the
 * app's installation, and the branch it was read on; or why it couldn't be, in words for the team. Only a repository
 * `projectId` added is read, whatever is asked: the project's own row says which installation, and under what name.
 * The same limits as a URL's: 5 MB, read as a stream and stopped there, and 15 seconds for all of it.
 */
export async function fetchGithubSpec(
  projectId: string,
  source: { repoId: number; path: string; ref?: string | null },
  /** Tests only: the read's deadline, ended when they say (it's SPEC_FETCH_TIMEOUT_MS from now). */
  { signal: deadline }: { signal?: AbortSignal } = {},
): Promise<{ text: string; ref: string } | { error: string }> {
  const refused = repoPathRefusal(source.path);
  if (refused) {
    return { error: refused };
  }
  const repo = await prisma.githubRepository.findFirst({
    where: { repoId: source.repoId, connection: { projectId } },
    select: { fullName: true, connection: { select: { installationId: true } } },
  });
  if (!repo) {
    return { error: GITHUB_NOT_ADDED };
  }
  const { fullName } = repo;
  // One limit for all of it: the token, the default branch, the file, and the reads saying what's missing.
  const signal = deadline ?? AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS);
  try {
    const api = await installationApi(repo.connection.installationId, signal);
    // ponytail: the default branch costs a read of its own; only when none is given (adding one without a branch).
    const ref = source.ref || (await api.find<{ default_branch: string }>(`/repos/${fullName}`))?.default_branch;
    if (!ref) {
      return { error: `Tuti's GitHub app can't see ${fullName} any more.` };
    }
    const path = source.path.split("/").map(encodeURIComponent).join("/");
    const response = await api.raw(`/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`, signal);
    if (!response) {
      // Which of them is missing: reads only when a read failed.
      if (!(await api.find(`/repos/${fullName}`))) {
        return { error: `Tuti's GitHub app can't see ${fullName} any more.` };
      }
      if (!(await api.find(`/repos/${fullName}/branches/${encodeURIComponent(ref)}`))) {
        return { error: `${fullName} has no branch “${ref}”.` };
      }
      return { error: `There's no file at ${source.path} on ${ref} in ${fullName}.` };
    }
    if (Number(response.headers.get("content-length")) > OPENAPI_MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      return { error: SPEC_FILE_TOO_LARGE };
    }
    const bytes = await readUpTo(response.body as ReadableStream<Uint8Array> | null, OPENAPI_MAX_BYTES);
    return bytes ? { text: bytes.toString("utf8"), ref } : { error: SPEC_FILE_TOO_LARGE };
  } catch (error) {
    const { name, cause } = error as { name?: string; cause?: { name?: string } };
    if (name === "TimeoutError" || cause?.name === "TimeoutError" || signal.aborted) {
      return { error: `GitHub didn't answer within ${SPEC_FETCH_TIMEOUT_MS / 1000} seconds.` };
    }
    // The installation gone (401, 404) or suspended (a 403 that isn't a rate limit); GitHub's own trouble (a 503, a rate
    // limit) is the message below, not this.
    const { status, rateLimited } = error as { status?: number; rateLimited?: boolean };
    if (status === 401 || status === 404 || (status === 403 && !rateLimited)) {
      return { error: "Tuti's GitHub app can't reach this repository any more. Connect GitHub again in Settings › Integrations." };
    }
    return { error: "Couldn't read the file from GitHub. Try again later." };
  }
}

export const SPEC_FILE_TOO_LARGE = "The file is over 5 MB, the most an API reference reads.";

/** What PostgreSQL stores in neither text nor JSON: a null character, or a surrogate without its other half. */
const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string anywhere in `value` (JSON; a key too) has one. */
function unstorable(value: unknown): boolean {
  if (typeof value === "string") return UNSTORABLE.test(value);
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(value) ? value.some(unstorable) : Object.entries(value).some(([key, inner]) => UNSTORABLE.test(key) || unstorable(inner));
}

/** A server's address without a scheme ("/v1", "//api.example.com"), which OpenAPI reads as relative to where the spec is. */
const RELATIVE = /^(?![a-z][a-z0-9+.-]*:|\{)/i;

/** A relative server on the spec's own address, `{variables}` kept as written (URL would encode their braces); null when it can't be ("//"). */
function resolved(server: string, from: string): string | null {
  const url = URL.parse(server, from);
  return url && url.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

/**
 * A spec's text as a doc to store, or why it can't be one, in the reader's words: one with no operations has nothing
 * to show, and one with a character PostgreSQL can't store is refused. `from`, the address that served it (a URL's
 * reference, after redirects), is what its relative servers are on.
 */
export function readStorable(text: string, from?: string): { doc: ApiDoc } | { error: string } {
  const result = readSpec(text);
  if ("error" in result) {
    return result;
  }
  if (result.doc.operations.length === 0) {
    return { error: "This spec has no operations to show." };
  }
  let read = result.doc;
  if (from) {
    // One that can't be resolved stays as written, with its warning.
    const unresolved = new Set<string>();
    const on = (servers: ApiServer[]) =>
      servers.map((server) => {
        if (!RELATIVE.test(server.url)) return server;
        const url = resolved(server.url, from);
        if (url === null) unresolved.add(server.url);
        return url === null ? server : { ...server, url };
      });
    read = {
      ...read,
      servers: on(read.servers),
      operations: read.operations.map((operation) => (operation.servers ? { ...operation, servers: on(operation.servers) } : operation)),
    };
    // A warning's place ends with the server it's about.
    read.warnings = read.warnings.filter((warning) => warning.code !== "RELATIVE_SERVER" || [...unresolved].some((url) => warning.where.endsWith(` › ${url}`)));
  }
  // As it's stored (no undefined values), so a doc read again compares equal to the stored one.
  const doc = JSON.parse(JSON.stringify(read)) as ApiDoc;
  if (UNSTORABLE.test(text) || unstorable(doc)) {
    return {
      error:
        "This spec has a character that can't be stored: a null character (\\u0000) or half of a surrogate pair (\\ud800–\\udfff). Remove it and try again.",
    };
  }
  return { doc };
}

/** The columns lists read, kept beside the state they count. */
export const referenceCounts = (doc: ApiDoc, state: ApiReferenceState) => ({
  operationCount: doc.operations.length,
  shownCount: onHelpCenter(doc, state).operations.length,
  unseenCount: state.unseen.length,
});

/** What the reference's new spec changed, by operations' keys: for the toast and the API's answer. */
export type SpecChanges = { added: number; removed: number; changed: boolean };

/**
 * A new read of a reference's spec over what it had: the team's choices carried across (`settle`), as columns to
 * write, what changed, and the keys of the operations on the help center after it (`shown`, for dropHidden). For an
 * upload replaced by hand and a URL synced alike.
 */
export function respec(
  row: { doc: unknown; state: unknown },
  text: string,
  next: ApiDoc,
  now = new Date(),
): { data: Prisma.ApiReferenceUncheckedUpdateInput; changes: SpecChanges; shown: string[] } {
  const before = row.doc as ApiDoc;
  const { doc, state } = settle({ doc: before, state: row.state as ApiReferenceState }, next);
  const had = new Set(before.operations.map((operation) => operation.key));
  const has = new Set(doc.operations.map((operation) => operation.key));
  const changed = !isDeepStrictEqual(doc, row.doc);
  return {
    data: {
      format: doc.format === "graphql" ? "GRAPHQL" : "OPENAPI",
      spec: text,
      doc: doc as unknown as Prisma.InputJsonValue,
      state: state as unknown as Prisma.InputJsonValue,
      ...referenceCounts(doc, state),
      syncedAt: now,
      syncTriedAt: now,
      ...(changed && { changedAt: now }),
      syncError: null,
    },
    changes: { added: [...has].filter((key) => !had.has(key)).length, removed: [...had].filter((key) => !has.has(key)).length, changed },
    shown: onHelpCenter(doc, state).operations.map((operation) => operation.key),
  };
}

/** Where a reference's spec was when a sync was chosen: one moved or synced since is left alone. */
export type SourceAt = { sourceUrl: string | null; repoId?: number | null; path?: string | null; ref?: string | null; syncTriedAt: Date };

/**
 * Takes what's no longer on the help center (`shown`: the keys of what is) out of the docs' search and AI answers at
 * once, in the change's transaction, with the project locked: the job that indexes the rest (indexReference) may run
 * late, or not be queued at all. The reference's row is locked here too, so a job writing (it holds both) finishes first
 * and the delete sees what it wrote.
 */
export async function dropHidden(tx: Prisma.TransactionClient, referenceId: string, shown: string[]) {
  await tx.$queryRaw`SELECT 1 FROM api_reference WHERE id = ${referenceId} FOR UPDATE`;
  await tx.apiOperationEntry.deleteMany({ where: { referenceId, key: { notIn: shown } } });
}

/**
 * Indexes a reference's operations for the docs' search and AI answers (apiReferenceChanged), once what's on the help
 * center, or what an operation's page says, may have changed: when it's added, its spec replaced or synced with a change,
 * what's hidden or its base address changed. Never fails the change: it's logged, and the next change indexes it again.
 * ponytail: until that job runs, what a change added or reworded is searched as it was before (what it took off the
 * help center is gone at once: dropHidden).
 */
export async function indexReference(referenceId: string) {
  try {
    await enqueue("apiReferenceChanged", { referenceId });
  } catch (error) {
    serverLog.error("Indexing an API reference for search failed", { referenceId, error });
  }
}

/**
 * Reads a URL's or a repository's reference `id` again. What it read replaces the doc, the team's choices kept; a read
 * that fails (or finds no operations) keeps the pages as they were and says why (`syncError`). Null when there's
 * nothing to sync: the reference is gone, was uploaded, its source changed while this read the old one, or another
 * sync (Sync now beside the 6-hourly one) finished while this one read: its answer is newer, so this one's is dropped.
 */
export async function syncApiReference(
  id: string,
  options: {
    allowLoopback?: boolean;
    /**
     * The reference as whoever chose to sync it saw it (the job's queue, Sync now's check of its source): one moved or
     * synced since is left alone, unfetched, until it's chosen again as it is.
     */
    expected?: SourceAt;
  } = {},
): Promise<{ changes: SpecChanges } | { error: string } | null> {
  const found = await prisma.apiReference.findUnique({
    where: { id },
    select: { projectId: true, source: true, sourceUrl: true, repoId: true, path: true, ref: true, syncTriedAt: true },
  });
  if (!found || found.source === "UPLOAD") {
    return null;
  }
  const { expected } = options;
  if (
    expected &&
    (expected.sourceUrl !== found.sourceUrl ||
      (expected.repoId ?? null) !== found.repoId ||
      (expected.path ?? null) !== found.path ||
      (expected.ref ?? null) !== found.ref ||
      expected.syncTriedAt.getTime() !== found.syncTriedAt.getTime())
  ) {
    return null;
  }
  const { projectId, source, sourceUrl, repoId, path, ref, syncTriedAt } = found;
  let fetched: { text: string; url?: string } | { error: string };
  if (source === "URL") {
    fetched = sourceUrl ? await fetchSpec(sourceUrl, options) : { error: NOT_AN_ADDRESS };
  } else {
    fetched = repoId !== null && path && ref ? await fetchGithubSpec(projectId, { repoId, path, ref }) : { error: GITHUB_NOT_ADDED };
  }
  // A repository's file has no address of its own, so its relative servers stay as written, as an upload's do.
  const read = "error" in fetched ? fetched : readStorable(fetched.text, fetched.url);
  const result = await prisma.$transaction(async (tx): Promise<{ changes: SpecChanges } | { error: string } | null> => {
    // Locked, so a choice saved meanwhile (apiReferences.update) isn't written over.
    await lockProject(tx, projectId);
    // Every sync's write moves syncTriedAt on: unchanged, nothing has written since this one started.
    const row = await tx.apiReference.findFirst({ where: { id, source, sourceUrl, repoId, path, ref, syncTriedAt }, select: { doc: true, state: true } });
    if (!row) {
      return null;
    }
    const now = new Date();
    if ("error" in read) {
      await tx.apiReference.update({ where: { id }, data: { syncError: read.error, syncTriedAt: now } });
      return { error: read.error };
    }
    const { data, changes, shown } = respec(row, (fetched as { text: string }).text, read.doc, now);
    await tx.apiReference.update({ where: { id }, data });
    await dropHidden(tx, id, shown);
    return { changes };
  });
  // A read that changed the doc: its operations in search as they now are. One that changed nothing needs nothing.
  if (result && "changes" in result && result.changes.changed) {
    await indexReference(id);
  }
  return result;
}

/**
 * A pull request merged into branch `base` of repository `repoId`, in project `projectId`: each of the project's
 * references read from that branch of it is read again, when the pull request changed its file (as a file of it, or one
 * renamed from it; one with more files than GitHub lists, 3,000, always). `files` lists the pull request's, read only
 * when a reference is on that branch. A failure is said on the reference's page, as the 6-hourly sync's is.
 */
export async function syncMergedApiReferences(
  projectId: string,
  { repoId, base }: { repoId: number; base: string },
  files: () => Promise<{ filename: string; previous_filename?: string }[]>,
  log: JobLogger,
): Promise<{ synced: number; failed: number }> {
  const references = await prisma.apiReference.findMany({
    where: { projectId, source: "GITHUB", repoId, ref: base },
    // Oldest first: the same order each time.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, sourceUrl: true, repoId: true, path: true, ref: true, syncTriedAt: true },
  });
  let [synced, failed] = [0, 0];
  if (references.length === 0) {
    return { synced, failed };
  }
  const changed = await files();
  const paths = new Set(changed.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]));
  for (const reference of references) {
    if (changed.length < 3_000 && !paths.has(reference.path!)) {
      continue;
    }
    try {
      // Overtaken by another sync (Sync now, the 6-hourly one, another merge's) that may have read the file before this
      // merge: read again while the file is where it was, a few times at most.
      let at: typeof reference | null = reference;
      for (let tries = 0; at && tries < 3; tries++) {
        const result = await syncApiReference(at.id, { expected: at });
        if (result) {
          if ("error" in result) failed++;
          else synced++;
          break;
        }
        at = await prisma.apiReference.findFirst({
          where: { id: reference.id, source: "GITHUB", repoId: reference.repoId, path: reference.path, ref: reference.ref },
          select: { id: true, sourceUrl: true, repoId: true, path: true, ref: true, syncTriedAt: true },
        });
      }
    } catch (error) {
      // One that can't be written stops none of the others.
      failed++;
      log.warn(`Syncing an API reference after a merge failed: ${String(error)}`);
    }
  }
  return { synced, failed };
}

/** The 6-hourly job's name for GitHub among the hosts it reads from: no address's host has a space. */
const GITHUB_HOST = "github api";

/**
 * Every 6 hours, each URL's and repository's reference read again: the ones whose last try is oldest first, a few hosts
 * at once and one reference at a time per host, so no team's server gets them all together. GitHub is one host among
 * them (a repository's file is also read when a pull request into its branch merges, so this is its safety net). One
 * that fails says so on its page and is tried again next time it's due; it stops none of the others.
 */
export async function syncApiReferences(
  _: unknown,
  log: JobLogger,
  now = new Date(),
  /** Whether the run's time is up, asked before each read with the reference it would be (tests see the order by it). */
  over: (next: { id: string; sourceUrl: string | null }) => boolean | Promise<boolean> = budget(SYNC_BUDGET_MS),
  candidates = SYNC_CANDIDATES,
): Promise<JobResult> {
  // The oldest due per host (its name, lowercased, as URL gives it: the port, credentials and path left off; GitHub's
  // GITHUB_HOST, which no address's name is). The address is stored as URL writes it (`href`), so this is the name
  // URL.hostname gives, an IPv6 address bracketed.
  const due = await prisma.$queryRaw<(SourceAt & { id: string; source: "URL" | "GITHUB" })[]>`
    SELECT id, source, "sourceUrl", "repoId", path, ref, "syncTriedAt" FROM (
      SELECT id, source, "sourceUrl", "repoId", path, ref, "syncTriedAt",
        row_number() OVER (
          PARTITION BY CASE WHEN source = 'GITHUB' THEN ${GITHUB_HOST}::text
            ELSE lower(substring("sourceUrl" from '^[^:]+://(?:[^/?#@]*@)?(\\[[^]]*\\]|[^/?#:]+)')) END
          ORDER BY "syncTriedAt", id) AS place
      FROM api_reference
      WHERE source IN ('URL', 'GITHUB') AND "syncTriedAt" <= ${new Date(now.getTime() - SYNC_EVERY_MS)}
    ) due
    WHERE place <= ${SYNC_ROWS_PER_HOST}
    -- Each host's first before any host's second: busy hosts can't fill the window between them.
    ORDER BY place, "syncTriedAt", id
    LIMIT ${candidates}`;
  const byHost = new Map<string, typeof due>();
  for (const row of due) {
    const host = row.source === "GITHUB" ? GITHUB_HOST : (URL.parse(row.sourceUrl ?? "")?.hostname ?? "");
    byHost.set(host, [...(byHost.get(host) ?? []), row]);
  }
  // Each host with its references due, how many it's had read this run, and whether one is being read now; in the order
  // of their oldest due reference (the rows come oldest first), which breaks ties.
  const hosts = [...byHost.values()].map((ids) => ({ ids, reads: 0, reading: false }));
  /** The next host to read: of those not being read now with something left, the one with the fewest reads this run. */
  const next = () => {
    let pick: (typeof hosts)[number] | undefined;
    for (const host of hosts) {
      if (!host.reading && host.ids.length > 0 && (!pick || host.reads < pick.reads)) {
        pick = host;
      }
    }
    return pick;
  };
  let [synced, failed] = [0, 0];
  // Never two reads on one host at once, and no host a read ahead of another that's free: every host with something due
  // gets a read before any gets a second, however long each read takes. A worker with no host free stops; the others
  // are reading the rest.
  const worker = async () => {
    for (let host = next(); host; host = next()) {
      // Chosen and taken in one step, nothing awaited between: no other worker picks it, or counts it, meanwhile. Given
      // back if the run's time is up.
      host.reading = true;
      host.reads++;
      const chosen = host.ids.shift()!;
      if (await over(chosen)) {
        host.ids.unshift(chosen);
        host.reads--;
        host.reading = false;
        return;
      }
      try {
        // As it was chosen: one moved or synced since it was queued is left for the next run, and counted as neither.
        const result = await syncApiReference(chosen.id, { expected: chosen });
        if (result && "error" in result) {
          failed++;
        } else if (result) {
          synced++;
        }
      } catch (error) {
        failed++;
        log.warn(`Syncing an API reference failed: ${String(error)}`);
      } finally {
        host.reading = false;
      }
    }
  };
  await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, worker));
  return { synced, failed };
}

/**
 * How much of an operation's Markdown AI answers get and its meaning is embedded from: its start (title, method and path,
 * description, parameters, then its body), an article section's length or so a few times over.
 */
export const OPERATION_TEXT_LENGTH = 4000;
/** Texts per embeddings request. */
const EMBED_BATCH = 100;

const referenceSelect = { projectId: true, baseUrl: true, changedAt: true, doc: true, state: true } as const;

/** Text with something Markdown would read: a mark, an entity, or an address or email it would link. */
const MARKED = /[\\`*_[\]<>#|~&=@]|:\/\/|www\./;

/**
 * A spec's Markdown as plain words (as the portal shows it: through the same converter), for search's words and snippet.
 * Most descriptions are a plain sentence or two: those are their own words, their lines joined, with no converter (it
 * takes milliseconds an operation, and a spec may have thousands).
 */
async function plainWords(markdown: string): Promise<string> {
  if (!markdown.trim()) {
    return "";
  }
  if (!MARKED.test(markdown)) {
    return markdown
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }
  const content = await htmlToContent("article", specHtml(markdown));
  return "error" in content ? markdown : toPlainText(content.doc);
}

/** What a reference's entries should be: one per operation on the help center (onHelpCenter), never a hidden one. */
async function entriesOf(reference: { baseUrl: string | null; doc: unknown; state: unknown }) {
  const doc = reference.doc as ApiDoc;
  const { operations } = onHelpCenter(doc, reference.state as ApiReferenceState);
  return Promise.all(
    operations.map(async (operation) => {
      const text = operationMarkdown(doc, operation, { base: reference.baseUrl ?? undefined }).slice(0, OPERATION_TEXT_LENGTH);
      const description = await plainWords(operation.description);
      return {
        key: operation.key,
        slug: operation.slug,
        kind: operation.kind,
        path: operation.path,
        title: operation.title,
        description,
        // What search matches besides its title: its method, path (as written, and as words: Postgres reads "/users/{id}"
        // as one token, which "users" wouldn't match), description and parameters' names.
        words: [operation.kind, operation.path, operation.path.split(/[^\p{L}\p{N}]+/u).join(" "), description, ...operation.params.map((param) => param.name)].join("\n"),
        text,
        hash: contentHash(text),
      };
    }),
  );
}

/** Whether two reads of a reference index the same: its spec's last change, what's hidden and its base address (not what's new, say). */
function sameAs(a: { changedAt: Date; state: unknown; baseUrl: string | null }, b: typeof a) {
  const hidden = (state: unknown) => {
    const { hiddenOperations, hiddenGroups } = state as ApiReferenceState;
    return JSON.stringify([hiddenOperations, hiddenGroups]);
  };
  return a.changedAt.getTime() === b.changedAt.getTime() && a.baseUrl === b.baseUrl && hidden(a.state) === hidden(b.state);
}

/** How long the write may take (Prisma's default for a transaction is 5 seconds): one statement, but a spec of thousands of operations is a large one. */
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Keeps an API reference's operations in the docs' search and AI answers (`api_operation_entry`): one entry per operation
 * on the help center, with its words and Markdown, and its embedding when embeddings are set up (one whose text is
 * unchanged keeps its own, so only what changed is embedded again). Queued when a reference is added or replaced, and
 * when what's hidden changes; a deleted reference's go with it. Whether a reader may see one (published, in a tab they may
 * read) is checked when they search, so publishing and a tab's access need nothing here. Safe to run late, twice or out
 * of order: entries are written only while the reference still reads as it did.
 *
 * Embedding comes first, outside the write's locks. When it fails, the entries are written anyway (word search needs
 * them), those it didn't reach without a vector, and then it throws so the job is tried again for the vectors, as
 * articles' embedding is.
 */
export async function apiReferenceChanged({ referenceId }: JobInput<"apiReferenceChanged">, log: JobLogger): Promise<JobResult> {
  const reference = await prisma.apiReference.findUnique({ where: { id: referenceId }, select: referenceSelect });
  if (!reference) {
    return { skipped: true };
  }
  const entries = await entriesOf(reference);
  // The ones whose stored embedding is of their text as it is: kept, never sent again.
  const embedded = new Set(
    (
      await prisma.$queryRaw<{ key: string; contentHash: string }[]>`
        SELECT key, "contentHash" FROM api_operation_entry WHERE "referenceId" = ${referenceId} AND embedding IS NOT NULL`
    ).map((row) => `${row.contentHash} ${row.key}`),
  );
  const missing = entries.filter((entry) => !embedded.has(`${entry.hash} ${entry.key}`));
  const vectors = new Map<string, string>();
  let failure: unknown = null;
  if (embeddingsEnabled()) {
    try {
      for (let at = 0; at < missing.length; at += EMBED_BATCH) {
        const batch = missing.slice(at, at + EMBED_BATCH);
        const made = await embed(batch.map((entry) => entry.text));
        batch.forEach((entry, i) => vectors.set(entry.key, toVectorLiteral(made[i]!)));
      }
    } catch (error) {
      failure = error;
      log.warn(`API reference ${referenceId}: embedding failed, so ${missing.length - vectors.size} operation(s) are searched by their words only until it's tried again`);
    }
  }
  const column = <K extends keyof (typeof entries)[number]>(key: K) => entries.map((entry) => entry[key]);
  const written = await prisma.$transaction(
    async (tx) => {
      // Locked, so a change can't slip in between this check and the write: the project first, then the reference, the
      // order a change to it takes them in (apiReferences.update and .replace), so neither waits on the other in turn
      // (an entry's insert takes a key share of the project's row, which a change's project lock holds up).
      await lockProject(tx, reference.projectId);
      await tx.$queryRaw`SELECT 1 FROM api_reference WHERE id = ${referenceId} FOR UPDATE`;
      const latest = await tx.apiReference.findUnique({ where: { id: referenceId }, select: referenceSelect });
      if (!latest || !sameAs(latest, reference)) {
        return false;
      }
      // What's gone goes; the rest is updated in place by its key, keeping its id: an answer being written cites operations
      // by it (stillUsable), so a reindex meanwhile mustn't drop one that's still there.
      const keys = column("key");
      await tx.$executeRaw`DELETE FROM api_operation_entry WHERE "referenceId" = ${referenceId} AND NOT (key = ANY(${keys}::text[]))`;
      // Every entry in one statement, so the locks are held for one round trip. An embedding is sent only when it's new: an
      // entry with none sent keeps its own while its text is the same, and loses it once it isn't.
      const embeddings = entries.map((entry) => vectors.get(entry.key) ?? null);
      await tx.$executeRaw`
        INSERT INTO api_operation_entry (id, "referenceId", "projectId", key, slug, kind, path, title, description, words, text, model, "contentHash", embedding)
        SELECT gen_random_uuid()::text, ${referenceId}, ${reference.projectId}, e.key, e.slug, e.kind, e.path, e.title, e.description, e.words, e.text,
          CASE WHEN e.embedding IS NULL THEN NULL ELSE ${EMBEDDING_MODEL} END, e.hash, e.embedding::vector
        FROM unnest(${keys}::text[], ${column("slug")}::text[], ${column("kind")}::text[], ${column("path")}::text[], ${column("title")}::text[],
          ${column("description")}::text[], ${column("words")}::text[], ${column("text")}::text[], ${column("hash")}::text[], ${embeddings}::text[])
          AS e(key, slug, kind, path, title, description, words, text, hash, embedding)
        ON CONFLICT ("referenceId", key) DO UPDATE SET slug = EXCLUDED.slug, kind = EXCLUDED.kind, path = EXCLUDED.path, title = EXCLUDED.title,
          description = EXCLUDED.description, words = EXCLUDED.words, text = EXCLUDED.text, "contentHash" = EXCLUDED."contentHash",
          model = CASE WHEN EXCLUDED.embedding IS NULL AND api_operation_entry."contentHash" = EXCLUDED."contentHash" THEN api_operation_entry.model ELSE EXCLUDED.model END,
          embedding = CASE WHEN EXCLUDED.embedding IS NULL AND api_operation_entry."contentHash" = EXCLUDED."contentHash" THEN api_operation_entry.embedding ELSE EXCLUDED.embedding END`;
      return true;
    },
    { timeout: WRITE_TIMEOUT_MS },
  );
  if (!written) {
    log.info(`API reference ${referenceId} changed while it was being indexed; left to the newer job`);
    return { skipped: true };
  }
  if (failure) {
    throw failure;
  }
  return { skipped: false, entries: entries.length, embedded: vectors.size };
}

/** For the backfill: indexes every API reference (an unchanged operation keeps its embedding), carrying on past failures. */
export async function indexApiReferences(log: JobLogger): Promise<{ references: number; failed: string[] }> {
  const references = await prisma.apiReference.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  const failed: string[] = [];
  for (const { id } of references) {
    try {
      await apiReferenceChanged({ referenceId: id }, log);
    } catch (error) {
      log.warn(`API reference ${id} wasn't indexed: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(id);
    }
  }
  return { references: references.length, failed };
}
