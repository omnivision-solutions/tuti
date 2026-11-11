// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { focusArticleSentence } from "./article-sentence-jump";
import { toast } from "sonner";

beforeEach(() => {
  document.body.innerHTML = '<form id="article-form"><div contenteditable="true" tabindex="0"></div></form>';
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

it.each([
  ["Each plan has 5 seats.", "Each plan has <strong>5 seats.</strong> You can add up to 10 more from Billing."],
  ["People are admins or members.", "People are admins or members. Pick one role."],
  ["Pick one role.", "Pick <strong>one</strong> ro\u200Ble. Invite up to 10 people."],
])("focuses the block containing the quoted source: %s", (source, html) => {
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML = `<p><span data-finding="1">1</span>${html}</p><p>Another paragraph.</p>`;
  const target = editor.querySelector("p")!;
  const scroll = vi.spyOn(target, "scrollIntoView");
  focusArticleSentence(source);
  expect(scroll).toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
  expect(window.getSelection()?.anchorNode).toBe(target);
});

it.each([
  ["Published articles are visible.", "Unpublished articles are visible."],
  ["Seat limit: 5", "Seat limit: 50"],
])("jumps to whole words and quantities for %s", (source, other) => {
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML = `<p>${other}</p><p>${source}</p>`;
  const target = editor.querySelectorAll("p")[1]!;
  const scroll = vi.spyOn(target, "scrollIntoView");
  focusArticleSentence(source);
  expect(scroll).toHaveBeenCalled();
  expect(window.getSelection()?.anchorNode).toBe(target);
});

it.each([
  ["Published articles are visible.", "Unpublished articles are visible."],
  ["Seat limit: 5", "Seat limit: 50"],
])("does not jump inside a different word or number for %s", (source, other) => {
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML = `<p>${other}</p>`;
  const notice = vi.spyOn(toast, "info");
  focusArticleSentence(source);
  expect(notice).toHaveBeenCalledWith("Couldn't find this sentence in the text");
  expect(document.activeElement).not.toBe(editor);
});
