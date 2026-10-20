import { createHmac } from "node:crypto";

import { prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { auth } from "@/lib/auth";
import { clientKey } from "@/lib/client-ip";
import { hashSecret } from "@/lib/portal-handoff";
import {
  SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR,
  SIGN_IN_LINKS_PER_CLIENT_PER_HOUR,
  SIGN_IN_LINKS_PER_PORTAL_PER_HOUR,
} from "@/lib/sign-in-link";

/**
 * Counts a request for an emailed link (a portal sign-in link or a password reset
 * link) against the hourly limits, which both kinds share: per address on any
 * host, per visitor, and per site (a portal, or the app host when `projectId` is
 * null). Returns the new sign_in_link row's id, an error to show, or no id when
 * the visitor is over their limit (which isn't shown: send nothing, answer as usual).
 */
export async function countEmailedLink(
  projectId: string | null,
  email: string,
  requestHeaders: Headers,
): Promise<{ error: string } | { id: string | null }> {
  const emailHash = hashSecret(email);
  const client = await clientHash(requestHeaders);
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.signInLink.deleteMany({ where: { createdAt: { lt: since } } });
  return prisma.$transaction(async (tx) => {
    // One at a time per site, address and visitor (always in that order), so concurrent
    // requests can't overrun the limits together.
    if (projectId) {
      await lockProject(tx, projectId);
    } else {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(3, 0)`;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${emailHash}))`;
    if (client) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${client}))`;
    }
    const [byAddress, byClient, bySite] = await Promise.all([
      tx.signInLink.count({ where: { emailHash, createdAt: { gt: since } } }),
      client ? tx.signInLink.count({ where: { clientHash: client, createdAt: { gt: since } } }) : 0,
      tx.signInLink.count({ where: { projectId, createdAt: { gt: since } } }),
    ]);
    if (byAddress >= SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR) {
      return { error: "We've sent a lot of emails to this address in the last hour. Try again later." };
    }
    // Before the site's limit, so one visitor can't use it up for everyone.
    if (byClient >= SIGN_IN_LINKS_PER_CLIENT_PER_HOUR) {
      return { id: null };
    }
    if (bySite >= SIGN_IN_LINKS_PER_PORTAL_PER_HOUR) {
      return { error: "This site has sent a lot of emails in the last hour. Try again later." };
    }
    return tx.signInLink.create({ data: { projectId, emailHash, clientHash: client }, select: { id: true } });
  });
}

let warnedNoIpHeader = false;
let warnedBadIp = false;

/**
 * Who's asking, for the per-visitor limit: an HMAC of their IP address (an IPv6 address's /64, keyed with the
 * auth secret, so the stored hash can't be matched against a list of addresses), read
 * only from TRUSTED_IP_HEADER, a header the proxy sets. Without it there's no
 * per-visitor limit: X-Forwarded-For and the like can be anything the visitor sends.
 */
async function clientHash(requestHeaders: Headers): Promise<string | null> {
  const header = process.env.TRUSTED_IP_HEADER?.trim();
  if (!header) {
    if (!warnedNoIpHeader) {
      warnedNoIpHeader = true;
      log.warn("TRUSTED_IP_HEADER is not set: emailed sign-in and password reset links have no per-visitor limit");
    }
    return null;
  }
  // The proxy's own value is the last one if it appends to a list.
  const ip = requestHeaders.get(header)?.split(",").at(-1)?.trim();
  if (!ip) {
    return null;
  }
  // One visitor per IPv4 address or IPv6 /64.
  const key = clientKey(ip);
  if (!key) {
    if (!warnedBadIp) {
      warnedBadIp = true;
      log.warn("TRUSTED_IP_HEADER doesn't hold an IP address: no per-visitor limit for such requests", { header });
    }
    return null;
  }
  return createHmac("sha256", (await auth.$context).secret).update(key).digest("hex");
}
