"use client";

import { ArrowLeftIcon } from "lucide-react";
import { toast } from "sonner";

export const ARTICLE_SENTENCE_JUMP = "docs:jump-to-sentence";

/** A checked sentence may no longer be in the latest editor text. */
export function focusArticleSentence(sentence: string) {
  const editor = document.querySelector<HTMLElement>('#article-form [contenteditable="true"]');
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  const normalized = normalize(sentence);
  const target =
    normalized &&
    [...(editor?.querySelectorAll<HTMLElement>("p, li, h2, h3") ?? [])].find((block) => normalize(block.textContent ?? "").includes(normalized));
  if (!target || !editor) {
    toast.info("This sentence has changed in the editor.");
    return;
  }
  target.scrollIntoView({ block: "center", behavior: "instant" });
  editor.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

export function ArticleSentenceJump({ sentence }: { sentence: string }) {
  return (
    <button
      type="button"
      className="docs-sentence-jump"
      onClick={() => {
        // The phone tools sheet defers focus until it has closed and released its focus trap.
        if (window.dispatchEvent(new CustomEvent(ARTICLE_SENTENCE_JUMP, { detail: sentence, cancelable: true }))) focusArticleSentence(sentence);
      }}
    >
      Jump to sentence <ArrowLeftIcon className="size-3" />
    </button>
  );
}
