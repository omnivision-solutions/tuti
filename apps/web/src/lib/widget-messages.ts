/** Messages between the widget loader (customer's page) and the widget panel (portal iframe). */

/** Panel → page: ask the loader to close the panel. */
export const WIDGET_CLOSE_MESSAGE = "tuti:close";
/** Panel → page: its page is up, with its own Close (on a phone the loader's stand-in for it goes); `{ type, closable: false }` as that page goes away (it may not have one). */
export const WIDGET_CLOSABLE_MESSAGE = "tuti:closable";
/** Panel → page: ready for a sign-in token (Tuti.identify). */
export const WIDGET_READY_MESSAGE = "tuti:ready";
/** Page → panel: `{ type, token }`, a sign-in token from the customer's app, or null when the page signs nobody in. */
export const WIDGET_IDENTIFY_MESSAGE = "tuti:identify";
/** Panel → page: `{ type, at }`, the visitor has seen the announcements published up to `at`. */
export const WIDGET_SEEN_MESSAGE = "tuti:seen";
/** Panel → page: `{ type, count }`, how many of the team's messages (Messages) the signed-in person hasn't seen. */
export const WIDGET_UNSEEN_MESSAGES = "tuti:unseen-messages";
/** Page → panel: `{ type, shown }`, the floating panel was opened or closed (a hidden panel sees nothing: Messages don't count as seen). */
export const WIDGET_SHOWN_MESSAGE = "tuti:shown";
/** The name of an inline panel's iframe (its `window.name`): there's nothing to close. */
export const WIDGET_INLINE_NAME = "tuti-inline";
