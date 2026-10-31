import { SLUG_PATTERN } from "./project-slugs";
import { WIDGET_ICONS } from "./widget-icons";
import {
  WIDGET_CLOSABLE_MESSAGE,
  WIDGET_CLOSE_MESSAGE,
  WIDGET_IDENTIFY_MESSAGE,
  WIDGET_INLINE_NAME,
  WIDGET_READY_MESSAGE,
  WIDGET_SEEN_MESSAGE,
  WIDGET_SHOWN_MESSAGE,
  WIDGET_UNSEEN_MESSAGES,
} from "./widget-messages";

/**
 * The widget loader served at /widget.js, for customers' own sites:
 *
 *   <script src="https://tuti.so/widget.js" data-project="acme" async></script>
 *
 * Adds a launcher, a round button with an icon, that opens the project's portal /widget
 * page in an iframe. Plain ES5 without dependencies, and it never puts data into HTML: the
 * slug is checked against SLUG_PATTERN before it becomes part of a URL, and icons are built
 * as SVG elements (an uploaded one is an image's src). The SDK is documented in docs/widget.md.
 *
 * The launcher's name (its aria-label and tooltip), colour, corner and icon come from
 * /api/widget/latest (set in the app), along with the latest announcement; the button appears once that's read (or
 * after 3 seconds without it), so it doesn't change under the visitor's pointer.
 * `data-hide-launcher` (or `TutiSettings.hideLauncher`) leaves it out, for sites with
 * their own button.
 *
 * `data-display` (or `TutiSettings.display`) picks how it shows: "launcher" (the default,
 * a panel above the button), "sidebar" (a full-height drawer on the button's side, over a
 * backdrop on narrow screens) or "inline" (no button). Any element with `data-tuti-inline`
 * gets the panel in it, in every mode: its own iframe, at the tab it names
 * (`data-tuti-inline="docs"`; empty for Home), without a close button; elements
 * added later get one too.
 *
 * Signing people in (their account in the customer's app, through the project's
 * JWT SSO): `Tuti.identify(getToken)` after the script loads, or
 * `window.TutiSettings = { identify: getToken }` before it. `getToken` returns a
 * fresh SSO token (or a promise of one); it's called whenever the panel is ready
 * for one, and the token is sent only to the portal's origin.
 *
 * `Tuti.open()` opens the panel, `Tuti.open({ tab })` at a tab, and
 * `Tuti.open({ article: "<slug>" })` at a docs article, as does clicking any
 * element with `data-tuti-article="<slug>"` (contextual help buttons; one listener
 * on the document, so elements added later work too). `Tuti.close()` closes it.
 *
 * A dot on the button says there's an announced changelog entry this visitor hasn't
 * seen yet (what this browser has seen is kept in the customer site's localStorage);
 * `Tuti.unseen()` and `Tuti.on("unseen", callback)` tell the page, for its own button.
 * For people the page signs in it's per person, across devices: when this browser hasn't
 * seen the latest announcement, the script asks /api/widget/seen (with a fresh token from
 * `getToken`) whether they have elsewhere, and tells it when the panel has shown one. The
 * later of the two times counts.
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
  var settings = window.TutiSettings || {};
  var display = script.getAttribute("data-display") || settings.display || "launcher";
  if (display !== "launcher" && display !== "sidebar" && display !== "inline") {
    console.error("Tuti widget: display is one of launcher, sidebar or inline");
    display = "launcher";
  }
  var sidebar = display === "sidebar";
  var hideLauncher = display === "inline" || script.hasAttribute("data-hide-launcher") || settings.hideLauncher === true;
  var portal = ${JSON.stringify(portalTemplate)}.replace("{project}", slug).replace(/\\/$/, "");
  var origin = new URL(portal).origin;
  var api = new URL(script.src).origin;
  var seenKey = "tuti:seen:" + slug;
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  // Brand colours from globals.css: the host page has none of our CSS.

  function css(el, styles) {
    for (var key in styles) el.style[key] = styles[key];
  }
  function whenBody(fn) {
    if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn);
  }

  // The launcher: a round button with an icon; its name is for screen readers and its tooltip.
  var label = "Feedback";
  var button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "tuti-widget");
  css(button, {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000",
    width: "56px", height: "56px", padding: "0", border: "0", borderRadius: "999px", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: dark ? "oklch(0.759 0.168 154.6)" : "oklch(0.529 0.125 155)",
    color: dark ? "oklch(0.221 0.048 151.7)" : "#fff",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.2)"
  });

  var ICONS = ${JSON.stringify(WIDGET_ICONS)};
  // A built-in icon (the chat bubble for any other name), drawn in the button's text colour; or the team's image.
  function newIcon(name, url) {
    var element;
    if (url) {
      element = document.createElement("img");
      element.src = url;
      element.alt = "";
      css(element, { width: "28px", height: "28px", objectFit: "contain" });
      return element;
    }
    var svg = "http://www.w3.org/2000/svg";
    var attributes = {
      viewBox: "0 0 24 24", width: "28", height: "28", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"
    };
    element = document.createElementNS(svg, "svg");
    for (var key in attributes) element.setAttribute(key, attributes[key]);
    var paths = ICONS.hasOwnProperty(name) ? ICONS[name] : ICONS.chat;
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(svg, "path");
      path.setAttribute("d", paths[i]);
      element.appendChild(path);
    }
    return element;
  }
  var icon = button.appendChild(newIcon("chat"));

  // "New" dot, for an announcement this browser hasn't seen.
  var dot = document.createElement("span");
  css(dot, {
    position: "absolute", top: "0", right: "0", width: "12px", height: "12px", borderRadius: "999px",
    background: "oklch(0.705 0.187 47.6)", border: "2px solid #fff", display: "none"
  });
  button.appendChild(dot);
  function storage(fn) {
    try { return fn(window.localStorage); } catch (error) { return null; }
  }

  // The unseen status, for the dot and for the page (Tuti.unseen, Tuti.on("unseen")): whether the
  // latest announcement is newer than what this visitor has seen, or the team wrote to them (Messages).
  var unseen = false;
  var unseenMessages = 0;
  // Counts from the open panel, which knows best: a server answer asked for before the latest of them is old.
  var panelCounts = 0;
  var countReads = 0;
  // The project's support inbox is on: the team may have written to whoever the page signs in.
  var inbox = false;
  var known = false;
  var latest = null;
  var seen = null;
  var listeners = [];
  function isUnseen() {
    return !!latest && (!seen || latest > seen);
  }
  function anyUnseen() {
    return isUnseen() || unseenMessages > 0;
  }
  // Seen up to \`at\` (ISO times compare as strings): kept if it's later than what this browser had.
  function remember(at) {
    if (seen && seen >= at) return;
    seen = at;
    storage(function (s) { if (!(s.getItem(seenKey) >= at)) s.setItem(seenKey, at); });
  }
  function notify(callback) {
    try { callback(unseen); } catch (error) { console.error("Tuti widget: unseen callback failed", error); }
  }
  function setUnseen(value) {
    var changed = !known || value !== unseen;
    known = true;
    unseen = value;
    dot.style.display = value ? "block" : "none";
    button.setAttribute("aria-label", label + (value ? ", new updates" : ""));
    if (changed) for (var i = 0; i < listeners.length; i++) notify(listeners[i]);
  }

  var panel = document.createElement("div");
  panel.id = "tuti-widget";
  css(panel, {
    position: "fixed", zIndex: "2147483000", display: "none", overflow: "hidden", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
    background: dark ? "oklch(0.185 0.01 158.9)" : "oklch(0.994 0.007 88.6)"
  });
  // On a phone the panel covers the page and its button: until its page says it's up with its own Close
  // (WidgetClose), the loader's own, so a page that doesn't come (offline, an error) can still be closed.
  var closable = false;
  var standIn = document.createElement("button");
  standIn.type = "button";
  standIn.setAttribute("aria-label", "Close");
  css(standIn, {
    position: "absolute", top: "calc(env(safe-area-inset-top) + 8px)", right: "8px", zIndex: "1", width: "36px", height: "36px",
    padding: "0", border: "0", borderRadius: "999px", cursor: "pointer", display: "none", alignItems: "center", justifyContent: "center",
    background: "rgba(0, 0, 0, 0.55)", color: "#fff"
  });
  var cross = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  var crossAttributes = { viewBox: "0 0 24 24", width: "20", height: "20", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" };
  for (var attribute in crossAttributes) cross.setAttribute(attribute, crossAttributes[attribute]);
  var crossPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  crossPath.setAttribute("d", "M18 6 6 18M6 6l12 12");
  cross.appendChild(crossPath);
  standIn.appendChild(cross);
  standIn.addEventListener("click", function () { close(); });
  panel.appendChild(standIn);
  function showStandIn() {
    standIn.style.display = small && small.matches && !closable ? "flex" : "none";
  }
  // On a phone the open panel is the whole screen: the page under it is out of reach (Tab, a screen reader's
  // swipes) until it closes or the screen's wide again, what it adds meanwhile too (the button, once it's
  // set up). Only what the loader made inert is put back.
  var covered = [];
  // A modal the page has open (help opened from inside it) is the page's: covered, it would freeze with
  // nothing in reach to close it, so the page is left as it is then.
  function modalOpen() {
    var marked = document.querySelectorAll("[aria-modal]");
    for (var m = 0; m < marked.length; m++) if (marked[m].getAttribute("aria-modal") === "true") return true;
    try {
      return !!document.querySelector("dialog:modal");
    } catch (error) {
      return false;
    }
  }
  function coverPage() {
    var cover = opened && small && small.matches && !modalOpen();
    if (cover) {
      var children = document.body ? document.body.children : [];
      for (var c = 0; c < children.length; c++) {
        var child = children[c];
        if (child !== panel && child !== backdrop && !child.hasAttribute("inert")) {
          child.setAttribute("inert", "");
          covered.push(child);
        }
      }
    } else {
      for (var u = 0; u < covered.length; u++) covered[u].removeAttribute("inert");
      covered = [];
    }
  }
  // The sidebar: a drawer over the button, with a backdrop that closes it on narrow screens
  // (where it covers most of the page); on wider ones the page stays usable beside it.
  var backdrop = document.createElement("div");
  // A phone's width: the sidebar gets a backdrop, the floating panel the whole screen.
  var small = window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;
  var narrow = sidebar ? small : null;
  // Whether the panel is open: it stays on screen a moment after closing, as it animates away.
  var opened = false;
  // The button's side: bottom-right unless the project says bottom-left.
  var onLeft = false;
  function showBackdrop() {
    backdrop.style.display = narrow && narrow.matches && opened ? "block" : "none";
  }
  if (sidebar) {
    css(panel, { right: "0", top: "0", bottom: "0", zIndex: "2147483001", width: "min(400px, 100vw)" });
    css(backdrop, { position: "fixed", top: "0", right: "0", bottom: "0", left: "0", zIndex: "2147483001", display: "none", background: "rgba(0, 0, 0, 0.4)" });
    backdrop.addEventListener("click", function () { close(); });
    if (narrow) narrow.onchange = function () { showBackdrop(); showStandIn(); coverPage(); };
  } else {
    placePanel();
    if (small) small.onchange = placePanel;
  }
  // The floating panel: above the button, or on a phone the whole screen (over the button, its own close
  // button at the top). Pinned to the screen's edges there, so the browser's bars can't push it off screen.
  function placePanel() {
    showStandIn();
    coverPage();
    if (small && small.matches) {
      // Clear of the status bar and home indicator where the page runs under them (viewport-fit=cover):
      // the panel's page, in a frame, isn't told where they are.
      css(panel, {
        top: "0", right: "0", bottom: "0", left: "0", width: "auto", height: "auto", borderRadius: "0", zIndex: "2147483001", boxSizing: "border-box",
        paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)"
      });
      return;
    }
    css(panel, {
      paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
      top: "auto", bottom: hideLauncher ? "20px" : "88px", right: onLeft ? "auto" : "20px", left: onLeft ? "20px" : "auto",
      borderRadius: "14px", zIndex: "2147483000", width: "min(400px, calc(100vw - 40px))", height: "min(600px, calc(100vh - 112px))",
      transformOrigin: onLeft ? "bottom left" : "bottom right"
    });
    // The screen's height without the browser's bars, where it's known (iOS counts them in 100vh).
    panel.style.height = "min(600px, calc(100dvh - 112px))";
  }
  // Opening, the panel grows out of the launcher's corner (a sidebar slides in from its edge); closing, the
  // reverse, then it's hidden. Not for visitors who ask for less motion (as they do now), nor where browsers
  // can't animate. Closing, it's inert at once: nothing in it can be clicked or focused on its way out.
  var lessMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var motion = null;
  function animate(showing) {
    if (showing) panel.removeAttribute("inert"); else panel.setAttribute("inert", "");
    if (!panel.animate || (lessMotion && lessMotion.matches)) {
      if (motion) motion.cancel();
      motion = null;
      if (!showing) panel.style.display = "none";
      return;
    }
    // Turned around halfway: back from where it is, not from the other end.
    if (motion) {
      motion.reverse();
      return;
    }
    var away = sidebar
      ? { transform: "translateX(" + (onLeft ? "-" : "") + "100%)" }
      : small && small.matches
        ? { opacity: 0, transform: "translateY(24px)" }
        : { opacity: 0, transform: "translateY(16px) scale(0.94)" };
    var here = sidebar ? { transform: "none" } : { opacity: 1, transform: "none" };
    motion = panel.animate(showing ? [away, here] : [here, away], showing
      ? { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
      : { duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)" });
    motion.onfinish = function () {
      motion = null;
      if (!opened) panel.style.display = "none";
    };
  }
  whenBody(function () {
    if (sidebar) document.body.appendChild(backdrop);
    document.body.appendChild(panel);
  });


  // The button, unless the page has its own: once the settings are read, or after 3 seconds
  // without them (in their place, or styled when they come).
  var shown = false;
  function showLauncher() {
    if (shown || hideLauncher) return;
    shown = true;
    whenBody(function () { document.body.appendChild(button); });
  }
  setTimeout(showLauncher, 3000);
  function setUp(launcher) {
    if (launcher) {
      if (typeof launcher.label === "string" && launcher.label) {
        label = launcher.label;
        button.title = label;
        button.setAttribute("aria-label", label);
        // The panels are named after the button that opens them, ones already on the page too.
        if (frame) frame.title = label;
        var mounted = document.querySelectorAll("[data-tuti-inline]");
        for (var m = 0; m < mounted.length; m++) if (mounted[m].__tutiFrame) mounted[m].__tutiFrame.title = label;
      }
      if (typeof launcher.icon === "string") {
        var next = newIcon(launcher.icon, launcher.icon === "image" && typeof launcher.iconUrl === "string" ? launcher.iconUrl : null);
        button.replaceChild(next, icon);
        icon = next;
        // An image that doesn't load (deleted, offline): the chat bubble, not an empty button.
        next.onerror = function () {
          if (icon !== next) return;
          icon = newIcon("chat", null);
          button.replaceChild(icon, next);
        };
      }
      if (typeof launcher.color === "string") css(button, { background: launcher.color, color: launcher.textColor });
      if (launcher.position === "bottom-left") {
        css(button, { left: "20px", right: "auto" });
        onLeft = true;
        if (sidebar) css(panel, { left: "0", right: "auto", transformOrigin: "bottom left" });
        else placePanel();
      }
    }
    showLauncher();
  }
  (window.fetch ? fetch(api + "/api/widget/latest?project=" + encodeURIComponent(slug))
    .then(function (response) { return response.ok ? response.json() : null; })
    .catch(function () { return null; }) : Promise.resolve(null))
    .then(function (data) {
      latest = data && typeof data.latest === "string" ? data.latest : null;
      inbox = !!(data && data.inbox === true);
      setUp(data && data.launcher);
      var stored = storage(function (s) { return s.getItem(seenKey); });
      if (stored) remember(stored);
      if (isUnseen() || (inbox && getToken)) checkElsewhere(); else setUnseen(false);
    });

  // People the page signs in (Tuti.identify): up to when they've seen announcements on any
  // device, or with \`at\`, that they've now seen them up to \`at\` too. A fresh token each time,
  // sent to Tuti's API only; null without one, or if it fails.
  function seenOnServer(at) {
    if (!getToken || !window.fetch) return Promise.resolve(null);
    var asked = panelCounts;
    // The latest status read only: an older answer that arrives after it is old too.
    var read = at ? countReads : ++countReads;
    return Promise.resolve()
      .then(function () { return getToken(); })
      .then(function (token) {
        if (typeof token !== "string" || !token) {
          // Nobody's signed in now: the team's messages to whoever was aren't theirs.
          if (!at && asked === panelCounts && read === countReads) unseenMessages = 0;
          return null;
        }
        return fetch(api + "/api/widget/seen?project=" + encodeURIComponent(slug), at
          ? { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ at: at }) }
          : { headers: { authorization: "Bearer " + token } })
          .then(function (response) { return response.ok ? response.json() : null; });
      })
      .then(function (data) {
        if (data && typeof data.messages === "number" && asked === panelCounts && read === countReads) unseenMessages = data.messages;
        return data && typeof data.seen === "string" ? data.seen : null;
      })
      .catch(function () { return null; });
  }
  // Unseen in this browser: maybe they've seen it on another device; and the team's messages to them.
  function checkElsewhere() {
    return seenOnServer().then(function (at) {
      if (at) remember(at);
      setUnseen(anyUnseen());
    });
  }

  var TABS = { home: "", messages: "?tab=messages", docs: "?tab=docs", feedback: "?tab=feedback", "whats-new": "?tab=whats-new" };
  function tabQuery(tab) {
    if (tab && !TABS.hasOwnProperty(tab)) console.error("Tuti widget: tab is one of home, messages, docs, feedback or whats-new");
    return TABS.hasOwnProperty(tab) ? TABS[tab] : null;
  }
  function newFrame(src) {
    var element = document.createElement("iframe");
    element.src = src;
    element.title = label;
    css(element, { width: "100%", height: "100%", border: "0", display: "block" });
    return element;
  }
  var frame;
  var returnFocus;

  // Opens the panel, at a tab or a docs article if asked (otherwise where it was);
  // closing it gives focus back to \`from\`.
  function open(options, from) {
    var article = options && typeof options.article === "string" ? options.article : "";
    var query = article ? "?tab=docs&article=" + encodeURIComponent(article) : tabQuery(options && options.tab);
    var src = portal + "/widget" + (query || "");
    // A page loading in it: until it says it can close itself, the loader's Close is there (on a phone).
    if (!frame) {
      closable = false;
      frame = panel.appendChild(newFrame(src));
    } else if (query !== null) {
      closable = false;
      frame.src = src;
    }
    showStandIn();
    if (!opened) {
      returnFocus = from;
      opened = true;
      panel.style.display = "block";
      animate(true);
    }
    tellShown(true);
    showBackdrop();
    coverPage();
    button.setAttribute("aria-expanded", "true");
    frame.focus();
  }

  // The floating panel, whether it's on screen: only then does it count the team's replies as seen.
  function tellShown(shown) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: ${JSON.stringify(WIDGET_SHOWN_MESSAGE)}, shown: shown }, origin);
  }

  function close() {
    if (!opened) return;
    opened = false;
    animate(false);
    tellShown(false);
    showBackdrop();
    // Back in reach before focus goes back to it.
    coverPage();
    button.setAttribute("aria-expanded", "false");
    (returnFocus && returnFocus.focus && document.contains(returnFocus) ? returnFocus : button).focus();
  }

  button.addEventListener("click", function () {
    if (!opened) open(null, button); else close();
  });
  // Contextual help: any element with data-tuti-article, now or added later.
  document.addEventListener("click", function (event) {
    // Modified clicks (new tab, new window, download) and ones the page already handled stay the page's.
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var target = event.target;
    var element = target && target.closest ? target.closest("[data-tuti-article]") : null;
    if (!element) return;
    event.preventDefault();
    open({ article: element.getAttribute("data-tuti-article") }, element);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") close();
  });

  // Inline: the panel in each of the page's data-tuti-inline elements, at the tab it names, also in
  // ones added later (single-page apps). display=inline, and the iframe's name (which stays with
  // it as it navigates), tell the panel there's nothing to close.
  function mountInline() {
    var elements = document.querySelectorAll("[data-tuti-inline]");
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].__tutiFrame) continue;
      var query = tabQuery(elements[i].getAttribute("data-tuti-inline"));
      var inline = newFrame(portal + "/widget" + (query ? query + "&" : "?") + "display=inline");
      inline.name = ${JSON.stringify(WIDGET_INLINE_NAME)};
      inline.style.minHeight = "500px";
      elements[i].__tutiFrame = elements[i].appendChild(inline);
    }
  }
  // The panel whose window sent a message: the floating one, or that of a mount in the page now
  // (read from the page each time, so a removed mount is forgotten and one put back counts again).
  function frameOf(source) {
    if (frame && frame.contentWindow === source) return frame;
    var elements = document.querySelectorAll("[data-tuti-inline]");
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].__tutiFrame && elements[i].__tutiFrame.contentWindow === source) return elements[i].__tutiFrame;
    }
    return null;
  }
  whenBody(function () {
    mountInline();
    if (window.MutationObserver) {
      new window.MutationObserver(function () {
        mountInline();
        coverPage();
      }).observe(document.body, { childList: true, subtree: true });
    }
  });
  var getToken = typeof settings.identify === "function" ? settings.identify : null;
  window.Tuti = {
    identify: function (fn) {
      if (typeof fn !== "function") {
        console.error("Tuti widget: Tuti.identify takes a function that returns a sign-in token");
        return;
      }
      getToken = fn;
      // Read before it's reset below: a count from a panel means the team writes to people here, even
      // if the inbox flag the script read is from before it was turned on.
      var check = unseen || inbox;
      // Someone else, maybe: the team's messages counted so far were to whoever was before (counts
      // already on their way are too, so they're old now). Their own count comes from the server or a panel.
      unseenMessages = 0;
      panelCounts++;
      if (known) setUnseen(anyUnseen());
      // Panels already on the page trade the new person's token for their own (a panel kept the one it
      // had, the previous person's, until it reloads).
      if (frame) sendToken(frame);
      var mounts = document.querySelectorAll("[data-tuti-inline]");
      for (var i = 0; i < mounts.length; i++) {
        if (mounts[i].__tutiFrame) sendToken(mounts[i].__tutiFrame);
      }
      // Signed in after the status was worked out: they may have seen it elsewhere, and the team may have written.
      if (check) checkElsewhere();
    },
    open: function (options) {
      open(options, document.activeElement);
    },
    close: close,
    unseen: function () {
      return unseen;
    },
    on: function (name, callback) {
      if (name !== "unseen" || typeof callback !== "function") {
        console.error("Tuti widget: Tuti.on takes \\"unseen\\" and a function");
        return;
      }
      listeners.push(callback);
      if (known) notify(callback);
    }
  };

  // Hands a panel a fresh sign-in token, only ever to the portal's origin. Only the newest it asked
  // for: an older one the app answers later may be for someone signed in before.
  // With nobody signed in (no identify, or it gives no token), it says so: token null, so the panel
  // knows not to wait for one before someone writes as a visitor.
  function sendToken(to) {
    var target = to.contentWindow;
    var tell = function (token) { target.postMessage({ type: ${JSON.stringify(WIDGET_IDENTIFY_MESSAGE)}, token: token }, origin); };
    if (!getToken) return tell(null);
    var asked = (to.__tutiAsked = (to.__tutiAsked || 0) + 1);
    Promise.resolve()
      .then(function () { return getToken(); })
      .then(
        function (token) {
          if (asked !== to.__tutiAsked) return;
          tell(typeof token === "string" && token ? token : null);
        },
        function (error) {
          console.error("Tuti widget: identify failed", error);
          if (asked === to.__tutiAsked) tell(null);
        }
      );
  }

  // From a panel (another origin): close (the close button, Escape), ready-for-a-token and seen.
  window.addEventListener("message", function (event) {
    if (!event.source || event.origin !== origin) return;
    var from = frameOf(event.source);
    if (!from) return;
    // Only the floating panel closes; an inline one has nothing to close.
    if (event.data === ${JSON.stringify(WIDGET_CLOSE_MESSAGE)}) { if (from === frame) close(); }
    else if (event.data === ${JSON.stringify(WIDGET_CLOSABLE_MESSAGE)} || (event.data && event.data.type === ${JSON.stringify(WIDGET_CLOSABLE_MESSAGE)})) {
      if (from === frame) {
        // Up with its own Close, or going away (the next page may not have one).
        closable = event.data === ${JSON.stringify(WIDGET_CLOSABLE_MESSAGE)};
        showStandIn();
      }
    }
    else if (event.data && event.data.type === ${JSON.stringify(WIDGET_READY_MESSAGE)}) {
      sendToken(from);
      // Closed while it loaded: it couldn't hear that then.
      if (from === frame) tellShown(opened);
    }
    else if (event.data && event.data.type === ${JSON.stringify(WIDGET_SEEN_MESSAGE)} && typeof event.data.at === "string") {
      remember(event.data.at);
      seenOnServer(event.data.at);
      // The panel may have been rendered before a newer announcement than the one it showed.
      setUnseen(anyUnseen());
    }
    else if (event.data && event.data.type === ${JSON.stringify(WIDGET_UNSEEN_MESSAGES)} && typeof event.data.count === "number") {
      unseenMessages = event.data.count;
      panelCounts++;
      setUnseen(anyUnseen());
    }
  });
})();
`;
}
