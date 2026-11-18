import { isIP } from "node:net";

import { prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { type TryInput, tryRequest } from "@tuti/shared/api-reference";
import { publicOnlyLookup } from "@tuti/shared/webhook-url";
import { getDomain } from "tldts";
import { Agent, fetch } from "undici";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { apiReferencePage } from "./api-reference-queries";
import { clientHash } from "./email-link-limits";

/**
 * Try it through Tuti (docs/plan.md, API reference in Docs, A12): a reader's request to the team's API, sent from our
 * server when the API doesn't take requests from browsers (CORS). Never a way to reach anyone else's site, or our own
 * network: it sends only what the operation's page could (`tryRequest`, made here again from what the reader filled
 * in), only to a server the spec names whose host is on a site the project has verified, over https, to public
 * addresses (checked on the address connected to), without following redirects, within a time and size limit and a
 * rate limit per reader and per project. Nothing of the request or its answer is stored or logged.
 */

export const TRY_TIMEOUT_MS = 15_000;
/** The most of an answer read: past it, cut, and said so. */
export const TRY_MAX_RESPONSE_BYTES = 2_000_000;
/** The most a reader's request to us may be: a body of TRY_MAX_BODY_BYTES (in JSON, escaped) and the rest. */
const MAX_INPUT_BYTES = 2_100_000;
export const TRIES_PER_CLIENT_PER_MINUTE = 30;
export const TRIES_PER_PROJECT_PER_HOUR = 600;

/** Connects only to public addresses, checked when connecting (see publicOnlyLookup), so DNS can't answer one way for a check and another for the connection. */
const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

const pairs = z.array(z.tuple([z.string().max(256), z.string().max(8_000)])).max(100);
const Input = z.object({
  server: z.string().max(2_000),
  variables: z.record(z.string().max(256), z.string().max(2_000)),
  path: z.record(z.string().max(256), z.string().max(2_000)),
  query: pairs,
  headers: pairs,
  cookies: pairs,
  body: z.string().nullable(),
}) satisfies z.ZodType<TryInput>;

/** What the console shows of the answer. */
export type TryAnswer = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** Bytes read. */
  size: number;
  /** Over TRY_MAX_RESPONSE_BYTES: the body is its start. */
  cut: boolean;
  ms: number;
};

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * Journeys only: a fake API on this machine counts as on the project's site, over http, at a private address. Honoured
 * only while the app itself is on localhost, which a server anyone else uses never is.
 */
