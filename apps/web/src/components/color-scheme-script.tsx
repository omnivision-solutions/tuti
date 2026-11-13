import { type ColorScheme, THEME_DEFAULT_KEY } from "@/lib/portal-look";

/**
 * The portal's default colour scheme (Customize → Branding), for readers who haven't picked one: run
 * before the page shows, it puts it where next-themes keeps the reader's pick, and marks it as the
 * default (THEME_DEFAULT_KEY), so a later default replaces it while a reader's own pick stays. Without the readers'
 * switch (`readerPicks` false) the default replaces a reader's earlier pick too: every reader gets it.
 */
/** A string as a script literal, safe inside a <script> tag whatever it holds. */
const inline = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

export function ColorSchemeScript({ scheme, readerPicks }: { scheme: ColorScheme; readerPicks: boolean }) {
  const script = `(function(s,k,p){try{var t=localStorage.getItem("theme"),m=localStorage.getItem(k);if(p&&t!==null&&t!==m)return;if(s==="system"){if(t!==null){localStorage.removeItem("theme");localStorage.removeItem(k)}else return}else{localStorage.setItem("theme",s);localStorage.setItem(k,s)}var d=s==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):s,e=document.documentElement;e.classList.remove("light","dark");e.classList.add(d);e.style.colorScheme=d}catch(e){}})(${inline(scheme)},${inline(THEME_DEFAULT_KEY)},${readerPicks ? "true" : "false"})`;
  // A fixed script: `scheme` is one of COLOR_SCHEMES.
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
