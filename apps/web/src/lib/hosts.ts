import { isReservedSlug, SLUG_PATTERN } from "./project-slugs";

/**
 * Which part of Tuti a request is for, based on its Host header.
 *
 * - The app host (APP_URL, e.g. tuti.so) serves marketing, team auth and /app.
 * - Portal hosts (PORTAL_URL_TEMPLATE, e.g. {project}.tuti.so) serve one
 *   project's public portal each.
 * Outside production, localhost and <project>.localhost also work.
 */
export type HostTarget = { kind: "app" } | { kind: "portal"; slug: string } | { kind: "unknown" };

const PLACEHOLDER = "{project}";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function appUrl(): URL {
  return new URL(required("APP_URL"));
}

export function portalTemplate(): string {
  const template = required("PORTAL_URL_TEMPLATE");
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`PORTAL_URL_TEMPLATE must contain ${PLACEHOLDER}`);
  }
  return template;
}

/** Public origin of a project's portal, e.g. https://acme.tuti.so */
export function portalUrl(slug: string): string {
  return portalTemplate().replace(PLACEHOLDER, slug).replace(/\/$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function portalHostPattern(): RegExp {
  const host = new URL(portalTemplate().replace(PLACEHOLDER, "x")).host.replace(/^x/, PLACEHOLDER);
  const pattern = escapeRegExp(host).replace(escapeRegExp(PLACEHOLDER), `(${SLUG_PATTERN.source.slice(1, -1)})`);
  return new RegExp(`^${pattern}$`);
}

const isProduction = () => process.env.NODE_ENV === "production";

export function resolveHost(host: string | null): HostTarget {
  if (!host) {
    return { kind: "unknown" };
  }
  host = host.toLowerCase();

  if (host === appUrl().host || (!isProduction() && /^localhost(:\d+)?$/.test(host))) {
    return { kind: "app" };
  }

  const match =
    portalHostPattern().exec(host) ?? (!isProduction() ? /^([a-z0-9-]+)\.localhost(?::\d+)?$/.exec(host) : null);
  const slug = match?.[1];
  if (slug && !isReservedSlug(slug)) {
    return { kind: "portal", slug };
  }
  return { kind: "unknown" };
}

/** Hostname patterns for Better Auth / Next.js allowlists (wildcard in place of the project). */
export function allowedHostPatterns(): string[] {
  const portalHost = new URL(portalTemplate().replace(PLACEHOLDER, "x")).host.replace(/^x/, "*");
  const hosts = [appUrl().host, portalHost];
  if (!isProduction()) {
    hosts.push("localhost:*", "*.localhost:*");
  }
  return hosts;
}
