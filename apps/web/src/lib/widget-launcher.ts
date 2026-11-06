/**
 * Whether the team's Custom code hides its widget's launcher, every way the loader takes: data-hide-launcher,
 * TutiSettings.hideLauncher, or an inline display (attribute or setting, however it's written; not CSS's `display: inline`,
 * which a setting would quote). A mere mention counts too, the cautious side: then the portal brings no launcher back for it.
 */
export const hidesLauncher = (html: string) => /data-hide-launcher|hideLauncher|display["'`]?\]?\s*=\s*["'`]?inline\b|display["'`]?\s*:\s*["'`]inline\b/i.test(html);
