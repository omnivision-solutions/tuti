import { expect, test } from "vitest";

import { previewAfter, previewToShow, type ReplyPreview, wantsPreview, withoutAdvice } from "./reply-preview";

test("a failed text isn't asked again while its failure shows; edited away and back, it is", () => {
  const failed: ReplyPreview = { for: "Thanks!", failed: "The translation provider didn't answer", language: "de" };
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

test("a failure of no known language is shown until the customer's language is known, then asked for again", () => {
  const unknown: ReplyPreview = { for: "Thanks!", failed: "No" };
  expect(previewToShow(unknown, "Thanks!", undefined)).toBe(unknown);
  expect(previewToShow(unknown, "Thanks!", "de")).toBeUndefined();
  expect(wantsPreview(previewToShow(unknown, "Thanks!", "de"), "Thanks!")).toBe(true);
});

test("previews are asked for only on the Reply tab: on Note, the reply's draft isn't previewed unseen", () => {
  expect(wantsPreview(undefined, "Thanks!", false, false)).toBe(false);
  expect(wantsPreview(undefined, "Thanks!", false, true)).toBe(true);
});

test("a reply that couldn't be translated says why, without the API's advice to send it untranslated", () => {
  expect(withoutAdvice("The translation provider didn't answer. Try again in a moment. Send it untranslated (untranslated: true), or try again.")).toBe(
    "The translation provider didn't answer. Try again in a moment.",
  );
  expect(withoutAdvice("Out of credits.")).toBe("Out of credits.");
});
