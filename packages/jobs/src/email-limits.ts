import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";

/** In its first week on a server selling plans, a project sends this many emails a day at most. */
export const NEW_PROJECT_EMAILS_PER_DAY = 200;
const NEW_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * How many more emails a project may send its users today (UTC) that they didn't ask for just now:
 * support replies and "shipped" (sign-in links and password resets never wait). On a server selling
 * plans, a project in its first week sends NEW_PROJECT_EMAILS_PER_DAY a day at most, so a new
 * project's spam reaches only so many before its bounces and complaints show; counted from SES's
 * events (apps/web/src/server/email-events.ts). Otherwise no limit: null.
 */
export async function projectEmailAllowance(projectId: string, now = new Date()): Promise<number | null> {
  // ponytail: SES's events come seconds after a send, and runs at once each see the same count, so
  // the cap can be passed by a run's worth; count at send time if that ever matters.
  if (!plansEnabled() || !process.env.SUPPORT_EMAIL_DOMAIN?.trim()) {
    return null;
  }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { createdAt: true, emailDays: { where: { day: new Date(now.toISOString().slice(0, 10)) }, select: { sent: true } } },
  });
  if (now.getTime() - project.createdAt.getTime() >= NEW_FOR_MS) {
    return null;
  }
  return Math.max(0, NEW_PROJECT_EMAILS_PER_DAY - (project.emailDays[0]?.sent ?? 0));
}
