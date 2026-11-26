import { prisma } from "@tuti/db";
import { checkEmailDomain, DEFAULT_TEAM_LANGUAGE, dropEmailDomain, forgetIdentity, languageCode, withEmailDomainLocks } from "@tuti/jobs";
import { aiEnabled, planIncludes, plansEnabled } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import { z } from "zod";

import { mailSubdomain, supportAddress, supportDomain } from "../inbound";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/** The support inbox's settings (Settings → Inbox and email, and Settings → AI → Inbox; docs/plan.md, Support inbox). */

export const MAX_DRAFT_INSTRUCTIONS = 2000;

export const supportSettings = async (projectId: string) => {
  const domain = supportDomain();
  const [project, subdomain, last, own] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true, supportDraftInstructions: true, teamLanguage: true, translateConversations: true, emailPausedAt: true, emailPausedReason: true, plan: true },
    }),
    prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } }),
    prisma.inboundEmail.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.emailDomain.findUnique({ where: { projectId } }),
  ]);
  return {
    inbox: project.supportInbox,
    // The team's standing instructions for replies drafted by AI (conversations.suggestReply).
    draftInstructions: project.supportDraftInstructions,
    // Inbox in the team's language (docs/plan.md L22).
    teamLanguage: project.teamLanguage ?? DEFAULT_TEAM_LANGUAGE,
    translate: project.translateConversations,
    // Email: whether this server receives it, the project's address (once it has one) and the latest email's time.
    email: domain
      ? {
          address: subdomain ? supportAddress(subdomain.subdomain, domain) : null,
          lastReceivedAt: last?.createdAt ?? null,
          // Paused (on a server selling plans, when its bounces or complaints went over): replies wait to be emailed till it's resumed.
          paused: plansEnabled() && project.emailPausedAt ? { at: project.emailPausedAt, reason: project.emailPausedReason ?? "" } : null,
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
                // Receiving: when an email forwarded from the address last came (the team forwards it to the support address).
                receivedAt: own?.receivedAt ?? null,
              }
            : null,
        }
      : null,
  };
};

const when = (description: string) => z.string().nullable().describe(`${description} (ISO 8601)`).meta({ examples: ["2026-11-18T09:30:00.000Z"] });

const supportEmailOutput = z
  .object({
    address: z.string().nullable().describe("The project's support email address; null until it has one").meta({ examples: ["support@acme.tuti.example.com"] }),
    lastReceivedAt: when("When the latest email came; null before the first"),
    paused: z
      .object({
        at: z.string().describe("When it was paused (ISO 8601)").meta({ examples: ["2026-11-18T09:30:00.000Z"] }),
        reason: z.string().describe("Why").meta({ examples: ["Too many bounces"] }),
      })
      .nullable()
      .describe("Where plans are sold: email paused, as its bounces or complaints went over; replies wait to be emailed till it's resumed. Null when not paused")
      .meta({ examples: [null] }),
    ownDomain: z
      .object({
        included: z.boolean().describe("Whether the project's plan includes email from your own domain").meta({ examples: [true] }),
        address: z.string().nullable().describe("The address replies come from once it's verified; null when not set").meta({ examples: ["support@example.com"] }),
        records: z
          .array(
            z.object({
              type: z.literal("CNAME").describe("The record's type").meta({ examples: ["CNAME"] }),
              name: z.string().describe("Its name").meta({ examples: ["abc123._domainkey.example.com"] }),
              value: z.string().describe("Its value").meta({ examples: ["abc123.dkim.amazonses.com"] }),
            }),
          )
          .describe("The DKIM CNAMEs to add to your DNS"),
        verified: z.boolean().describe("Whether Amazon SES has found the records: replies come from the address").meta({ examples: [false] }),
        checkedAt: when("When SES last checked; null before it has"),
        error: z.string().nullable().describe("What went wrong when it last checked; null when nothing did").meta({ examples: [null] }),
        receivedAt: when("When an email forwarded from the address last came (forward it to the support address); null before one has"),
      })
      .nullable()
      .describe("Sending from your own domain, with Amazon SES; null where the server doesn't offer it"),
  })
  .meta({ id: "SupportEmail", description: "The support inbox's email" });

