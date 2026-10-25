import { randomBytes } from "node:crypto";

import { type CertificateStatus, Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { z } from "zod";

import { customDomainTarget, normalizeHostname, verificationRecord } from "@/lib/custom-domains";

import { certificateStatus, CloudflareError, cloudflareConfigured, createCustomHostname, deleteCustomHostname, getCustomHostname } from "../cloudflare";
import { forgetCustomDomain, txtRecords } from "../custom-domains";
import { defineOperation, OperationError } from "./define";
import { lockOwnAddress } from "./own-address";
import { requirePlan } from "./plan";

/**
 * A portal on its own domain (help.acme.com), Phase 10: the team adds it, points it at Tuti (a
 * CNAME to CUSTOM_DOMAIN_TARGET) and proves it's theirs with a TXT record; once verified, the
 * portal answers there too (server/custom-domains.ts). With Cloudflare for SaaS set up
 * (server/cloudflare.ts), a verified domain also gets a custom hostname there, for its certificate.
 */

const OFF = "Custom domains aren't set up on this server (see CUSTOM_DOMAIN_TARGET in .env.example)";

type Domain = { hostname: string; verificationToken: string; verifiedAt: Date | null; cloudflareId: string | null; certificate: CertificateStatus | null };

const domainView = (domain: Domain) => {
  const txt = verificationRecord(domain.hostname, domain.verificationToken);
  const target = customDomainTarget();
  return {
    hostname: domain.hostname,
    status: domain.verifiedAt ? ("verified" as const) : ("pending" as const),
    verifiedAt: domain.verifiedAt?.toISOString() ?? null,
    // Its HTTPS certificate, when Cloudflare gets it one: pending (until the CNAME points at Tuti), active or failed.
    certificate: domain.certificate && (domain.certificate.toLowerCase() as "pending" | "active" | "failed"),
    // What to add at the domain's DNS provider: where it points, and the record that proves it's yours.
    records: [...(target ? [{ type: "CNAME" as const, name: domain.hostname, value: target }] : []), { type: "TXT" as const, ...txt }],
  };
};
const domainSelect = { hostname: true, verificationToken: true, verifiedAt: true, cloudflareId: true, certificate: true } as const;

/** The project's custom domain (Customize → Address, and domain.get), or null; a certificate on its way is asked about again. */
export async function customDomain(projectId: string) {
  let domain = await prisma.customDomain.findUnique({ where: { projectId }, select: domainSelect });
  if (domain?.cloudflareId && domain.certificate !== "ACTIVE" && cloudflareConfigured()) {
    try {
      const certificate = await getCustomHostname(domain.cloudflareId).then(certificateStatus, (error: unknown) => {
        // Gone at Cloudflare (deleted there): there's no certificate coming; removing and adding the domain makes a new one.
        if (error instanceof CloudflareError && error.status === 404) {
          return "FAILED" as const;
        }
        throw error;
      });
      if (certificate !== domain.certificate) {
        await prisma.customDomain.updateMany({ where: { projectId, cloudflareId: domain.cloudflareId }, data: { certificate } });
        domain = { ...domain, certificate };
        // Live once its certificate is: links Tuti makes go there from now on.
        forgetCustomDomain(domain.hostname);
      }
    } catch (error) {
      // What we knew stays: the next look asks again.
      log.error("Asking Cloudflare about a custom domain's certificate failed", { error });
    }
  }
  return domain && domainView(domain);
}

/**
 * Deletes a custom hostname at Cloudflare unless a domain still uses it (another check of the same
 * domain may have just verified it with this one). A failure is only logged: the hostname then
 * routes to Tuti, which answers 404 for it, and adding the domain again uses it.
 */
async function releaseCustomHostname(cloudflareId: string | null) {
  if (!cloudflareId || !cloudflareConfigured() || (await prisma.customDomain.count({ where: { cloudflareId } })) > 0) {
    return;
  }
  try {
    await deleteCustomHostname(cloudflareId);
  } catch (error) {
    log.error("Deleting a custom hostname at Cloudflare failed", { error, cloudflareId });
  }
}

export const getDomain = defineOperation({
  name: "domain.get",
  summary:
    "Get the portal's custom domain (null if none): its hostname, whether it's verified, and the DNS records to add (a CNAME pointing it at Tuti, and a TXT record that proves it's yours)",
  method: "GET",
  path: "/domain",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ domain: await customDomain(projectId) }),
});

