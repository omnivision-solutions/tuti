"use client";

import { useEffect, useRef } from "react";

import { copyText } from "@/components/copy-button";

const COPY_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/**
 * "Copy" on each code block of the article before it (rendered on the server, so the buttons are added once its script
 * runs): in a labelled block's strip, else at the block's top right. Without JavaScript there's nothing to copy with.
 */
export function CodeCopyButtons() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const article = marker.current?.previousElementSibling;
    if (!article) {
      return;
    }
    // ponytail: buttons added to server-rendered blocks React never re-renders; a RichText option if that changes. In an
    // unlabelled block the button scrolls with a long line; a wrapper around the <pre> would keep it put.
    const buttons = [...article.querySelectorAll<HTMLPreElement>("pre")].map((pre) => {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      button.setAttribute("aria-label", "Copy code");
      button.className =
        "inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2 font-sans text-[0.8125rem] font-semibold text-muted-foreground transition-colors hover:text-foreground";
      // The code alone (not this button's word, inside an unlabelled block).
      const code = pre.querySelector("code") ?? pre;
      button.addEventListener("click", () => copyText(code.innerText));
      const caption = pre.parentElement?.matches(".rich-code") ? pre.parentElement.querySelector("figcaption") : null;
      if (caption) {
        caption.append(button);
      } else {
        button.classList.add("absolute", "top-2.5", "right-2.5");
        pre.append(button);
      }
      return button;
    });
    return () => buttons.forEach((button) => button.remove());
  }, []);
  return <span ref={marker} hidden />;
}
