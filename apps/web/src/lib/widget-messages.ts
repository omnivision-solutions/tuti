/** Messages between the widget loader (customer's page) and the widget panel (portal iframe). */

/** Panel → page: ask the loader to close the panel. */
export const WIDGET_CLOSE_MESSAGE = "tuti:close";
/** Panel → page: ready for a sign-in token (Tuti.identify). */
export const WIDGET_READY_MESSAGE = "tuti:ready";
/** Page → panel: `{ type, token }`, a sign-in token from the customer's app. */
export const WIDGET_IDENTIFY_MESSAGE = "tuti:identify";
/** Panel → page: `{ type, at }`, the visitor has seen the announcements published up to `at`. */
export const WIDGET_SEEN_MESSAGE = "tuti:seen";
