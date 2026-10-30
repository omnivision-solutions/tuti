/** Opens ⌘K (components/command-menu.tsx) from anywhere in a project's pages: the sidebar's Search sends it. */
export const OPEN_COMMAND_MENU = "tuti:command-menu";

/** The longest search ⌘K's box takes (and the server searches). */
export const MAX_QUERY = 200;

/** ⌘K going to a page in the app (`detail`: its address). Cancelable: a page with changes not saved cancels it and asks first. */
export const COMMAND_MENU_NAVIGATE = "tuti:command-menu-navigate";
