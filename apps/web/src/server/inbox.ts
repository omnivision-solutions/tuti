"use server";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";
import { emailConfigured, emailDomainTestEmail, sendEmail } from "@tuti/email";
import { sesTenantHeaders } from "@tuti/jobs";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { asAdmin, call } from "./operations/run";
import { supportDomain } from "./inbound";
import { requirePlan } from "./operations/plan";
import { checkEmailDomainOperation, removeEmailDomain, setEmailDomain, updateSupportSettings } from "./operations/support";

/** Settings → Inbox and email's actions (owners and admins), till that screen moves onto the router (T3). */

/** Settings → Inbox and email: turns the inbox on or off (owners and admins). */
export async function setSupportInbox(projectSlug: string, on: boolean): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { inbox: on === true }),
  );
}

/** Settings → Inbox and email: Translate conversations and the team's language (owners and admins; see support.update). */
export async function setTranslation(projectSlug: string, change: { translate?: boolean; teamLanguage?: string }): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { translate: change.translate, teamLanguage: change.teamLanguage }),
  );
}

/** Settings → AI → Inbox: the team's instructions for replies drafted by AI (owners and admins; see support.update). */
export async function saveDraftInstructions(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", (context) =>
    call(updateSupportSettings, context, {
      // A form sends a textarea's line breaks as CRLF: stored as the box shows and counts them.
      draftInstructions: String(formData.get("instructions") ?? "").replace(/\r\n/g, "\n"),
    }),
  );
}

/** Settings → Inbox and email: gives the project its support email address (owners and admins). */
export async function getSupportAddress(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can change support settings", async (context) =>
    call(updateSupportSettings, context, { email: true }),
  );
}

const SUPPORT_DENIED = "Only project owners and admins can change support settings";

/** Settings → Inbox and email → Send from your own address (support.setEmailDomain): replies from the team's own address. */
export async function saveEmailDomain(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, (context) => call(setEmailDomain, context, { address: String(formData.get("address") ?? "").trim() }));
}

export async function checkEmailDomain(projectSlug: string): Promise<{ error?: string; verified?: boolean }> {
  let verified = false;
  const result = await asAdmin(projectSlug, SUPPORT_DENIED, async (context) => {
    verified = !!(await call(checkEmailDomainOperation, context, {})).email?.ownDomain?.verified;
  });
  return result.error ? result : { verified };
}

export async function forgetEmailDomain(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, (context) => call(removeEmailDomain, context, {}));
}

/** Emails the admin a test from the team's verified address, under the project's tenant, as replies go (only when they do). */
export async function sendEmailDomainTest(projectSlug: string): Promise<FormState> {
  return asAdmin(projectSlug, SUPPORT_DENIED, async ({ actor, projectId }) => {
    const domain = supportDomain();
    if (!ses() || !domain) {
      throw new OperationError(409, "ses_off", "This server doesn't send email from teams' own domains");
    }
    await requirePlan(projectId, "emailDomain");
    const [own, project, user] = await Promise.all([
      prisma.emailDomain.findUnique({ where: { projectId } }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      actor.kind === "user" ? prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null,
    ]);
    if (!own?.verifiedAt) {
      throw new OperationError(409, "not_verified", "Your address isn't verified yet: check it first");
    }
    if (!user) {
      throw new OperationError(400, "no_address", "There's no address to send the test to");
    }
    // Without a mail server, sendEmail only logs it: not a test of anything.
    if (!emailConfigured()) {
      throw new OperationError(409, "email_off", "This server doesn't send email (SMTP_HOST isn't set)");
    }
    try {
      await sendEmail({
        to: user.email,
        from: `"${project.name.replace(/["\\\r\n]/g, "")}" <${own.address}>`,
        headers: (await sesTenantHeaders(projectId, domain, own.domain)) ?? {},
        ...emailDomainTestEmail({ projectName: project.name, address: own.address }),
      });
    } catch (error) {
      log.warn("A test email from a team's own address failed", { projectId, error });
      throw new OperationError(502, "email_failed", `The test email couldn't be sent: ${String(error).slice(0, 200)}`);
    }
  });
}

