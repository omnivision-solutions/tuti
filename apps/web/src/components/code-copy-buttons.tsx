"use client";

import { useEffect, useRef } from "react";

import { copyText } from "@/components/copy-button";

const COPY_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/**
 * "Copy" on each code block of the article before it (rendered on the server, so the buttons are added once its script
 * runs), in a strip above the code so it never covers it: a labelled block's label strip, beside code tabs (copying the
 * tab shown), else a strip of its own (`.code-copy-bar`). Without JavaScript there's nothing to copy with.
 */
export function CodeCopyButtons() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const article = marker.current?.previousElementSibling;
    if (!article) {
      return;
    }
    // Copies `pre`'s code alone (not the word of a button in its strip).
    const copyButton = (pre: () => Element) => {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      button.setAttribute("aria-label", "Copy code");
      button.className =
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 font-sans portal:border-transparent portal:bg-secondary portal:hover:bg-secondary-hover text-[0.8125rem] font-semibold text-muted-foreground transition-colors hover:text-foreground";
      button.addEventListener("click", () => {
        const block = pre();
        void copyText((block.querySelector("code") ?? (block as HTMLElement)).innerText);
      });
      return button;
    };
    const bar = (button: HTMLButtonElement) => {
      const element = document.createElement("div");
      element.className = "code-copy-bar";
      element.append(button);
      return element;
    };
    // ponytail: added to server-rendered blocks React never re-renders; a RichText option if that changes.
    const added: Element[] = [];
    for (const tabs of article.querySelectorAll(".rich-code-tabs")) {
      const shown = () => {
        const radios = [...tabs.querySelectorAll<HTMLInputElement>(":scope > .rich-code-tab-row input")];
        return tabs.querySelectorAll(":scope > pre")[Math.max(radios.findIndex((radio) => radio.checked), 0)]!;
      };
      // Right after the tabs (where it's shown), so keyboards and screen readers reach it before the code.
      added.push(bar(copyButton(shown)));
      tabs.querySelector(":scope > .rich-code-tab-row")?.after(added.at(-1)!);
    }
    for (const pre of article.querySelectorAll<HTMLPreElement>("pre:not(.rich-code-tabs > pre)")) {
      const caption = pre.parentElement?.matches(".rich-code") ? pre.parentElement.querySelector("figcaption") : null;
      if (caption) {
        added.push(copyButton(() => pre));
        caption.append(added.at(-1)!);
      } else {
        added.push(bar(copyButton(() => pre)));
        pre.prepend(added.at(-1)!);
      }
    }
    return () => added.forEach((element) => element.remove());
  }, []);
  return <span ref={marker} hidden />;
}
