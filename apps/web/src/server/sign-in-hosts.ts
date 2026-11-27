import { isIP } from "node:net";

import { publicOnlyLookup } from "@tuti/shared/webhook-url";
import { getDomain, parse } from "tldts";
import { Agent, fetch } from "undici";

/**
 * Settings → Screenshots' suggestions: the hosted sign-in services an app calls, found in its page and scripts, whose
 * hosts its runs' browser must open (packages/jobs screenshots.ts allowedHosts) for the agent to sign in. A Firebase
 * app's sign-in fails with "auth/network-request-failed" until identitytoolkit.googleapis.com is allowed, say.
 */

export type SignInService = { provider: string; hosts: string[] };

const REGION = String.raw`[a-z]{2}(?:-[a-z]{1,15}){1,3}-\d`;

/**
 * The text is the admin's, so nothing scans all of it: a service's patterns run only on windows around where its
 * names are (`near`, at most MAX_HITS of each), and every repeat in them is bounded (a DNS label is at most 63
 * characters, a tag 2,000). The work grows with the names found, not with the text.
 *
 * The services, and how each shows in an app's code: a host it always calls (`hosts`, seen as `marker`), or the
 * team's own host of it (`found`, each match's first group, or the whole match).
 */
const SERVICES: { provider: string; hint: string[]; near?: string[]; marker?: RegExp; hosts?: string[]; found?: RegExp[]; derived?: (text: string) => string[]; not?: RegExp }[] = [
  { provider: "Firebase", hint: ["identitytoolkit"], marker: /identitytoolkit\.googleapis\.com/, hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] },
  // acme.auth0.com, acme.eu.auth0.com; not Auth0's own site and CDN.
  { provider: "Auth0", hint: ["auth0.com"], near: [".auth0.com"], found: [/\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z]{2})?\.auth0\.com\b/g], not: /^(?:[a-z]{2}\.auth0\.com$|(?:www|cdn|manage)\.)/ },
  { provider: "Supabase", hint: ["supabase.co"], near: [".supabase.co"], found: [/\b[a-z0-9]{20}\.supabase\.co\b/g] },
  // Never Okta's own sign-in and sites.
  { provider: "Okta", hint: ["okta"], near: [".okta.com", ".oktapreview.com", ".okta-emea.com"], found: [/\b[a-z0-9][a-z0-9-]{0,62}\.(?:okta|oktapreview|okta-emea)\.com\b/g], not: /^(?:www|login|developer|help|support|status)\./ },
  {
    provider: "Amazon Cognito", hint: ["cognito", "userpoolid", "user_pool_id", "user_pools_id"], near: ["cognito-idp.", ".amazoncognito.com", "userpoolid", "user_pool_id", "user_pools_id"],
    found: [
      new RegExp(String.raw`\bcognito-idp\.${REGION}\.amazonaws\.com\b`, "g"),
      new RegExp(String.raw`\b[a-z0-9-]{1,63}\.auth\.${REGION}\.amazoncognito\.com\b`, "g"),
    ],
    // The SDK makes its host from the user pool's region: us-east-1_AbC123xyz.
    derived: (text) =>
      [...text.matchAll(new RegExp(String.raw`\b(${REGION})_[a-z0-9]{9}\b`, "gi"))].map(([, region]) => `cognito-idp.${region!.toLowerCase()}.amazonaws.com`),
  },
  // https://clerk.acme.com (in a URL: window.Clerk.session.id is code), or acme-12.clerk.accounts.dev (a development instance).
  { provider: "Clerk", hint: ["clerk", "pk_live_", "pk_test_"], near: ["//clerk.", ".clerk.accounts.dev", "pk_live_", "pk_test_"], found: [/(?<=\/\/)clerk\.(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,63}\b/g, /\b[a-z0-9-]{1,63}\.clerk\.accounts\.dev\b/g], not: /^clerk\.(?:accounts\.dev|com)$/,
    // Or in its publishable key, which is its host in base64 followed by "$".
    derived: (text) => [...text.matchAll(/\bpk_(?:live|test)_([A-Za-z0-9+/]{8,400}={0,2})/g)].map(([, key]) => Buffer.from(key!, "base64").toString("latin1").replace(/\$$/, "").toLowerCase()),
  },
  { provider: "Stytch", hint: ["stytch"], marker: /api\.stytch\.com/, hosts: ["api.stytch.com"] },
  { provider: "WorkOS", hint: ["workos"], marker: /api\.workos\.com/, hosts: ["api.workos.com"] },
];

