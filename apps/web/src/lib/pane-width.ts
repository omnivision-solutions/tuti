/** Width preferences live on <html>, like the docs tree's fold, so every app route shares them. */
export const PANE_WIDTHS = {
  docs: { key: "tuti:docs-tree-width", variable: "--docs-tree-width", selector: ".docs-tree-pane", min: 240, max: 440, default: 274, label: "Resize docs tree" },
  inbox: { key: "tuti:inbox-list-width", variable: "--inbox-list-width", selector: ".inbox-list-body", min: 352, max: 520, default: "22rem", label: "Resize conversation list" },
} as const;

export type ResizablePane = keyof typeof PANE_WIDTHS;

/**
 * Client entry from marketing/sign-in also restores preferences in AppShell's layout effect.
 * Inbox's minimum is in rem: CSS and the handle clamp it at the current text size.
 */
export function restorePaneWidths() {
  for (const [pane, { key, variable, min, max }] of Object.entries(PANE_WIDTHS)) {
    try {
      const width = Number(localStorage.getItem(key));
      if (Number.isFinite(width) && width > 0) document.documentElement.style.setProperty(variable, `${Math.min(max, pane === "inbox" ? width : Math.max(min, width))}px`);
    } catch {
      // Storage blocked: keep this visit's widths.
    }
  }
}

/** Inline in the app layout, before the panes' HTML: saved widths apply without waiting for hydration. */
export const PANE_WIDTHS_SCRIPT = Object.entries(PANE_WIDTHS).map(([pane, { key, variable, min, max }]) =>
  `try{var w=Number(localStorage.getItem(${JSON.stringify(key)}));if(Number.isFinite(w)&&w>0)document.documentElement.style.setProperty(${JSON.stringify(variable)},Math.min(${max},${pane === "inbox" ? "w" : `Math.max(${min},w)`})+"px")}catch(e){}`,
).join("");
