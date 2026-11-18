import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";

import { type Prisma, prisma } from "@tuti/db";
import { type ApiDoc, type ApiReferenceState, type ApiServer, onHelpCenter, OPENAPI_MAX_BYTES, readSpec, settle } from "@tuti/shared/api-reference";
import { isPrivate, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import type { JobLogger, JobResult } from "./index";
import { lockProject } from "./running-draft";

/**
 * API references read from where their spec lives (docs/plan.md, API reference in Docs, A10): a URL, fetched when it's
 * added, on Sync now and every 6 hours (`syncApiReferences`). The address is the team's, but our server fetches it, so
 * it's treated as anyone's: https only, public addresses only (on the address connected to, and on every redirect),
 * a time and size limit, and nothing of ours (cookies, credentials) sent.
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
 * write, and what changed. For an upload replaced by hand and a URL synced alike.
 */
export function respec(row: { doc: unknown; state: unknown }, text: string, next: ApiDoc, now = new Date()): { data: Prisma.ApiReferenceUncheckedUpdateInput; changes: SpecChanges } {
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
  };
}

/**
 * Reads a URL's reference `id` again. What it read replaces the doc, the team's choices kept; a read that fails (or
 * finds no operations) keeps the pages as they were and says why (`syncError`). Null when there's nothing to sync:
 * the reference is gone, isn't read from a URL, its address changed while this read the old one, or another sync
 * (Sync now beside the 6-hourly one) finished while this one read: its answer is newer, so this one's is dropped.
 */
export async function syncApiReference(id: string, options: { allowLoopback?: boolean } = {}): Promise<{ changes: SpecChanges } | { error: string } | null> {
  const found = await prisma.apiReference.findUnique({ where: { id }, select: { projectId: true, source: true, sourceUrl: true, syncTriedAt: true } });
  if (!found || found.source !== "URL" || !found.sourceUrl) {
    return null;
  }
  const url = found.sourceUrl;
  const fetched = await fetchSpec(url, options);
  const read = "error" in fetched ? fetched : readStorable(fetched.text, fetched.url);
  return prisma.$transaction(async (tx) => {
    // Locked, so a choice saved meanwhile (apiReferences.update) isn't written over.
    await lockProject(tx, found.projectId);
    // Every sync's write moves syncTriedAt on: unchanged, nothing has written since this one started.
    const row = await tx.apiReference.findFirst({ where: { id, source: "URL", sourceUrl: url, syncTriedAt: found.syncTriedAt }, select: { doc: true, state: true } });
    if (!row) {
      return null;
    }
    const now = new Date();
    if ("error" in read) {
      await tx.apiReference.update({ where: { id }, data: { syncError: read.error, syncTriedAt: now } });
      return { error: read.error };
    }
    const { data, changes } = respec(row, (fetched as { text: string }).text, read.doc, now);
    await tx.apiReference.update({ where: { id }, data });
    return { changes };
  });
}

/**
 * Every 6 hours, each URL's reference read again: the ones whose last try is oldest first, a few hosts at once and
 * one reference at a time per host, so no team's server gets them all together. One that fails says so on its page
 * and is tried again next time it's due; it stops none of the others.
 */
export async function syncApiReferences(
  _: unknown,
  log: JobLogger,
  now = new Date(),
  over = budget(SYNC_BUDGET_MS),
  candidates = SYNC_CANDIDATES,
): Promise<JobResult> {
  // The oldest due per host (its name, lowercased, as URL gives it: the port, credentials and path left off).
  const due = await prisma.$queryRaw<{ id: string; sourceUrl: string | null }[]>`
    SELECT id, "sourceUrl" FROM (
      SELECT id, "sourceUrl", "syncTriedAt",
        row_number() OVER (PARTITION BY lower(substring("sourceUrl" from '^[^:]+://(?:[^/?#@]*@)?([^/?#:]+)')) ORDER BY "syncTriedAt", id) AS place
      FROM api_reference
      WHERE source = 'URL' AND "syncTriedAt" <= ${new Date(now.getTime() - SYNC_EVERY_MS)}
    ) due
    WHERE place <= ${SYNC_ROWS_PER_HOST}
    -- Each host's first before any host's second: busy hosts can't fill the window between them.
    ORDER BY place, "syncTriedAt", id
    LIMIT ${candidates}`;
  const byHost = new Map<string, string[]>();
  for (const { id, sourceUrl } of due) {
    const host = URL.parse(sourceUrl ?? "")?.hostname ?? "";
    byHost.set(host, [...(byHost.get(host) ?? []), id]);
  }
  // Ranked by each host's oldest due reference (the rows come oldest first), not by how many: a busy host's backlog
  // never puts a host with one reference behind it.
  const hosts = [...byHost.values()];
  let [synced, failed] = [0, 0];
  // A host goes back at the end of the queue after each read, never into it twice: one read at a time per host, and
  // hosts with long backlogs take turns with the rest rather than holding every worker to the end of the budget.
  const worker = async () => {
    for (let ids = hosts.shift(); ids; ids = hosts.shift()) {
      if (over()) {
        return;
      }
      const id = ids.shift()!;
      try {
        const result = await syncApiReference(id);
        if (result && "error" in result) {
          failed++;
        } else {
          synced++;
        }
      } catch (error) {
        failed++;
        log.warn(`Syncing an API reference failed: ${String(error)}`);
      }
      if (ids.length > 0) {
        hosts.push(ids);
      }
    }
  };
  await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, worker));
  return { synced, failed };
}
