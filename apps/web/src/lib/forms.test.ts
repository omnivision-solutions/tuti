import { expect, test } from "vitest";

import { enterSaves } from "./forms";

const enter = { key: "Enter", defaultPrevented: false, isComposing: false, keyCode: 13 };
const input = (type: string) => ({ tagName: "INPUT", type });

test("Enter in a typed input saves the form; other keys, and Enter already handled, don't", () => {
  expect(enterSaves(enter, input("text"))).toBe(true);
  expect(enterSaves(enter, input("number"))).toBe(true);
  expect(enterSaves(enter, input("url"))).toBe(true);
  expect(enterSaves({ ...enter, key: "a" }, input("text"))).toBe(false);
  expect(enterSaves({ ...enter, defaultPrevented: true }, input("text"))).toBe(false);
});

test("the Enter that confirms an input method's text doesn't save: while composing, or Safari's after it, key code 229", () => {
  expect(enterSaves({ ...enter, isComposing: true }, input("text"))).toBe(false);
  expect(enterSaves({ ...enter, keyCode: 229 }, input("text"))).toBe(false);
});

test("Enter is the field's own in a text area and on inputs it works: a colour swatch, a checkbox, a button", () => {
  expect(enterSaves(enter, { tagName: "TEXTAREA" })).toBe(false);
  for (const type of ["color", "range", "checkbox", "radio", "file", "button", "image", "submit", "reset"]) {
    expect(enterSaves(enter, input(type))).toBe(false);
  }
  expect(enterSaves(enter, null)).toBe(false);
});
