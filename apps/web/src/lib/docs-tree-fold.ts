/** The app's docs tree folded to a rail beside the page, from laptop width up. Remembered per browser. */
export const DOCS_TREE_FOLDED_KEY = "tuti:docs-tree-folded";
/** On <html> while it's folded; DocsWorkspace's columns follow it. */
export const DOCS_TREE_FOLDED_ATTRIBUTE = "data-docs-tree-folded";
/** Run before the page shows (the app layout), so a folded tree never flashes open. */
export const DOCS_TREE_FOLDED_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(DOCS_TREE_FOLDED_KEY)})==="1")document.documentElement.setAttribute("${DOCS_TREE_FOLDED_ATTRIBUTE}","")}catch(e){}`;
