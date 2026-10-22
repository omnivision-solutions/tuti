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
        if (node instanceof HTMLScriptElement) {
          const script = await run(node, (made) => document.body.append(made));
          added.push(script);
          continue;
        }
        // Scripts inside other elements: each taken out for a placeholder, then put back in order, like the rest.
        const places =
          node instanceof Element
            ? [...node.querySelectorAll("script")].map((inner) => {
                const place = document.createComment("");
                inner.replaceWith(place);
                return { inner, place };
              })
            : [];
        document.body.append(node);
        added.push(node);
        for (const { inner, place } of places) {
          if (gone) {
            return;
          }
          await run(inner, (made) => place.replaceWith(made));
        }
      }
    })();
    return () => {
      gone = true;
      added.forEach((node) => node.remove());
    };
  }, [html, origin]);
  return null;
}

/** The longest the rest of the team's HTML waits for one of its scripts. */
const SCRIPT_WAIT_MS = 10_000;

/** JavaScript's types: a script of another type (or nomodule, in a browser that has modules) isn't run, so isn't waited for. */
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "application/x-javascript"]);

function runs(script: HTMLScriptElement): boolean {
  return !script.hasAttribute("nomodule") && JS_TYPES.has((script.getAttribute("type") ?? "").trim().toLowerCase());
}

/**
 * Adds a script that runs, made like `script`, with `add`; done once it has run when it's external and
 * the browser runs it (unless marked async or defer, which don't hold up what follows), or after
 * SCRIPT_WAIT_MS.
 */
async function run(script: HTMLScriptElement, add: (made: HTMLScriptElement) => void): Promise<HTMLScriptElement> {
  const made = fresh(script);
  const waits = made.src && runs(script) && !script.hasAttribute("async") && !script.hasAttribute("defer");
  // Made by script, external scripts are async unless told otherwise.
  made.async = !waits && made.async;
  const loaded = waits
    ? new Promise<void>((done) => {
        made.addEventListener("load", () => done());
        made.addEventListener("error", () => done());
        setTimeout(done, SCRIPT_WAIT_MS);
      })
    : null;
  add(made);
  await loaded;
  return made;
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
