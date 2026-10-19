import { signValue, verifyValue } from "./signed";

/**
 * Widget tokens: who's signed in inside the widget on a customer's site. Cookies
 * set by the portal aren't sent to its iframe there, so the customer's page hands
 * the panel an SSO token from their own app (Tuti.identify), and the panel trades
 * it for one of these: signed by us, for one person in one project, for 12 hours,
 * kept only in the panel's memory (the customer's page can't read another
 * origin's) and sent with each action.
 *
 * Not a "use server" module on purpose: its exports must never be callable from browsers.
 */

const PURPOSE = "widget";
const TTL_SECONDS = 12 * 60 * 60;

export function widgetToken(projectId: string, userId: string, now = Date.now()): string {
  return signValue(PURPOSE, [projectId, userId], TTL_SECONDS, now);
}

/** The person a widget token is for, if it's valid, unexpired and for this project. */
export function widgetUser(projectId: string, token: string, now = Date.now()): string | null {
  const fields = verifyValue(PURPOSE, String(token), now);
  return fields?.length === 2 && fields[0] === projectId && fields[1] ? fields[1] : null;
}
