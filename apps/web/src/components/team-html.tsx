"use client";

import { useEffect } from "react";

/**
 * The team's own HTML (Customize → Custom code), scripts too, added to the end of the page once it's
 * loaded, and only if the page's real origin is `origin`: the team's domain or site. The server can't
 * tell a request that came through the team's site from one straight to the portal's Tuti host (the
 * site forwards with that host), but the browser knows where the page is: on a Tuti origin, a script
 * could pass for Tuti.
 *
 * Scripts are made anew (HTML put in a page doesn't run its scripts) and run in order, as in a page of
 * their own: an external one is waited for before what comes after it, unless it's marked async.
 */
export function TeamHtml({ html, origin }: { html: string; origin: string }) {
  useEffect(() => {
    if (window.location.origin !== origin) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    const added: ChildNode[] = [];
    let gone = false;
    void (async () => {
      for (const node of [...template.content.childNodes]) {
        if (gone) {
          return;
        }
        if (!(node instanceof HTMLScriptElement)) {
          // Scripts inside other elements run too, when the element is added.
          if (node instanceof Element) {
            for (const inner of node.querySelectorAll("script")) {
              inner.replaceWith(fresh(inner));
            }
          }
          document.body.append(node);
          added.push(node);
          continue;
        }
        const script = fresh(node);
        const waits = script.src && !node.hasAttribute("async") && !node.hasAttribute("defer");
        // Made by script, external scripts are async unless told otherwise.
        script.async = !waits && script.async;
        const loaded = waits
          ? new Promise<void>((done) => {
              script.addEventListener("load", () => done());
              script.addEventListener("error", () => done());
            })
          : null;
        document.body.append(script);
        added.push(script);
        await loaded;
      }
    })();
    return () => {
      gone = true;
      added.forEach((node) => node.remove());
    };
  }, [html, origin]);
  return null;
}

/** A script that runs when it's added, like `script`. */
function fresh(script: HTMLScriptElement): HTMLScriptElement {
  const made = document.createElement("script");
  for (const { name, value } of script.attributes) {
    made.setAttribute(name, value);
  }
  made.text = script.text;
  return made;
}