export const setDomain = defineOperation({
  name: "domain.set",
  summary:
    "Use your own domain for the portal and its docs (e.g. help.example.com; one per project, replacing any other; not while the portal is under a path of your site, see site.set: remove that first): add the DNS records it returns, then domain.verify. Until then the portal stays where it is. Where plans are sold, on Pro and Business (402 otherwise; on a lower plan a domain set before isn't served, and the portal is at its Tuti address)",
  method: "POST",
  path: "/domain",
  scope: "write",
  access: "admin",
  input: z.object({ hostname: z.string().max(300) }),
  example: { hostname: "help.example.com" },
  run: async ({ actor, projectId }, input) => {
    if (!customDomainTarget()) {
      throw new OperationError(400, "invalid_input", OFF);
    }
    await requirePlan(projectId, "customDomain");
    const normalized = normalizeHostname(input.hostname);
    if ("error" in normalized) {
      throw new OperationError(400, "invalid_input", normalized.error);
    }
    const { hostname } = normalized;
    if (await prisma.customDomain.findFirst({ where: { hostname, verifiedAt: { not: null }, projectId: { not: projectId } }, select: { id: true } })) {
      throw new OperationError(409, "conflict", `${hostname} is already another portal's domain`);
    }
    const { existing, domain, unchanged } = await prisma.$transaction(async (tx) => {
      await lockOwnAddress(tx, projectId);
      const existing = await tx.customDomain.findUnique({ where: { projectId }, select: domainSelect });
      if (existing?.hostname === hostname) {
        return { existing, domain: existing, unchanged: true };
      }
      const mount = await tx.siteMount.findUnique({ where: { projectId }, select: { origin: true, path: true } });
      if (mount) {
        throw new OperationError(409, "conflict", `Your portal is on your site at ${mount.origin}${mount.path}. Remove it there first to give it a domain of its own`);
      }
      // A new token each time, so a record added for an earlier claim doesn't verify this one.
      const data = {
        hostname,
        verificationToken: randomBytes(16).toString("hex"),
        verifiedAt: null,
        cloudflareId: null,
        certificate: null,
        addedById: actor.kind === "user" ? actor.userId : actor.createdById,
      };
      return { existing, unchanged: false, domain: await tx.customDomain.upsert({ where: { projectId }, create: { projectId, ...data }, update: data, select: domainSelect }) };
    });
    if (existing && !unchanged) {
      forgetCustomDomain(existing.hostname);
      await releaseCustomHostname(existing.cloudflareId);
    }
    return { domain: domainView(domain) };
  },
});

export const verifyDomain = defineOperation({
  name: "domain.verify",
  summary:
    "Check the custom domain's TXT record (see domain.get): once it's there, the domain is verified and the portal answers on it (where Tuti gets certificates through Cloudflare, `certificate` says when HTTPS works there: pending until the CNAME points at Tuti, then active). DNS changes can take a few minutes to show",
  method: "POST",
  path: "/domain/verify",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const domain = await prisma.customDomain.findUnique({ where: { projectId }, select: domainSelect });
    if (!domain) {
      throw new OperationError(404, "not_found", "Add a domain first");
    }
    if (domain.verifiedAt) {
      return { domain: domainView(domain) };
    }
    const record = verificationRecord(domain.hostname, domain.verificationToken);
    let found: string[];
    try {
      found = await txtRecords(record.name);
    } catch (error) {
      log.error("Looking up a custom domain's TXT record failed", { error });
      throw new OperationError(502, "dns_failed", "We couldn't look up the domain's DNS records. Try again in a minute");
    }
    if (!found.includes(record.value)) {
      throw new OperationError(
        400,
        "not_verified",
        `We couldn't find the TXT record ${record.name} with ${record.value} yet. DNS changes can take a few minutes to show`,
      );
    }
    const taken = () => new OperationError(409, "conflict", `${domain.hostname} is already another portal's domain`);
    if (await prisma.customDomain.findFirst({ where: { hostname: domain.hostname, verifiedAt: { not: null }, projectId: { not: projectId } }, select: { id: true } })) {
      throw taken();
    }
    // Only now, with the domain shown to be theirs: anyone can make projects, so adding domains mustn't use up Cloudflare's.
    let cloudflare: { cloudflareId: string; certificate: CertificateStatus } | undefined;
    if (cloudflareConfigured()) {
      try {
        const hostname = await createCustomHostname(domain.hostname);
        cloudflare = { cloudflareId: hostname.id, certificate: certificateStatus(hostname) };
      } catch (error) {
        log.error("Making a custom hostname at Cloudflare failed", { error });
        throw new OperationError(502, "certificate_failed", "We couldn't set up the domain's certificate. Try again in a minute");
      }
    }
    try {
      // Only the domain that was checked: domain.set may have replaced it during the lookup.
      const { count } = await prisma.customDomain.updateMany({
        where: { projectId, hostname: domain.hostname, verificationToken: domain.verificationToken, verifiedAt: null },
        data: { verifiedAt: new Date(), ...cloudflare },
      });
      const now = await prisma.customDomain.findUnique({ where: { projectId }, select: domainSelect });
      // Unless the same check verified it meanwhile, it's another domain (or none) now.
      if (count === 0 && !(now?.hostname === domain.hostname && now.verificationToken === domain.verificationToken && now.verifiedAt)) {
        await releaseCustomHostname(cloudflare?.cloudflareId ?? null);
        throw new OperationError(409, "conflict", "The domain changed while we checked it. Check again");
      }
      forgetCustomDomain(domain.hostname);
      return { domain: domainView(now!) };
    } catch (error) {
      // Another portal verified it first (the hostname is unique among verified domains).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        await releaseCustomHostname(cloudflare?.cloudflareId ?? null);
        throw taken();
      }
      throw error;
    }
  },
});

export const removeDomain = defineOperation({
  name: "domain.remove",
  summary: "Stop using the custom domain: the portal answers only at its Tuti address again",
  method: "DELETE",
  path: "/domain",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    const domain = await prisma.customDomain.findUnique({ where: { projectId }, select: { hostname: true, cloudflareId: true } });
    if (!domain) {
      throw new OperationError(404, "not_found", "The portal has no custom domain");
    }
    await prisma.customDomain.delete({ where: { projectId } });
    forgetCustomDomain(domain.hostname);
    await releaseCustomHostname(domain.cloudflareId);
    return { removed: domain.hostname };
  },
});
