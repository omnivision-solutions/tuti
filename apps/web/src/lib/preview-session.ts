import { randomBytes } from "node:crypto";

import { PREVIEW_TTL_SECONDS } from "./portal-base";
import { signValue, verifyValue } from "./signed";

/**
 * Preview tokens: Customize's preview of a portal reads it as the team member customizing it, even a
 * private one, though their portal session (if any) is another site's cookie there. The app puts a
 * token in the frame's first address (PREVIEW_TOKEN_PARAM, lib/portal-base.ts); proxy.ts trades it for a cookie on the
 * portal (partitioned to the app's site, an hour) and takes it out of the address. Signed by us,
 * for one person in one project; their team membership is checked each time it's used.
 *
 * Not a "use server" module on purpose: its exports must never be callable from browsers.
 */

const PURPOSE = "preview";
export { PREVIEW_TOKEN_PARAM, PREVIEW_TTL_SECONDS } from "./portal-base";

/**
 * With a random part, so each render of a page gets a token of its own: Customize's preview takes a new
 * token when the one it's given changes, and two renders in the same second would otherwise sign the same.
 */
export function previewToken(projectId: string, userId: string, now = Date.now()): string {
  return signValue(PURPOSE, [projectId, userId, randomBytes(9).toString("base64url")], PREVIEW_TTL_SECONDS, now);
}

/** The team member a preview token is for, if it's valid, unexpired and for this project. */
export function previewUser(projectId: string, token: string, now = Date.now()): string | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  // ponytail: two fields are tokens from before they had their random part, gone an hour after this shipped; then only 3.
  return fields && (fields.length === 2 || fields.length === 3) && fields[0] === projectId && fields[1] ? fields[1] : null;
}
