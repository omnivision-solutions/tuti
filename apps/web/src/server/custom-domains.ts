import { prisma } from "@tuti/db";
import { liveDomain, portalAddress as lookUpPortalAddress, type PortalAddress } from "@tuti/jobs";

import { customDomainTarget } from "@/lib/custom-domains";
import { BASE_PATTERN } from "@/lib/portal-base";
import { type HostTarget, resolveHost } from "@/lib/hosts";

/**
 * Which portal a request's host is for, custom domains included (help.acme.com once it's
 * verified): the one place proxy.ts and the sign-in flows ask.
 */
export async function requestTarget(host: string | null): Promise<RequestTarget> {
  const target = resolveHost(host);
  if (target.kind !== "unknown" || !host || !customDomainTarget()) {
    return target;
  }
  const hostname = hostnameOf(host);
  const slug = await customDomainSlug(hostname);
  return slug ? { kind: "portal", slug, customDomain: hostname } : target;
}

/** A portal on its custom domain says which (its hostname). */
export type RequestTarget = Exclude<HostTarget, { kind: "portal" }> | { kind: "portal"; slug: string; customDomain?: string };

/** The host without its port, lowercase (help.acme.com:443 → help.acme.com). */
function hostnameOf(host: string) {
  return host.toLowerCase().replace(/:\d+$/, "");
}

/**
 * Lookups are kept for a few seconds, answers for unknown hosts too: every request to a custom
 * domain asks, and anyone can send any Host. So a removed domain stops (and a verified one starts)
 * within CACHE_MS on every server.
 */
const CACHE_MS = 10_000;
const MAX_CACHED = 5_000;
const cache = new Map<string, { slug: string | null; until: number }>();
/** Counts forgetCustomDomain calls: a lookup that started before one doesn't keep what it read. */
let forgets = 0;

async function customDomainSlug(hostname: string): Promise<string | null> {
  const cached = cache.get(hostname);
  if (cached && cached.until > Date.now()) {
    return cached.slug;
  }
  const started = forgets;
  const domain = await prisma.customDomain.findFirst({
    // Live ones only: the same ones links go to (see liveDomain).
    where: { hostname, ...liveDomain },
    select: { project: { select: { slug: true } } },
  });
  if (cache.size >= MAX_CACHED) {
    cache.clear();
  }
  const slug = domain?.project.slug ?? null;
  if (forgets === started) {
    cache.set(hostname, { slug, until: Date.now() + CACHE_MS });
  }
  return slug;
}

/**
 * A portal's public address, for every link Tuti makes to it: its custom domain once that's live,
 * else its Tuti address (see portalAddress in @tuti/jobs). Kept as long as host lookups.
 */
const addresses = new Map<string, { address: PortalAddress; until: number }>();

export async function portalAddress(projectSlug: string): Promise<PortalAddress> {
  const cached = addresses.get(projectSlug);
  if (cached && cached.until > Date.now()) {
    return cached.address;
  }
  const started = forgets;
  const address = await lookUpPortalAddress(projectSlug);
  if (forgets === started) {
    if (addresses.size >= MAX_CACHED) {
      addresses.clear();
    }
    addresses.set(projectSlug, { address, until: Date.now() + CACHE_MS });
  }
  return address;
}
/**
 * Where a portal is on its team's site, once that's verified (see SiteMount): the site's origin and
 * the path; null for none. Kept as long as host lookups.
 */
export async function siteMount(projectSlug: string): Promise<{ origin: string; path: string } | null> {
  const cached = mounts.get(projectSlug);
  if (cached && cached.until > Date.now()) {
    return cached.mount;
  }
  const started = forgets;
  const row = await prisma.siteMount.findFirst({ where: { project: { slug: projectSlug }, verifiedAt: { not: null } }, select: { origin: true, path: true } });
  const mount = row && BASE_PATTERN.test(row.path) ? row : null;
  if (forgets === started) {
    if (mounts.size >= MAX_CACHED) {
      mounts.clear();
    }
    mounts.set(projectSlug, { mount, until: Date.now() + CACHE_MS });
  }
  return mount;
}
const mounts = new Map<string, { mount: { origin: string; path: string } | null; until: number }>();

/** Forgets what this server knows about `hostname` (after it's verified, removed or its certificate changed here). */
export function forgetCustomDomain(hostname: string) {
  forgets++;
  cache.delete(hostname);
  // Which portal it was is gone with it: every address is looked up again.
  addresses.clear();
  mounts.clear();
}

/**
 * The TXT records at `name`, each with its strings joined, from a DNS-over-HTTPS resolver
 * (DNS_LOOKUP_URL, Cloudflare's by default): fresh answers right after someone adds a record,
 * whatever this server's own resolver has kept. Throws when the resolver can't be asked.
 */
export async function txtRecords(name: string): Promise<string[]> {
  const url = new URL(process.env.DNS_LOOKUP_URL || "https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`DNS lookup answered ${response.status}`);
  }
  const { Status, Answer } = (await response.json()) as { Status: number; Answer?: { type: number; data: string }[] };
  // 3 is NXDOMAIN: no such name, so no records (yet).
  if (Status !== 0 && Status !== 3) {
    throw new Error(`DNS lookup failed (status ${Status})`);
  }
  return (Answer ?? [])
    .filter((answer) => answer.type === 16)
    .map((answer) => {
      // Quoted strings ("a" "b" is "ab"), as Cloudflare answers; some resolvers leave the quotes out.
      const parts = [...answer.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1]!.replace(/\\(.)/g, "$1"));
      return parts.length > 0 ? parts.join("") : answer.data;
    });
}
