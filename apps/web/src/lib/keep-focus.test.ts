import { afterEach, expect, test, vi } from "vitest";

import { keepFocus } from "./keep-focus";

const body = {};
/** An element: on the page or not, disabled or not. */
const element = ({ connected = true, disabled = false } = {}) =>
  ({ isConnected: connected, matches: () => disabled, focus: vi.fn() }) as unknown as HTMLElement;
/** The panel's document: whether it has the focus, and its active element. */
const panel = (focused: boolean, active: unknown) => vi.stubGlobal("document", { body, hasFocus: () => focused, activeElement: active });

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the focus moves on while the panel has it on what's going", () => {
  const from = element();
  const to = element();
  panel(true, from);
  keepFocus(from, to);
  expect(to.focus).toHaveBeenCalled();
});

test("or when it fell to the panel's body because what had it was removed or disabled", () => {
  for (const from of [element({ connected: false }), element({ disabled: true })]) {
    const to = element();
    panel(true, body);
    keepFocus(from, to);
    expect(to.focus).toHaveBeenCalled();
  }
});

test("never while the customer's page has the focus, even where the panel keeps its active element", () => {
  const from = element();
  const to = element();
  panel(false, from);
  keepFocus(from, to);
  panel(false, body);
  keepFocus(element({ connected: false }), to);
  expect(to.focus).not.toHaveBeenCalled();
});

test("nor from elsewhere in the panel", () => {
  const from = element();
  const to = element();
  panel(true, element());
  keepFocus(from, to);
  // The body, with what was focused still there: the focus wasn't on it.
  panel(true, body);
  keepFocus(from, to);
  expect(to.focus).not.toHaveBeenCalled();
});
