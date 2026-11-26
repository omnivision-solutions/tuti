import { expect, test } from "vitest";

import { previewAfter, previewToShow, type ReplyPreview, wantsPreview } from "./reply-preview";

test("a failed text isn't asked again while its failure shows; edited away and back, it is", () => {
  const failed: ReplyPreview = { for: "Thanks!", failed: "The translation provider didn't answer" };
  expect(previewToShow(failed, "Thanks!", "de")).toBe(failed);
  expect(wantsPreview(previewToShow(failed, "Thanks!", "de"), "Thanks!")).toBe(false);
  // Edited: the failure is another text's, so this one's preview is asked for.
  expect(wantsPreview(previewToShow(failed, "Thanks a lot!", "de"), "Thanks a lot!")).toBe(true);
  // Back again, with the preview now the edited text's: asked for again.
  const edited: ReplyPreview = { for: "Thanks a lot!", text: "Vielen Dank!", language: "de" };
  expect(wantsPreview(previewToShow(edited, "Thanks!", "de"), "Thanks!")).toBe(true);
  // Reset (an outdated send): asked for again.
  expect(wantsPreview(previewToShow(undefined, "Thanks!", "de"), "Thanks!")).toBe(true);
});

test("nothing is asked while the reply is being sent: a preview started before Send doesn't pay again or overwrite its outcome", () => {
  expect(wantsPreview(undefined, "Thanks!", true)).toBe(false);
  expect(wantsPreview(undefined, "Thanks!", false)).toBe(true);
});

test("a preview in a language that's no longer the customer's isn't shown, and nothing is asked without text", () => {
  expect(previewToShow({ for: "Thanks!", text: "Danke!", language: "de" }, "Thanks!", "fr")).toBeUndefined();
  expect(wantsPreview(undefined, undefined)).toBe(false);
  expect(wantsPreview(undefined, "")).toBe(false);
});

test("a late preview failure in place of a failed Send and close keeps the close; anything else replaces it as it is", () => {
  const sent: ReplyPreview = { for: "Thanks!", failed: "The translation provider didn't answer", close: true };
  const late: ReplyPreview = { for: "Thanks!", failed: "The translation failed its checks" };
  expect(previewAfter(sent, late)).toEqual({ ...late, close: true });
  expect(previewAfter(sent, { for: "Thanks a lot!", failed: "No" })).toEqual({ for: "Thanks a lot!", failed: "No" });
  expect(previewAfter(sent, { for: "Thanks!", text: "Danke!", language: "de" })).toEqual({ for: "Thanks!", text: "Danke!", language: "de" });
  expect(previewAfter(undefined, late)).toBe(late);
});

test("a failure in a language that's no longer the customer's isn't shown, so the new language's preview is asked for", () => {
  const failed: ReplyPreview = { for: "Thanks!", failed: "The translation provider didn't answer", language: "de" };
  expect(previewToShow(failed, "Thanks!", "de")).toBe(failed);
  expect(previewToShow(failed, "Thanks!", "fr")).toBeUndefined();
  expect(wantsPreview(previewToShow(failed, "Thanks!", "fr"), "Thanks!")).toBe(true);
  // A send refused before the page knew the language: shown, whatever it turns out to be.
  const unknown: ReplyPreview = { for: "Thanks!", failed: "No" };
  expect(previewToShow(unknown, "Thanks!", "fr")).toBe(unknown);
});

test("a preview shown for the text isn't asked for again when a send of something else ends (a note, a refused send)", () => {
  for (const shown of [
    { for: "Thanks!", text: "Danke!", language: "de" },
    { for: "Thanks!", asWritten: true },
    { for: "Thanks!", failed: "No", language: "de" },
  ] satisfies ReplyPreview[]) {
    // Sending, then not: the pending flag toggling doesn't ask again.
    expect(wantsPreview(previewToShow(shown, "Thanks!", "de"), "Thanks!", true)).toBe(false);
    expect(wantsPreview(previewToShow(shown, "Thanks!", "de"), "Thanks!", false)).toBe(false);
  }
});
