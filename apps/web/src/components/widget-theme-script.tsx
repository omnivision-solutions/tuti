import { WIDGET_FRAME_NAME } from "@/lib/widget-messages";

/**
 * The theme the site picked for its widget (`data-theme`, in the panel's frame name), on the page before it
 * shows: next-themes' own script has already put the visitor's there. Once React runs, ThemeProvider forces it.
 */
export function WidgetThemeScript() {
  const script = `(function(){var m=${WIDGET_FRAME_NAME}.exec(window.name),t=m&&m[2],e=document.documentElement;if(!t)return;e.classList.remove("light","dark");e.classList.add(t);e.style.colorScheme=t})()`;
  // A fixed script: nothing in it comes from the request.
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
