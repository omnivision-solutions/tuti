import { randomBytes } from "node:crypto";

import { Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { z } from "zod";

import { customDomainTarget, normalizeHostname, verificationRecord } from "@/lib/custom-domains";

import { forgetCustomDomain, txtRecords } from "../custom-domains";
import { defineOperation, OperationError } from "./define";

/**
 * A portal on its own domain (help.acme.com), Phase 10: the team adds it, points it at Tuti (a
 * CNAME to CUSTOM_DOMAIN_TARGET) and proves it's theirs with a TXT record; once verified, the
 * portal answers there too (server/custom-domains.ts).
 */

const OFF = "Custom domains aren't set up on this server (see CUSTOM_DOMAIN_TARGET in .env.example)";

type Domain = { hostname: string; verificationToken: string; verifiedAt: Date | null };

const domainView = (domain: Domain) => {
  const txt = verificationRecord(domain.hostname, domain.verificationToken);
  const target = customDomainTarget();
  return {
    hostname: domain.hostname,
    status: domain.verifiedAt ? ("verified" as const) : ("pending" as const),
    verifiedAt: domain.verifiedAt?.toISOString() ?? null,
    // What to add at the domain's DNS provider: where it points, and the record that proves it's yours.
    records: [...(target ? [{ type: "CNAME" as const, name: domain.hostname, value: target }] : []), { type: "TXT" as const, ...txt }],
  };
};
const domainSelect = { hostname: true, verificationToken: true, verifiedAt: true } as const;

/** The project's custom domain (Settings → Custom domain, and domain.get), or null. */
export async function customDomain(projectId: string) {
  const domain = await prisma.customDomain.findUnique({ where: { projectId }, select: domainSelect });
  return domain && domainView(domain);
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
    "Use your own domain for the portal and help center (e.g. help.example.com; one per project, replacing any other): add the DNS records it returns, then domain.verify. Until then the portal stays where it is",
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
    const normalized = normalizeHostname(input.hostname);
    if ("error" in normalized) {
      throw new OperationError(400, "invalid_input", normalized.error);
    }
    const { hostname } = normalized;
    if (await prisma.customDomain.findFirst({ where: { hostname, verifiedAt: { not: null }, projectId: { not: projectId } }, select: { id: true } })) {
      throw new OperationError(409, "conflict", `${hostname} is already another portal's domain`);
    }
    const existing = await prisma.customDomain.findUnique({ where: { projectId }, select: domainSelect });
    if (existing?.hostname === hostname) {
      return { domain: domainView(existing) };
    }
    // A new token each time, so a record added for an earlier claim doesn't verify this one.
    const data = { hostname, verificationToken: randomBytes(16).toString("hex"), verifiedAt: null, addedById: actor.kind === "user" ? actor.userId : actor.createdById };
    const domain = await prisma.customDomain.upsert({ where: { projectId }, create: { projectId, ...data }, update: data, select: domainSelect });
    if (existing) {
      forgetCustomDomain(existing.hostname);
    }
    return { domain: domainView(domain) };
  },
});

export const verifyDomain = defineOperation({
  name: "domain.verify",
  summary:
    "Check the custom domain's TXT record (see domain.get): once it's there, the domain is verified and the portal answers on it. DNS changes can take a few minutes to show",
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
    try {
      const verified = await prisma.customDomain.update({ where: { projectId }, data: { verifiedAt: new Date() }, select: domainSelect });
      forgetCustomDomain(verified.hostname);
      return { domain: domainView(verified) };
    } catch (error) {
      // Another portal verified it first (the hostname is unique among verified domains).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new OperationError(409, "conflict", `${domain.hostname} is already another portal's domain`);
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
    const domain = await prisma.customDomain.findUnique({ where: { projectId }, select: { hostname: true } });
    if (!domain) {
      throw new OperationError(404, "not_found", "The portal has no custom domain");
    }
    await prisma.customDomain.delete({ where: { projectId } });
    forgetCustomDomain(domain.hostname);
    return { removed: domain.hostname };
  },
});