const supportSettingsFields = {
  inbox: z.boolean().describe('Whether the support inbox is on: Messages in the widget, and "Ask a person" starts a conversation').meta({ examples: [true] }),
  draftInstructions: z
    .string()
    .describe("The team's standing instructions for replies drafted by AI (conversations.suggestReply)")
    .meta({ examples: ["Keep it short and friendly; sign off as the Acme team."] }),
  teamLanguage: z
    .string()
    .describe("The language the team reads and writes conversations in (a BCP 47 code): the project's default language unless set")
    .meta({ examples: ["en"] }),
  translate: z
    .boolean()
    .describe("Translate conversations: the user's messages in another language are translated into the team's, and the team's replies into the user's (AI credits, as the translation role)")
    .meta({ examples: [false] }),
  email: supportEmailOutput.nullable().describe("Email; null where the server doesn't receive email"),
};

const settingsOutput = z.object(supportSettingsFields).describe("The support settings as they are now");

/** Every domain a domain is under, itself first (help.acme.com: help.acme.com, acme.com). */
const domainAndParents = (domain: string) =>
  domain
    .split(".")
    .slice(0, -1)
    .map((_, i, labels) => domain.split(".").slice(i).join("."));

export const setEmailDomain = defineOperation({
  name: "support.setEmailDomain",
  title: "Set the email domain",
  summary:
    "Send replies by email from your own address: adds its domain to Amazon SES, whose 3 DKIM CNAMEs (`email.ownDomain.records`) go in your DNS. Replies come from it once SES finds them (`support.checkEmailDomain`); otherwise from the project's support address.",
  method: "POST",
  path: "/support/email-domain",
  scope: "write",
  access: "admin",
  errors: [402, 409],
  input: z.object({
    address: z
      .email()
      .max(254)
      .describe(
        "The address to send from (`support@yourcompany.com`). A domain is one project's alone. Where plans are sold, it takes a plan with email from your own domain (402)",
      )
      .meta({ examples: ["support@example.com"] }),
  }),
  example: { address: "support@example.com" },
  output: settingsOutput,
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
    // One change at a time to the project's domain, and to this domain and those above it.
    await withEmailDomainLocks([projectId, ...domainAndParents(domain)], async (tx) => {
      const current = await tx.emailDomain.findUnique({ where: { projectId } });
      if (current && current.domain !== domain) {
        throw new OperationError(409, "domain_set", `Remove ${current.domain} first`);
      }
      if (!current) {
        if (await tx.emailDomain.findUnique({ where: { domain } })) {
          throw new OperationError(409, "domain_taken", "Another project sends from this domain");
        }
        // SES has one identity per domain, and a domain sends as a verified domain above it allows.
        for (const name of domainAndParents(domain)) {
          const identity = await api.identity(name);
          if (!identity || identity.projectId === projectId) {
            continue;
          }
          // Left by a project since deleted: free again.
          if (identity.projectId && !(await tx.project.findUnique({ where: { id: identity.projectId }, select: { id: true } }))) {
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
        await tx.emailDomain.create({ data: { projectId, domain, address, dkimTokens: (created ?? existing)?.tokens ?? [] } });
      } else {
        // Another address on the domain hasn't been forwarded yet.
        await tx.emailDomain.update({ where: { projectId }, data: { address, ...(address !== current.address && { receivedAt: null }) } });
      }
    });
    return supportSettings(projectId);
  },
});

export const checkEmailDomainOperation = defineOperation({
  name: "support.checkEmailDomain",
  title: "Check the email domain",
  summary: "Ask Amazon SES now whether your domain's DKIM records are in place (it checks again daily on its own)",
  method: "POST",
  path: "/support/email-domain/check",
  scope: "write",
  access: "admin",
  errors: [404],
  input: z.object({}),
  output: settingsOutput,
  run: async ({ projectId }) => {
    if (!(await checkEmailDomain(projectId))) {
      throw new OperationError(404, "not_found", "No domain to check");
    }
    return supportSettings(projectId);
  },
});

export const removeEmailDomain = defineOperation({
  name: "support.removeEmailDomain",
  title: "Remove the email domain",
  summary: "Stop sending from your own domain: replies come from the project's support address again, and Amazon SES forgets the domain",
  method: "DELETE",
  path: "/support/email-domain",
  scope: "write",
  access: "admin",
  input: z.object({}),
  output: settingsOutput,
  run: async ({ projectId }) => {
    await dropEmailDomain(projectId);
    return supportSettings(projectId);
  },
});

export const getSupportSettings = defineOperation({
  name: "support.get",
  title: "Get the support settings",
  summary: "Get the support inbox's settings: whether it's on, the team's instructions for replies drafted by AI, the team's language and whether conversations are translated, and its email.",
  method: "GET",
  path: "/support",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: settingsOutput,
  run: async ({ projectId }) => supportSettings(projectId),
});

export const updateSupportSettings = defineOperation({
  name: "support.update",
  title: "Update the support settings",
  summary:
    "Turn the support inbox on or off, give the project its support email address, set the team's standing instructions for replies drafted by AI, or set the team's language and whether conversations are translated. Turning the inbox on gives the project its address too, where the server receives email.",
  method: "PATCH",
  path: "/support",
  scope: "write",
  access: "admin",
  errors: [409, 503],
  input: z
    .object({
      inbox: z
        .boolean()
        .optional()
        .describe("Turn the support inbox on or off; it takes “Ask a person” after an AI answer too (docs.escalate)")
        .meta({ examples: [true] }),
      email: z
        .literal(true)
        .optional()
        .describe("true gives the project its support email address, which is its for good (409 where the server doesn't receive email)")
        .meta({ examples: [true] }),
      draftInstructions: z
        .string()
        .trim()
        .max(MAX_DRAFT_INSTRUCTIONS, "Keep the instructions under 2,000 characters")
        .optional()
        .describe("The team's standing instructions for replies drafted by AI (conversations.suggestReply): their tone and form, up to 2,000 characters; a draft still says only what the docs say")
        .meta({ examples: ["Keep it short and friendly; sign off as the Acme team."] }),
      teamLanguage: z
        .string()
        .trim()
        .max(35)
        .transform((value, ctx) => languageCode(value) ?? (ctx.addIssue("Give a language code, like en or pt-BR"), z.NEVER))
        .optional()
        .describe("The language the team reads and writes conversations in: a BCP 47 code, like en or pt-BR")
        .meta({ examples: ["en"] }),
      translate: z
        .boolean()
        .optional()
        .describe(
          "Turn Translate conversations on or off: the user's messages translated into the team's language, and replies into theirs. Not available yet: true is refused (409) until the Inbox shows translated conversations",
        )
        .meta({ examples: [true] }),
    })
    .refine((input) => Object.values(input).some((value) => value !== undefined), "Send inbox, email, draftInstructions, teamLanguage or translate")
    .meta({ anyOf: [{ required: ["inbox"] }, { required: ["email"] }, { required: ["draftInstructions"] }, { required: ["teamLanguage"] }, { required: ["translate"] }] }),
  example: { inbox: true },
  output: settingsOutput,
  run: async ({ projectId }, input) => {
    // Until the Inbox shows translated conversations (docs/plan.md L22, part two), nothing in the app could read or send
    // one: on is refused. Part two lifts this.
    if (input.translate) {
      throw new OperationError(409, "not_available_yet", "Translating conversations isn't available yet: the Inbox can't show translated conversations");
    }
    if (input.translate && !aiEnabled()) {
      throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server, so conversations can't be translated");
    }
    if (input.email && !supportDomain()) {
      throw new OperationError(409, "email_off", "This server doesn't receive email (SUPPORT_EMAIL_DOMAIN isn't set)");
    }
    // Turning Messages on gives it the address too (where the server receives email), so replies can be emailed. The
    // address first: if that fails, Messages stays off, as the switch shows, and trying again does both.
    if (input.email || (input.inbox && supportDomain())) {
      await mailSubdomain(projectId);
    }
    if (input.inbox !== undefined || input.draftInstructions !== undefined || input.teamLanguage !== undefined || input.translate !== undefined) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.inbox !== undefined && { supportInbox: input.inbox }),
          ...(input.draftInstructions !== undefined && { supportDraftInstructions: input.draftInstructions }),
          ...(input.teamLanguage !== undefined && { teamLanguage: input.teamLanguage }),
          ...(input.translate !== undefined && { translateConversations: input.translate }),
        },
      });
    }
    return supportSettings(projectId);
  },
});
