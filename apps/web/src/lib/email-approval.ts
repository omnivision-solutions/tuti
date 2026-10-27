import { signValue, verifyValue } from "./signed";

/**
 * The link the server's operator gets to approve a project emailing its users (docs/plan.md, Support
 * inbox, "Sending"): signed by us, for one project, for 7 days. Not a "use server" module: its exports
 * must never be callable from browsers.
 */

const PURPOSE = "email-approval";
const TTL_SECONDS = 7 * 24 * 60 * 60;

export const approvalToken = (projectId: string, now = Date.now()) => signValue(PURPOSE, [projectId], TTL_SECONDS, now);

/** The project an approval link is for, if it's valid and unexpired. */
export function approvalProject(token: string, now = Date.now()): string | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  return fields?.length === 1 && fields[0] ? fields[0] : null;
}
