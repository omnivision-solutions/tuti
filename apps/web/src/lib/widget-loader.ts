import { SLUG_PATTERN } from "./project-slugs";
import { WIDGET_CLOSE_MESSAGE, WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "./widget-messages";

/**
 * The widget loader served at /widget.js, for customers' own sites:
 *
 *   <script src="https://tuti.so/widget.js" data-project="acme" async></script>
 *
 * Adds a "Feedback" button that opens the project's portal /widget page in an
 * iframe. Plain ES5 without dependencies, and it never puts data into HTML: the
 * slug is checked against SLUG_PATTERN before it becomes part of a URL.
 *
 * Signing people in (their account in the customer's app, through the project's
 * JWT SSO): `Tuti.identify(getToken)` after the script loads, or
 * `window.TutiSettings = { identify: getToken }` before it. `getToken` returns a
 * fresh SSO token (or a promise of one); it's called whenever the panel is ready
 * for one, and the token is sent only to the portal's origin.
 */
export function widgetLoader(portalTemplate: string): string {
  return `(function () {
  "use strict";
  if (window.__tutiWidget) return;
  window.__tutiWidget = true;
  var script = document.currentScript;
  var slug = script && script.getAttribute("data-project");
  if (!slug || !${SLUG_PATTERN}.test(slug)) {
    console.error("Tuti widget: set data-project to your project's URL name, e.g. data-project=\\"acme\\"");
    return;
  }
  var portal = ${JSON.stringify(portalTemplate)}.replace("{project}", slug).replace(/\\/$/, "");
  var origin = new URL(portal).origin;
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var font = "600 14px/1 system-ui, -apple-system, 'Segoe UI', sans-serif";
  // Brand colours from globals.css: the host page has none of our CSS.

  function css(el, styles) {
    for (var key in styles) el.style[key] = styles[key];
  }

  var button = document.createElement("button");
  button.type = "button";
  button.textContent = "Feedback";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "tuti-widget");
  css(button, {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000",
    padding: "12px 18px", border: "0", borderRadius: "999px", cursor: "pointer", font: font,
    background: dark ? "oklch(0.759 0.168 154.6)" : "oklch(0.529 0.125 155)",
    color: dark ? "oklch(0.221 0.048 151.7)" : "#fff",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.2)"
  });

  var panel = document.createElement("div");
  panel.id = "tuti-widget";
  css(panel, {
    position: "fixed", right: "20px", bottom: "76px", zIndex: "2147483000", display: "none",
    width: "min(400px, calc(100vw - 40px))", height: "min(600px, calc(100vh - 100px))",
    borderRadius: "14px", overflow: "hidden", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
    background: dark ? "oklch(0.185 0.01 158.9)" : "oklch(0.994 0.007 88.6)"
  });
  var frame;

  function open() {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.src = portal + "/widget";
      frame.title = "Feedback";
      css(frame, { width: "100%", height: "100%", border: "0", display: "block" });
      panel.appendChild(frame);
    }
    panel.style.display = "block";
    button.setAttribute("aria-expanded", "true");
    frame.focus();
  }

  function close() {
    if (panel.style.display === "none") return;
    panel.style.display = "none";
    button.setAttribute("aria-expanded", "false");
    button.focus();
  }

  button.addEventListener("click", function () {
    if (panel.style.display === "none") open(); else close();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") close();
  });
  var getToken = window.TutiSettings && typeof window.TutiSettings.identify === "function" ? window.TutiSettings.identify : null;
  window.Tuti = {
    identify: function (fn) {
      if (typeof fn !== "function") {
        console.error("Tuti widget: Tuti.identify takes a function that returns a sign-in token");
        return;
      }
      getToken = fn;
    }
  };

  // Hands the panel a fresh sign-in token, only ever to the portal's origin.
  function sendToken() {
    if (!frame || !getToken) return;
    var target = frame.contentWindow;
    Promise.resolve()
      .then(function () { return getToken(); })
      .then(
        function (token) {
          if (typeof token === "string" && token) target.postMessage({ type: ${JSON.stringify(WIDGET_IDENTIFY_MESSAGE)}, token: token }, origin);
        },
        function (error) { console.error("Tuti widget: identify failed", error); }
      );
  }

  // From the panel (another origin): close (the close button, Escape) and ready-for-a-token.
  window.addEventListener("message", function (event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (event.data === ${JSON.stringify(WIDGET_CLOSE_MESSAGE)}) close();
    else if (event.data && event.data.type === ${JSON.stringify(WIDGET_READY_MESSAGE)}) sendToken();
  });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(button);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
`;
}
