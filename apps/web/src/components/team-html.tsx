"use client";

import { useEffect } from "react";

/**
 * The team's own HTML (Customize → Custom code), scripts too, added to the end of the page once it's
 * loaded, and only if the page's real origin is `origin`: the team's domain or site. The server can't
 * tell a request that came through the team's site from one straight to the portal's Tuti host (the
 * site forwards with that host), but the browser knows where the page is: on a Tuti origin, a script
 * could pass for Tuti. Scripts are made anew, as HTML put in a page doesn't run its scripts.
 */
export function TeamHtml({ html, origin }: { html: string; origin: string }) {
  useEffect(() => {
    if (window.location.origin !== origin) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const old of template.content.querySelectorAll("script")) {
      const script = document.createElement("script");
      for (const { name, value } of old.attributes) {
        script.setAttribute(name, value);
      }
      script.text = old.text;
      old.replaceWith(script);
    }
    const added = [...template.content.childNodes];
    document.body.append(...added);
    return () => added.forEach((node) => node.remove());
  }, [html, origin]);
  return null;
}
