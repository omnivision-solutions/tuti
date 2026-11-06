/** Messages between the widget loader (customer's page) and the widget panel (portal iframe). */

/** Panel → page: ask the loader to close the panel. */
export const WIDGET_CLOSE_MESSAGE = "tuti:close";
/** Panel → page: its page is up, with its own Close (on a phone the loader's stand-in for it goes); `{ type, closable: false }` as that page goes away (it may not have one). */
export const WIDGET_CLOSABLE_MESSAGE = "tuti:closable";
/** Panel → page: ready for a sign-in token (Tuti.identify). */
export const WIDGET_READY_MESSAGE = "tuti:ready";
/** Page → panel: `{ type, token }`, a sign-in token from the customer's app, or null when the page signs nobody in. */
export const WIDGET_IDENTIFY_MESSAGE = "tuti:identify";
/**
 * Panel → page: `{ type, at }`, the visitor has seen the announcements published up to `at`. With `ask: true`
 * (`at` optional: Home only asks) the page first answers with WIDGET_SEEN_BEFORE_MESSAGE, once it knows.
 */
export const WIDGET_SEEN_MESSAGE = "tuti:seen";
/** Page → panel: `{ type, seen }`, up to when the visitor had seen announcements before (this browser's or, signed in, any device's; null: never). */
export const WIDGET_SEEN_BEFORE_MESSAGE = "tuti:seen-before";
/** Panel → page: `{ type, count }`, how many of the team's messages (Messages) the signed-in person hasn't seen. */
export const WIDGET_UNSEEN_MESSAGES = "tuti:unseen-messages";
/** Page → panel: `{ type, shown }`, the floating panel was opened or closed (a hidden panel sees nothing: Messages don't count as seen). */
export const WIDGET_SHOWN_MESSAGE = "tuti:shown";
/**
 * Page → panel: `{ type, theme }`, the site changed the theme (Tuti.setTheme): "light", "dark" or "auto" (the
 * project's colour scheme). The panel takes it now and puts it in its frame's name for the pages after.
 */
export const WIDGET_THEME_MESSAGE = "tuti:widget-theme";
/** Panel → page: its page is listening for WIDGET_THEME_MESSAGE; a theme the site changed while it loaded is sent again. */
export const WIDGET_THEME_ASK_MESSAGE = "tuti:widget-theme-ask";
/**
 * Loader → the panel: ask its assistant `ask` (empty: just open it), after `turn` (a question and its answer from elsewhere,
 * to follow up on), sent once the panel says it's listening (WIDGET_ASK_READY_MESSAGE) (Tuti.open({ ask })).
 */
export const WIDGET_ASK_MESSAGE = "tuti:ask";
/** Panel → loader: its assistant is listening for WIDGET_ASK_MESSAGE (each page of it, once it's ready; `href`, which page), or `listening: false` as its page goes. */
export const WIDGET_ASK_READY_MESSAGE = "tuti:ask-ready";
/** The name of an inline panel's iframe (its `window.name`): there's nothing to close. */
export const WIDGET_INLINE_NAME = "tuti-inline";
/** The floating panel's iframe. */
export const WIDGET_PANEL_NAME = "tuti-panel";
/**
 * A panel's iframe name, with the theme the site picked (`data-theme`) after a colon ("tuti-inline:dark"):
 * a frame keeps its name as it navigates, so every page it shows has it.
 */
export const WIDGET_FRAME_NAME = /^(tuti-inline|tuti-panel)(?::(light|dark))?$/;

/** What a panel's iframe name says: whether it's inline, and the theme the site picked (null: the project's colour scheme). */
export function widgetFrame(name: string): { inline: boolean; theme: "light" | "dark" | null } {
  const match = WIDGET_FRAME_NAME.exec(name);
  return { inline: match?.[1] === WIDGET_INLINE_NAME, theme: (match?.[2] as "light" | "dark" | undefined) ?? null };
}