function localTesting(url: URL): boolean {
  const app = appUrl().hostname;
  return (
    process.env.TRY_IT_ALLOW_LOCALHOST === "true" &&
    (app === "localhost" || app.endsWith(".localhost")) &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/** The registrable domains of the sites the project has verified: its portal's own domain, the site it's under, its email domain. */
async function verifiedDomains(projectId: string): Promise<Set<string>> {
  const [domain, mount, email] = await Promise.all([
    prisma.customDomain.findFirst({ where: { projectId, verifiedAt: { not: null } }, select: { hostname: true } }),
    prisma.siteMount.findFirst({ where: { projectId, verifiedAt: { not: null } }, select: { origin: true } }),
    prisma.emailDomain.findFirst({ where: { projectId, verifiedAt: { not: null } }, select: { domain: true } }),
  ]);
  const hosts = [domain?.hostname, mount && new URL(mount.origin).hostname, email?.domain];
  return new Set(hosts.map((host) => host && registrable(host)).filter((name): name is string => !!name));
}

/**
 * A host's registrable domain by the public suffix list, its private part too: `acme.github.io`, not `github.io`, so
 * a help center there opens nothing else under it. Null for an IP address or a suffix itself.
 */
const registrable = (host: string) => getDomain(host, { allowPrivateDomains: true });

/**
 * Counts the request against the limits (per reader, by an HMAC of their IP address when the proxy says it; per
 * project), or says which one it's over. One at a time per project, so requests at once can't overrun them together.
 */
async function countTry(projectId: string, requestHeaders: Headers): Promise<"reader" | "project" | null> {
  const client = await clientHash(requestHeaders);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.apiTry.deleteMany({ where: { createdAt: { lt: hourAgo } } });
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    if (client) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(9, hashtext(${client}))`;
    }
    const [byClient, byProject] = await Promise.all([
      client ? tx.apiTry.count({ where: { clientHash: client, createdAt: { gt: new Date(Date.now() - 60 * 1000) } } }) : 0,
      tx.apiTry.count({ where: { projectId, createdAt: { gt: hourAgo } } }),
    ]);
    // The reader's first, so one reader can't use up the project's hour for everyone.
    if (byClient >= TRIES_PER_CLIENT_PER_MINUTE) {
      return "reader";
    }
    if (byProject >= TRIES_PER_PROJECT_PER_HOUR) {
      return "project";
    }
    await tx.apiTry.create({ data: { projectId, clientHash: client } });
    return null;
  });
}

/** The start of a stream, up to `max` bytes, and whether there was more. */
async function readUpTo(stream: ReadableStream<Uint8Array> | null, max: number): Promise<{ bytes: Buffer; cut: boolean }> {
  if (!stream) {
    return { bytes: Buffer.alloc(0), cut: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= max) {
    const { done, value } = await reader.read();
    if (done) {
      return { bytes: Buffer.concat(chunks), cut: false };
    }
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks).subarray(0, max), cut: true };
}

/** POST /docs/<reference>/<operation>/try: the reader's filled-in request, sent on (see above); the answer as `TryAnswer`, or `{ error }`. */
export async function sendTry(request: Request, projectSlug: string, referenceSlug: string, operationSlug: string): Promise<Response> {
  // JSON only: a form posted from another site (no preflight) can't make one.
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return refuse(415, "Send the request as JSON");
  }
  // Only what's on the help center, for whoever may read its tab, as its page.
  const page = await apiReferencePage(projectSlug, referenceSlug);
  const operation = page?.kind === "reference" ? page.operations.find((o) => o.slug === operationSlug) : undefined;
  if (page?.kind !== "reference" || !operation) {
    return refuse(404, "Not found");
  }
  const raw = await readUpTo(request.body, MAX_INPUT_BYTES);
  if (raw.cut) {
    return refuse(413, "The body is over 1 MB");
  }
  let parsed;
  try {
    parsed = Input.safeParse(JSON.parse(raw.bytes.toString("utf8")));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    return refuse(400, "That isn't a request this console makes");
  }
  const made = tryRequest(page.doc, operation, page.reference.baseUrl, parsed.data);
  if ("error" in made) {
    return refuse(made.error === "The body is over 1 MB" ? 413 : 400, made.error);
  }
  // Checked on the address as it will be sent: variables filled, then parsed.
  const { url } = made;
  const local = localTesting(url);
  if (!local) {
    if (url.protocol !== "https:") {
      return refuse(403, "Tuti sends requests only over https");
    }
    // An IP address is no site's, and a connection to one looks nothing up (publicOnlyLookup never sees it).
    const domain = isIP(url.hostname.replace(/^\[|\]$/g, "")) ? null : registrable(url.hostname);
    if (!domain || !(await verifiedDomains(page.projectId)).has(domain)) {
      return refuse(403, `Tuti sends requests only to this help center's own sites, and ${url.hostname} isn't one`);
    }
  }
  const over = await countTry(page.projectId, request.headers);
  if (over) {
    return refuse(
      429,
      over === "reader" ? "Too many requests through Tuti. Try again in a minute." : "This help center sent a lot of requests through Tuti in the last hour. Try again later.",
    );
  }
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: made.method,
      // Only what the console set: nothing of the reader's own request (its cookies, Tuti's session) goes on.
      headers: [...made.headers, ["User-Agent", "Tuti-Try-It/1"]],
      body: made.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      ...(!local && { dispatcher: publicOnly }),
    });
    const { bytes, cut } = await readUpTo(response.body as ReadableStream<Uint8Array> | null, TRY_MAX_RESPONSE_BYTES);
    const answer: TryAnswer = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: bytes.toString("utf8"),
      size: bytes.length,
      cut,
      ms: Math.round(performance.now() - started),
    };
    return Response.json(answer, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Not logged: the request was the reader's, key and all.
    const { name, cause } = error as { name?: string; cause?: { code?: string; name?: string } };
    if (name === "TimeoutError" || cause?.name === "TimeoutError") {
      return refuse(504, "The API didn't answer within 15 seconds");
    }
    if (cause?.code === "EPRIVATE") {
      return refuse(403, "Tuti sends requests only to public addresses");
    }
    return refuse(502, "Couldn't reach the API");
  }
}
