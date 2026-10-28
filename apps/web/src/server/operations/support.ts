import { prisma } from "@tuti/db";
import { z } from "zod";

import { mailSubdomain, supportAddress, supportDomain } from "../inbound";
import { defineOperation, OperationError } from "./define";

/** The support inbox's settings (Settings → Support; docs/plan.md, Support inbox). */

export const supportSettings = async (projectId: string) => {
  const domain = supportDomain();
  const [project, subdomain, last] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true } }),
    prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } }),
    prisma.inboundEmail.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return {
    inbox: project.supportInbox,
    // Email: whether this server receives it, the project's address (once it has one) and the latest email's time.
    email: domain
      ? { address: subdomain ? supportAddress(subdomain.subdomain, domain) : null, lastReceivedAt: last?.createdAt ?? null }
      : null,
  };
};

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