/** General sign-in pages, which would open every account's: never suggested, whatever an app's code names. */
const NEVER = /(?:^|\.)(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com)$/;

/** A host on a real public suffix (not a file name like clerk.browser.js). */
const realHost = (host: string) => {
  const parsed = parse(host, { allowPrivateDomains: true });
  return !!parsed.domain && (parsed.isIcann === true || parsed.isPrivate === true);
};

const MAX_HITS = 1_000;
/** Before a name, room for a host's labels; after it, for a publishable key or a Clerk host's labels. */
const BEFORE = 200;
const AFTER = 600;

const isHostChar = (char: string | undefined) => char !== undefined && /[a-z0-9.-]/i.test(char);

/**
 * The text around each of `names` (ASCII, lower case) in `text`, apart; a host cut at a window's edge is left out, so a
 * part of one is never taken for a host. Found in `folded` (`text` lowered with its offsets kept), cut from `text`, so a
 * key in the window keeps its case.
 */
function windows(text: string, folded: string, names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    for (let at = folded.indexOf(name), hits = 0; at !== -1 && hits < MAX_HITS; at = folded.indexOf(name, at + name.length), hits++) {
      let start = Math.max(0, at - BEFORE);
      let end = Math.min(text.length, at + name.length + AFTER);
      if (start > 0 && isHostChar(text[start - 1])) {
        while (start < at && isHostChar(text[start])) start++;
      }
      if (end < text.length && isHostChar(text[end])) {
        while (end > at + name.length && isHostChar(text[end - 1])) end--;
      }
      parts.push(text.slice(start, end));
    }
  }
  return parts.join("\n");
}

/** The sign-in services named in `texts` (a page and its scripts), each with the hosts found, in SERVICES' order. */
export function findSignInServices(texts: string[]): SignInService[] {
  return merge(texts.map(findIn));
}

/** Each text's services as one list, in SERVICES' order, each service's hosts together. */
function merge(lists: SignInService[][]): SignInService[] {
  return SERVICES.flatMap(({ provider }) => {
    const hosts = new Set(lists.flatMap((list) => list.find((service) => service.provider === provider)?.hosts ?? []));
    return hosts.size > 0 ? [{ provider, hosts: [...hosts].sort().slice(0, 5) }] : [];
  });
}

function findIn(original: string): SignInService[] {
  const text = original.toLowerCase();
  // The lowered text where its offsets match the original's (nearly always); else only A–Z lowered, runs at a time.
  const folded = text.length === original.length ? text : original.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const found: SignInService[] = [];
  for (const service of SERVICES) {
    // Its patterns only where its name is: most text names none, and is skipped without a scan.
    if (!service.hint.some((word) => text.includes(word))) {
      continue;
    }
    const hosts = new Set<string>();
    if (service.marker?.test(text)) {
      service.hosts!.forEach((host) => hosts.add(host));
    }
    const near = windows(original, folded, service.near ?? []);
    const lower = near.toLowerCase();
    const candidates = [...(service.found ?? []).flatMap((pattern) => [...lower.matchAll(pattern)].map(([host]) => host)), ...(service.derived?.(near) ?? [])];
    for (const host of candidates) {
      if (/^[a-z0-9.-]+$/.test(host) && !service.not?.test(host) && realHost(host) && !NEVER.test(host)) {
        hosts.add(host);
      }
    }
    if (hosts.size > 0) {
      found.push({ provider: service.provider, hosts: [...hosts].sort().slice(0, 5) });
    }
  }
  return found;
}

const PAGE_BYTES = 2_000_000;
/** Each script, read in full up to this (a vendor chunk of a few hundred KB, say): searched as it arrives and let go. */
const SCRIPT_BYTES = 3_000_000;
/** A Next.js page loads 40 or more of its own chunks, and the sign-in SDK can be any of them. */
const MAX_SCRIPTS = 100;
/** All the scripts together: past it, no more are read (the same ones nearly every time, so what's found is kept). */
const SCRIPTS_BYTES = 40_000_000;
/** Scripts read at once, so one read never opens more connections to the app, or holds more than PAGE_BYTES + this × SCRIPT_BYTES. */
const SCRIPTS_AT_ONCE = 8;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

