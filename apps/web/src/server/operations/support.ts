import { prisma } from "@tuti/db";
import { checkEmailDomain, dropEmailDomain, forgetIdentity } from "@tuti/jobs";
import { planIncludes, plansEnabled } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import { z } from "zod";

import { mailSubdomain, supportAddress, supportDomain } from "../inbound";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/** The support inbox's settings (Settings → Support; docs/plan.md, Support inbox). */

export const supportSettings = async (projectId: string) => {
  const domain = supportDomain();
  const [project, subdomain, last, own] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true, emailApprovedAt: true, emailRequestedAt: true, plan: true } }),
    prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } }),
    prisma.inboundEmail.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.emailDomain.findUnique({ where: { projectId } }),
  ]);
  return {
    inbox: project.supportInbox,
    // Email: whether this server receives it, the project's address (once it has one) and the latest email's time.
    email: domain
      ? {
          address: subdomain ? supportAddress(subdomain.subdomain, domain) : null,
          lastReceivedAt: last?.createdAt ?? null,
          // On a server selling plans: whether replies are emailed to users yet (the operator approves each project).
          approval: plansEnabled() ? { approved: !!project.emailApprovedAt, requestedAt: project.emailRequestedAt } : null,
          // Sending from the team's own domain: offered with Amazon SES (`included`: on the project's plan).
          ownDomain: ses()
            ? {
                included: planIncludes(project.plan, "emailDomain"),
                address: own?.address ?? null,
                // The CNAMEs to add (Easy DKIM), SES's verification and when it last checked; replies come from it once verified.
                records: (own?.dkimTokens ?? []).map((token) => ({ type: "CNAME" as const, name: `${token}._domainkey.${own!.domain}`, value: `${token}.dkim.amazonses.com` })),
                verified: !!own?.verifiedAt,
                checkedAt: own?.checkedAt ?? null,
                error: own?.error ?? null,
              }
            : null,
        }
      : null,
  };
};

/** Every domain a domain is under, itself first (help.acme.com: help.acme.com, acme.com). */
const domainAndParents = (domain: string) =>
  domain
    .split(".")
    .slice(0, -1)
    .map((_, i, labels) => domain.split(".").slice(i).join("."));

export const setEmailDomain = defineOperation({
  name: "support.setEmailDomain",
  summary:
    "Send replies by email from your own address (`support@yourcompany.com`): adds its domain to Amazon SES, whose 3 DKIM CNAMEs (`support.get`, `email.ownDomain.records`) go in your DNS. Replies come from it once SES finds them (`support.checkEmailDomain`); until then, from the project's support address. A domain is one project's alone. Pro plan",
  method: "POST",
  path: "/support/email-domain",
  scope: "write",
  access: "admin",
  input: z.object({ address: z.email().max(254) }),
  example: { address: "support@example.com" },
  run: async ({ projectId }, { address: given }) => {
    const api = ses();
    const support = supportDomain();
    if (!api || !support) {
      throw new OperationError(409, "ses_off", "This server doesn't send email from teams' own domains");
    }
    await requirePlan(projectId, "emailDomain");
    const address = given.toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (!domain.includes(".") || domain === support || domain.endsWith(`.${support}`)) {
      throw new OperationError(400, "invalid_domain", "Use an address on your own domain");
    }
    const current = await prisma.emailDomain.findUnique({ where: { projectId } });
    if (current && current.domain !== domain) {
      throw new OperationError(409, "domain_set", `Remove ${current.domain} first`);
    }
    if (!current) {
      if (await prisma.emailDomain.findUnique({ where: { domain } })) {
        throw new OperationError(409, "domain_taken", "Another project sends from this domain");
      }
      // SES has one identity per domain, and a domain sends as a verified domain above it allows.
      for (const name of domainAndParents(domain)) {
        const identity = await api.identity(name);
        if (!identity || identity.projectId === projectId) {
          continue;
        }
        // Left by a project since deleted: free again.
        if (identity.projectId && !(await prisma.project.findUnique({ where: { id: identity.projectId }, select: { id: true } }))) {
          await forgetIdentity(identity.projectId, name);
          continue;
        }
        // The server's own (no project), the domain itself, or a domain above it that sends.
        if (!identity.projectId || name === domain || identity.verified) {
          throw new OperationError(409, "domain_taken", "This domain is set up for sending elsewhere");
        }
      }
      const created = await api.addDomain(domain, projectId);
      const existing = created ? null : await api.identity(domain);
      // Another project added it meanwhile: it's theirs.
      if (!created && existing?.projectId !== projectId) {
        throw new OperationError(409, "domain_taken", "Another project sends from this domain");
      }
      const added = created ?? existing;
      try {
        await prisma.emailDomain.create({ data: { projectId, domain, address, dkimTokens: added?.tokens ?? [] } });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") {
          throw error;
        }
        // Another request saved a domain first: SES forgets the one this one added.
        if (created) {
          await api.removeDomain(domain);
        }
        throw new OperationError(409, "domain_taken", "Another project sends from this domain");
      }
    } else {
      await prisma.emailDomain.update({ where: { projectId }, data: { address } });
    }
    return supportSettings(projectId);
  },
});

export const checkEmailDomainOperation = defineOperation({
  name: "support.checkEmailDomain",
  summary: "Ask Amazon SES now whether your domain's DKIM records are in place (it checks again daily on its own)",
  method: "POST",
  path: "/support/email-domain/check",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    if (!(await checkEmailDomain(projectId))) {
      throw new OperationError(404, "not_found", "No domain to check");
    }
    return supportSettings(projectId);
  },
});

export const removeEmailDomain = defineOperation({
  name: "support.removeEmailDomain",
  summary: "Stop sending from your own domain: replies come from the project's support address again, and Amazon SES forgets the domain",
  method: "DELETE",
  path: "/support/email-domain",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    await dropEmailDomain(projectId);
    return supportSettings(projectId);
  },
});

export const getSupportSettings = defineOperation({
  name: "support.get",
  summary:
    "Get the support inbox's settings: whether it's on (Messages in the widget; \"Ask a person\" starts a conversation), and its email address (null until it has one; `email` is null where the server doesn't receive email)",
  method: "GET",
  path: "/support",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => supportSettings(projectId),
});

export const updateSupportSettings = defineOperation({
  name: "support.update",
  summary: "Turn the support inbox on or off, or (`email: true`) give the project its support email address, which is its for good",
  method: "PATCH",
  path: "/support",
  scope: "write",
  access: "admin",
  input: z
    .object({ inbox: z.boolean().optional(), email: z.literal(true).optional() })
    .refine((input) => input.inbox !== undefined || input.email !== undefined, "Send inbox or email")
    .meta({ anyOf: [{ required: ["inbox"] }, { required: ["email"] }] }),
  example: { inbox: true },
  run: async ({ projectId }, input) => {
    if (input.email && !supportDomain()) {
      throw new OperationError(409, "email_off", "This server doesn't receive email (SUPPORT_EMAIL_DOMAIN isn't set)");
    }
    if (input.inbox !== undefined) {
      await prisma.project.update({ where: { id: projectId }, data: { supportInbox: input.inbox } });
    }
    if (input.email) {
      await mailSubdomain(projectId);
    }
    return supportSettings(projectId);
  },
});
