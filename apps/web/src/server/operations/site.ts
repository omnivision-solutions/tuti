import { randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import { fetchSiteCheck } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { portalUrl } from "@/lib/hosts";
import { ASSET_PATH } from "@/lib/portal-base";
import { normalizeSiteUrl } from "@/lib/site-mounts";

import { forgetCustomDomain } from "../custom-domains";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/**
 * A portal under a path of the team's own site (acme.com/portal), Phase 10: the team sets the
 * address, makes their site forward that path to the portal's Tuti address, path and all, and
 * checks it; once verified, the portal answers there with the path on every link (proxy.ts).
 */

/** Where the site's check asks for the token, under the path (proxy.ts answers it). */
export const CHECK_PATH = "/.well-known/tuti-site";

type Mount = { origin: string; path: string; verificationToken: string; verifiedAt: Date | null };
const mountSelect = { origin: true, path: true, verificationToken: true, verifiedAt: true } as const;

const siteView = (mount: Mount, slug: string) => ({
  url: `${mount.origin}${mount.path}`,
  status: mount.verifiedAt ? ("verified" as const) : ("pending" as const),
  verifiedAt: mount.verifiedAt?.toISOString() ?? null,
  // What the team's site forwards to the portal's Tuti address, paths and all: everything under the
  // path, and Next.js's files, which pages load from /_tuti (see next.config.ts).
  forward: [mount.path, ASSET_PATH].map((path) => ({ from: `${path}/*`, to: `${portalUrl(slug)}${path}/*` })),
  /** "Check setup" fetches this through the site, and it must answer with `token`. */
  check: { url: `${mount.origin}${mount.path}${CHECK_PATH}`, token: `tuti-site=${mount.verificationToken}` },
});

/** The project's portal on its site (Settings → Your site, and site.get), or null. */
export async function siteMountView(projectId: string) {
  const mount = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
  return mount && siteView(mount, await projectSlug(projectId));
}

/** What the portal's Tuti address answers at <path>/.well-known/tuti-site, for `slug`'s site mount at `path` (verified or not). */
export async function siteCheckToken(slug: string, path: string): Promise<string | null> {
  const mount = await prisma.siteMount.findFirst({ where: { project: { slug }, path }, select: { verificationToken: true } });
  return mount && `tuti-site=${mount.verificationToken}`;
}

export const getSite = defineOperation({
  name: "site.get",
  summary:
    "Get where the portal is on your own site (null if nowhere): its address (e.g. https://example.com/portal), whether it's verified, what your site must forward, and the check Tuti makes",
  method: "GET",
  path: "/site",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ site: await siteMountView(projectId) }),
});

export const setSite = defineOperation({
  name: "site.set",
  summary:
    "Put the portal under a path of your own site (e.g. https://example.com/portal; one per project, replacing any other): make your site forward everything under that path, and /_tuti (the portal's scripts and styles), to the portal's Tuti address, paths and all (`forward`), then site.verify",
  method: "POST",
  path: "/site",
  scope: "write",
  access: "admin",
  input: z.object({ url: z.string().max(500) }),
  example: { url: "https://example.com/portal" },
  run: async ({ projectId }, input) => {
    const normalized = normalizeSiteUrl(input.url);
    if ("error" in normalized) {
      throw new OperationError(400, "invalid_input", normalized.error);
    }
    const slug = await projectSlug(projectId);
    const existing = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
    if (existing && existing.origin === normalized.origin && existing.path === normalized.path) {
      return { site: siteView(existing, slug) };
    }
    // A new token each time, so a check that passed for an earlier address doesn't pass this one.
    const data = { ...normalized, verificationToken: randomBytes(16).toString("hex"), verifiedAt: null };
    const mount = await prisma.siteMount.upsert({ where: { projectId }, create: { projectId, ...data }, update: data, select: mountSelect });
    forgetCustomDomain("");
    return { site: siteView(mount, slug) };
  },
});

export const verifySite = defineOperation({
  name: "site.verify",
  summary:
    "Check that your site forwards the portal's path to Tuti (Tuti fetches <address>/.well-known/tuti-site through it and expects this project's token): once it does, the portal answers there and every link Tuti makes uses that address",
  method: "POST",
  path: "/site/verify",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const mount = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
    if (!mount) {
      throw new OperationError(404, "not_found", "Add your site's address first");
    }
    const slug = await projectSlug(projectId);
    if (mount.verifiedAt) {
      return { site: siteView(mount, slug) };
    }
    const { check } = siteView(mount, slug);
    let answer: string | null;
    try {
      answer = await fetchSiteCheck(check.url);
    } catch (error) {
      log.info("A site check failed", { error });
      throw new OperationError(502, "site_unreachable", `We couldn't reach ${check.url}. It must be a public https address; try again in a minute`);
    }
    if (answer?.trim() !== check.token) {
      throw new OperationError(
        400,
        "not_verified",
        `${check.url} didn't answer with this portal's check. Make sure your site forwards ${mount.path}/* and ${ASSET_PATH}/* to ${portalUrl(slug)}, paths and all`,
      );
    }
    // Only the address that was checked: site.set may have replaced it meanwhile.
    const { count } = await prisma.siteMount.updateMany({
      where: { projectId, origin: mount.origin, path: mount.path, verificationToken: mount.verificationToken, verifiedAt: null },
      data: { verifiedAt: new Date() },
    });
    const now = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
    if (count === 0 && !(now?.verificationToken === mount.verificationToken && now.verifiedAt)) {
      throw new OperationError(409, "conflict", "Your site's address changed while we checked it. Check again");
    }
    forgetCustomDomain("");
    return { site: siteView(now!, slug) };
  },
});

export const removeSite = defineOperation({
  name: "site.remove",
  summary: "Stop putting the portal under your site's path: it answers at its own address again",
  method: "DELETE",
  path: "/site",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const mount = await prisma.siteMount.findUnique({ where: { projectId }, select: { origin: true, path: true } });
    if (!mount) {
      throw new OperationError(404, "not_found", "The portal isn't on your site");
    }
    await prisma.siteMount.delete({ where: { projectId } });
    forgetCustomDomain("");
    return { removed: `${mount.origin}${mount.path}` };
  },
});