/** Connects only to public addresses, checked on the address connected to (see publicOnlyLookup). */
const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

const isLocalhost = (host: string) => host === "localhost" || host === "127.0.0.1";

/**
 * Tests and journeys (SCREENSHOTS_ALLOW_LOCALHOST, honoured only while Tuti itself is on localhost): only a fake app on
 * this machine is fetched (over http), and nothing else, so tests never reach the network.
 */
const localTesting = () => {
  const app = new URL(process.env.APP_URL || "http://localhost").hostname;
  return process.env.SCREENSHOTS_ALLOW_LOCALHOST === "true" && (app === "localhost" || app.endsWith(".localhost"));
};

/** Whether a URL may be fetched: https to a name (an IP address skips the lookup's check), or the local fake. */
function allowed(url: URL): boolean {
  if (localTesting()) {
    return url.protocol === "http:" && isLocalhost(url.hostname);
  }
  return url.protocol === "https:" && !isIP(url.hostname.replace(/^\[|\]$/g, ""));
}

/** A URL's body as text, up to `max` bytes, following redirects only to allowed URLs; null when it can't be read. */
async function get(url: URL, max: number, signal: AbortSignal): Promise<{ url: URL; text: string } | null> {
  for (let hop = 0; hop <= MAX_REDIRECTS && allowed(url); hop++) {
    const response = await fetch(url, { redirect: "manual", signal, headers: { accept: "text/html,*/*" }, ...(!localTesting() && { dispatcher: publicOnly }) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= max) {
        break;
      }
    }
    return { url, text: Buffer.concat(chunks).subarray(0, max).toString("utf8") };
  }
  return null;
}

/** The scripts a page loads (and preloads), on its own site. */
export function scriptsOf(page: { url: URL; text: string }): URL[] {
  const site = getDomain(page.url.hostname, { allowPrivateDomains: true }) ?? page.url.hostname;
  const sources = [
    ...page.text.matchAll(/<script\b[^>]{0,2000}?\bsrc\s{0,20}=\s{0,20}["']([^"']{1,2000})["']/gi),
    ...page.text.matchAll(/<link\b[^>]{0,2000}?\bhref\s{0,20}=\s{0,20}["']([^"']{1,2000}?\.m?js(?:\?[^"']{0,2000})?)["']/gi),
  ].map(([, src]) => URL.canParse(src!, page.url) && new URL(src!, page.url));
  const own = sources.filter((url): url is URL => !!url && (url.origin === page.url.origin || getDomain(url.hostname, { allowPrivateDomains: true }) === site));
  return [...new Map(own.map((url) => [url.href, url])).values()];
}

/**
 * The sign-in services the app at `appUrl` calls: its page (over https, an http address asked for over https) and the
 * scripts it loads from its own site, read within size and time limits; null when the page couldn't be read.
 * `complete` when every script was read too: what's found otherwise may be missing one.
 */
export async function detectSignInServices(appUrl: string): Promise<{ services: SignInService[]; complete: boolean } | null> {
  const url = new URL(appUrl);
  if (!localTesting()) {
    url.protocol = "https:";
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const page = await get(url, PAGE_BYTES, signal);
    if (!page) {
      return null;
    }
    // Only the first MAX_SCRIPTS, the same ones each time: what they show is kept all the same.
    const queue = scriptsOf(page).slice(0, MAX_SCRIPTS);
    const found = [findIn(page.text)];
    let complete = true;
    let left = SCRIPTS_BYTES;
    await Promise.all(
      Array.from({ length: SCRIPTS_AT_ONCE }, async () => {
        for (let script = queue.shift(); script && left > 0; script = queue.shift()) {
          const read = await get(script, Math.min(SCRIPT_BYTES, left), signal).catch(() => null);
          left -= read?.text.length ?? 0;
          complete &&= !!read;
          found.push(read ? findIn(read.text) : []);
        }
      }),
    );
    return { services: merge(found), complete };
  } catch {
    return null;
  }
}
