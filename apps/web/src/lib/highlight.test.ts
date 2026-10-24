import { expect, test } from "vitest";

import { highlightParts } from "./highlight";

const marked = (text: string, query: string) => highlightParts(text, query).filter((_, i) => i % 2 === 1);

test("marks whole words that start with what was typed", () => {
  expect(marked("People signed in, signs and sign-on", "sign")).toEqual(["signed", "signs", "sign"]);
  expect(marked("Owners send invites", "send inv")).toEqual(["send", "invites"]);
});

test("only at the start of a word, in any case, and the text stays whole", () => {
  expect(marked("Design a Signup", "sign")).toEqual(["Signup"]);
  expect(highlightParts("Design a Signup", "sign").join("")).toBe("Design a Signup");
});

test("nothing to mark without words", () => {
  expect(highlightParts("Some text", "  ?! ")).toEqual(["Some text"]);
});
