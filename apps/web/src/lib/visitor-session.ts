import { createHash, randomBytes } from "node:crypto";

import { signValue, verifyValue } from "./signed";

/**
 * Visitor tokens: a signed-out visitor in the widget's Messages (docs/plan.md, Support inbox).
 * Signed by us, for one project, for 30 days, and kept in the panel's own storage (partitioned
 * per embedding site; the customer's page can't read it). Conversations keep only a hash of the
 * token's id, so a leaked database makes no tokens.
 *
 * Not a "use server" module on purpose: its exports must never be callable from browsers.
 */

const PURPOSE = "visitor";
const TTL_SECONDS = 30 * 24 * 60 * 60;

const hashOf = (id: string) => createHash("sha256").update(id).digest("hex");

/** A new visitor: their token, and the hash conversations keep. */
export function newVisitor(projectId: string, now = Date.now()) {
  const id = randomBytes(18).toString("base64url");
  return { token: signValue(PURPOSE, [projectId, id], TTL_SECONDS, now), hash: hashOf(id) };
}

/** The hash for a visitor token, if it's valid, unexpired and for this project. */
export function visitorHash(projectId: string, token: string, now = Date.now()): string | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  return fields?.length === 2 && fields[0] === projectId && fields[1] ? hashOf(fields[1]) : null;
}
