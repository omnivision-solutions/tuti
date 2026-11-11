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
  ["記事を公開", "設定から<strong>記事を公開</strong>できます。"],
  ["𠮷野", "𠮷<strong>𠮷野</strong>家。"],
  ["发布文章", "您可以在设置中<strong>发布文章</strong>并查看。"],
  ["เผยแพร่บทความ", "คุณสามารถ<strong>เผยแพร่บทความ</strong>จากการตั้งค่า"],
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

it.each([
  ["Published記事", "Unpublished記事"],
  ["席数5", "席数50"],
])("keeps Latin and numeric boundaries in mixed-script quotes: %s", (source, other) => {
  document.querySelector<HTMLElement>("[contenteditable]")!.innerHTML = `<p>${other}</p>`;
  const notice = vi.spyOn(toast, "info");
  focusArticleSentence(source);
  expect(notice).toHaveBeenCalledWith("Couldn't find this sentence in the text");
});

it.each([
  ["公開の記事は", "非公開の記事は。", "公開の記事は"],
  ["公開 の記事は", "非公開の記事は。", "公開の記事は"],
  ["公開の記事は", "非公開の記事は。", "詳しくは「公開の記事は」をご覧ください。"],
  ["发布的文章", "未发布的文章。", "参照 发布的文章 一覧"],
])("prefers a quote with clear boundaries over an earlier prefixed clause: %s", (source, other, text) => {
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML = `<p>${other}</p><p>${text}</p>`;
  const target = editor.querySelectorAll("p")[1]!;
  const scroll = vi.spyOn(target, "scrollIntoView");
  focusArticleSentence(source);
  expect(scroll).toHaveBeenCalled();
  expect(window.getSelection()?.anchorNode).toBe(target);
});

it("keeps hard-break boundaries when jumping past an earlier prefixed clause", () => {
  const editor = document.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML = "<p>非公開の記事は。</p><p>見出し<br>公開の記事は</p>";
  const target = editor.querySelectorAll("p")[1]!;
  const scroll = vi.spyOn(target, "scrollIntoView");
  focusArticleSentence("公開の記事は");
  expect(scroll).toHaveBeenCalled();
  expect(window.getSelection()?.anchorNode).toBe(target);
});
