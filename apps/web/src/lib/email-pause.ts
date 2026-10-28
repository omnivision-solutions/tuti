import { signValue, verifyValue } from "./signed";

/**
 * The link the server's operator gets when a project's email is paused (packages/jobs/src/email-limits.ts),
 * to resume it: signed by us, for one project, for 30 days. Not a "use server" module: its exports
 * must never be callable from browsers.
 */

const PURPOSE = "email-pause";
const TTL_SECONDS = 30 * 24 * 60 * 60;

export const resumeToken = (projectId: string, now = Date.now()) => signValue(PURPOSE, [projectId], TTL_SECONDS, now);

/** The project a resume link is for, if it's valid and unexpired. */
export function resumeProject(token: string, now = Date.now()): string | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  return fields?.length === 1 && fields[0] ? fields[0] : null;
}
