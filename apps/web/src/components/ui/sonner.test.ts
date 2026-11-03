import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

let themes: { theme?: string; forcedTheme?: string } = {};
const shown: unknown[] = [];
vi.mock("next-themes", () => ({ useTheme: () => themes }));
vi.mock("sonner", () => ({
  Toaster: (props: { theme: unknown }) => {
    shown.push(props.theme);
    return null;
  },
}));
const { Toaster } = await import("./sonner");

test("toasts take a forced theme (a widget's data-theme, the marketing site's light) over the reader's own pick", () => {
  for (const [given, expected] of [
    [{ theme: "system", forcedTheme: "dark" }, "dark"],
    [{ theme: "dark", forcedTheme: "light" }, "light"],
    [{ theme: "dark" }, "dark"],
    [{}, "system"],
  ] as const) {
    themes = given;
    shown.length = 0;
    renderToStaticMarkup(createElement(Toaster));
    expect(shown).toEqual([expected]);
  }
});
