import { signValue, verifyValue } from "./signed";

/**
 * The link the server's operator gets when a project's email is paused (packages/jobs/src/email-limits.ts),
 * to resume it: signed by us, for one project's one pause (a link from an earlier pause can't undo a
 * later one), for 30 days. Not a "use server" module: its exports must never be callable from browsers.
 */

const PURPOSE = "email-pause";
const TTL_SECONDS = 30 * 24 * 60 * 60;

export const resumeToken = (projectId: string, pausedAt: Date, now = Date.now()) => signValue(PURPOSE, [projectId, String(pausedAt.getTime())], TTL_SECONDS, now);

/** The project and pause a resume link is for, if it's valid and unexpired. */
export function resumePause(token: string, now = Date.now()): { projectId: string; pausedAt: Date } | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  const pausedAt = Number(fields?.[1]);
  return fields?.length === 2 && fields[0] && Number.isInteger(pausedAt) ? { projectId: fields[0], pausedAt: new Date(pausedAt) } : null;
}
