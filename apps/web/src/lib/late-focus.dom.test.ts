// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

import { lateFocus } from "./late-focus";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const button = () => document.body.appendChild(document.createElement("button"));

test("the element expected takes the focus as it appears, once", () => {
  const focus = lateFocus();
  focus.expect(7);
  const ask = button();
  focus.take(ask, 7);
  expect(document.activeElement).toBe(ask);
  // Forgotten: another that appears later doesn't take it.
  const other = button();
  focus.take(other, 7);
  expect(document.activeElement).toBe(ask);
});

test("another entry's doesn't take it, and the one expected no longer does after", () => {
  const focus = lateFocus();
  focus.expect(7);
  focus.take(button(), 8);
  expect(document.activeElement).toBe(document.body);
  focus.take(button(), 7);
  expect(document.activeElement).toBe(document.body);
});

test("past its time it doesn't take the focus", () => {
  vi.useFakeTimers();
  const focus = lateFocus(10_000);
  focus.expect(7);
  vi.advanceTimersByTime(10_001);
  focus.take(button(), 7);
  expect(document.activeElement).toBe(document.body);
});

test("focus put somewhere meanwhile (typing in the title) stays there", () => {
  const focus = lateFocus();
  focus.expect(7);
  const title = document.body.appendChild(document.createElement("input"));
  title.focus();
  focus.take(button(), 7);
  expect(document.activeElement).toBe(title);
});
