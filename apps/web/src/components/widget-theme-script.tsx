import { WidgetThemeSync } from "@/components/widget-theme-sync";
import type { ColorScheme } from "@/lib/portal-look";
import { WIDGET_FRAME_NAME } from "@/lib/widget-messages";

/**
 * The panel's theme on the page before it shows: the site's pick (`data-theme`, in the panel's frame name), else the
 * project's colour scheme (Customize → Branding; "system" leaves next-themes' own script's, the visitor's). Once
 * React runs, WidgetThemeSync keeps ThemeProvider forcing it.
 */
export function WidgetThemeScript({ scheme }: { scheme: ColorScheme }) {
  const script = `(function(s){var m=${WIDGET_FRAME_NAME}.exec(window.name),t=(m&&m[2])||s,e=document.documentElement;if(!t)return;e.classList.remove("light","dark");e.classList.add(t);e.style.colorScheme=t})(${JSON.stringify(scheme === "system" ? "" : scheme)})`;
  // A fixed script: `scheme` is one of COLOR_SCHEMES.
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: script }} />
      <WidgetThemeSync scheme={scheme} />
    </>
  );
}
