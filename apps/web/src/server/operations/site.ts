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
import { lockOwnAddress } from "./own-address";
import { requirePlan } from "./plan";
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
  /** "Check setup" fetches these through the site (one per rule in `forward`), and each must answer with `token`. */
  check: { urls: [mount.path, ASSET_PATH].map((path) => `${mount.origin}${path}${CHECK_PATH}`), token: `tuti-site=${mount.verificationToken}` },
});

/** The project's portal on its site (Settings → Domain, and site.get), or null. */
export async function siteMountView(projectId: string) {
  const mount = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
  return mount && siteView(mount, await projectSlug(projectId));
}

/**
 * What the portal's Tuti address answers at <path>/.well-known/tuti-site, for `slug`'s site mount at
 * `path` (verified or not); without `path`, at /_tuti/.well-known/tuti-site, for its mount wherever it is.
 */
export async function siteCheckToken(slug: string, path?: string): Promise<string | null> {
  const mount = await prisma.siteMount.findFirst({ where: { project: { slug }, ...(path && { path }) }, select: { verificationToken: true } });
  return mount && `tuti-site=${mount.verificationToken}`;
}

/** The portal on the team's site, as siteView makes it. */
const siteOutput = z
  .object({
    url: z.string().describe("The portal's address on your site (e.g. https://example.com/portal)").meta({ examples: ["https://example.com/portal"] }),
    status: z.enum(["pending", "verified"]).describe("verified once site.verify found your site forwards to Tuti; pending until then").meta({ examples: ["pending"] }),
    verifiedAt: z.string().nullable().describe("When it was verified (ISO 8601), or null").meta({ examples: [null] }),
    forward: z
      .array(
        z.object({
          from: z.string().describe("The paths on your site").meta({ examples: ["/portal/*"] }),
          to: z.string().describe("Where your site must forward them, paths and all").meta({ examples: ["https://acme.tuti.so/portal/*"] }),
        }),
      )
      .describe("What your site must forward to the portal's Tuti address: everything under the path, and /_tuti (the portal's scripts and styles)"),
    check: z
      .object({
        urls: z
          .array(z.string())
          .describe("What site.verify fetches through your site, one per rule in `forward`")
          .meta({ examples: [["https://example.com/portal/.well-known/tuti-site", "https://example.com/_tuti/.well-known/tuti-site"]] }),
        token: z.string().describe("What each must answer with: this project's token").meta({ examples: ["tuti-site=3f9a1c0e5b7d2a4c6e8f0a1b2c3d4e5f"] }),
      })
      .describe("The check Tuti makes"),
  })
  .meta({ id: "SiteAddress", description: "The portal under a path of your own site" });

export const getSite = defineOperation({
  name: "site.get",
  title: "Get the site address",
  summary: "Get where the portal is on your own site, whether it's verified, what your site must forward, and the check Tuti makes.",
  method: "GET",
  path: "/site",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z.object({ site: siteOutput.nullable().describe("The portal on your site; null if nowhere") }).describe("The portal on your site"),
  run: async ({ projectId }) => ({ site: await siteMountView(projectId) }),
});

export const setSite = defineOperation({
  name: "site.set",
  title: "Set a site address",
  summary:
    "Put the portal under a path of your own site, replacing any other (one per project), then make your site forward what `forward` says and run site.verify. Refused (409) while the portal has a custom domain (domain.set): remove that first.",
  method: "POST",
  path: "/site",
  scope: "write",
  access: "admin",
  errors: [402, 409],
  input: z.object({
    url: z
      .string()
      .max(500)
      .describe(
        "The address, e.g. https://example.com/portal. Where plans are sold, it needs a plan with a portal under a path of your site (402 otherwise; on a lower plan a path set before isn't served, and the portal is at its Tuti address)",
      )
      .meta({ examples: ["https://example.com/portal"] }),
  }),
  output: z.object({ site: siteOutput.describe("The portal on your site, pending until verified") }).describe("The portal on your site"),
  example: { url: "https://example.com/portal" },
  run: async ({ projectId }, input) => {
    await requirePlan(projectId, "sitePath");
    const normalized = normalizeSiteUrl(input.url);
    if ("error" in normalized) {
      throw new OperationError(400, "invalid_input", normalized.error);
    }
    const slug = await projectSlug(projectId);
    const { mount, unchanged } = await prisma.$transaction(async (tx) => {
      await lockOwnAddress(tx, projectId);
      const existing = await tx.siteMount.findUnique({ where: { projectId }, select: mountSelect });
      if (existing && existing.origin === normalized.origin && existing.path === normalized.path) {
        return { mount: existing, unchanged: true };
      }
      const domain = await tx.customDomain.findUnique({ where: { projectId }, select: { hostname: true } });
      if (domain) {
        throw new OperationError(409, "conflict", `Your portal is on ${domain.hostname}. Remove that domain first to put it under a path of your site`);
      }
      // A new token each time, so a check that passed for an earlier address doesn't pass this one.
      const data = { ...normalized, verificationToken: randomBytes(16).toString("hex"), verifiedAt: null };
      return { mount: await tx.siteMount.upsert({ where: { projectId }, create: { projectId, ...data }, update: data, select: mountSelect }), unchanged: false };
    });
    if (unchanged) {
      return { site: siteView(mount, slug) };
    }
    forgetCustomDomain("");
    return { site: siteView(mount, slug) };
  },
});

export const verifySite = defineOperation({
  name: "site.verify",
  title: "Verify the site address",
  summary:
    "Check that your site forwards the portal's path to Tuti (Tuti fetches <address>/.well-known/tuti-site through it and expects this project's token): once it does, the portal answers there and every link Tuti makes uses that address.",
  method: "POST",
  path: "/site/verify",
  scope: "write",
  access: "admin",
  errors: [404, 409, 502],
  input: z.object({}),
  output: z.object({ site: siteOutput.describe("The portal on your site, verified") }).describe("The portal on your site"),
  run: async ({ projectId }) => {
    const mount = await prisma.siteMount.findUnique({ where: { projectId }, select: mountSelect });
    if (!mount) {
      throw new OperationError(404, "not_found", "Add your site's address first");
    }
    const slug = await projectSlug(projectId);
    if (mount.verifiedAt) {
      return { site: siteView(mount, slug) };
    }
    const { check, forward } = siteView(mount, slug);
    // Each rule: without the second, pages would come without their scripts and styles.
    for (const [i, url] of check.urls.entries()) {
      let answer: string | null;
      try {
        answer = await fetchSiteCheck(url);
      } catch (error) {
        log.info("A site check failed", { error });
        throw new OperationError(502, "site_unreachable", `We couldn't reach ${url}. It must be a public https address; try again in a minute`);
      }
      if (answer?.trim() !== check.token) {
        throw new OperationError(
          400,
          "not_verified",
          `${url} didn't answer with this portal's check. Make sure your site forwards ${forward[i]!.from} to ${forward[i]!.to}, path and all`,
        );
      }
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
  title: "Remove the site address",
  summary: "Stop putting the portal under your site's path: it answers at its own address again.",
  method: "DELETE",
  path: "/site",
  scope: "write",
  access: "admin",
  errors: [404],
  input: z.object({}),
  output: z.object({ removed: z.string().describe("The address removed").meta({ examples: ["https://example.com/portal"] }) }).describe("The address removed"),
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
