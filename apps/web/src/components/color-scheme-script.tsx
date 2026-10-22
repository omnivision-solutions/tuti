import { type ColorScheme, THEME_DEFAULT_KEY } from "@/lib/portal-look";

/**
 * The portal's default colour scheme (Customize → Branding), for readers who haven't picked one: run
 * before the page shows, it puts it where next-themes keeps the reader's pick, and marks it as the
 * default (THEME_DEFAULT_KEY), so a later default replaces it while a reader's own pick stays.
 */
export function ColorSchemeScript({ scheme }: { scheme: ColorScheme }) {
  const script = `(function(s,k){try{var t=localStorage.getItem("theme"),m=localStorage.getItem(k);if(t!==null&&t!==m)return;if(s==="system"){if(t!==null){localStorage.removeItem("theme");localStorage.removeItem(k)}else return}else{localStorage.setItem("theme",s);localStorage.setItem(k,s)}var d=s==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):s,e=document.documentElement;e.classList.remove("light","dark");e.classList.add(d);e.style.colorScheme=d}catch(e){}})(${JSON.stringify(scheme)},${JSON.stringify(THEME_DEFAULT_KEY)})`;
  // A fixed script: `scheme` is one of COLOR_SCHEMES.
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
