/** Messages between the widget loader (customer's page) and the widget panel (portal iframe). */

/** Panel → page: ask the loader to close the panel. */
export const WIDGET_CLOSE_MESSAGE = "tuti:close";
/** Panel → page: ready for a sign-in token (Tuti.identify). */
export const WIDGET_READY_MESSAGE = "tuti:ready";
/** Page → panel: `{ type, token }`, a sign-in token from the customer's app. */
export const WIDGET_IDENTIFY_MESSAGE = "tuti:identify";
/** Panel → page: `{ type, at }`, the visitor has seen the announcements published up to `at`. */
export const WIDGET_SEEN_MESSAGE = "tuti:seen";
/** Panel → page: `{ type, count }`, how many of the team's messages (Messages) the signed-in person hasn't seen. */
export const WIDGET_UNSEEN_MESSAGES = "tuti:unseen-messages";
/** The name of an inline panel's iframe (its `window.name`): there's nothing to close. */
export const WIDGET_INLINE_NAME = "tuti-inline";
