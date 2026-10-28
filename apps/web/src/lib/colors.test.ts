import { expect, test } from "vitest";

import { widgetHeaderStyle } from "./colors";

test("the widget's header shades its colour only away from its text, so the text reads everywhere on it", () => {
  // Near where black and white text swap: whichever is picked, the gradient never moves toward it.
  expect(widgetHeaderStyle("#757575")).toEqual({
    background: "linear-gradient(135deg, #757575, color-mix(in oklab, #757575, #000000 22%))",
    color: "#ffffff",
  });
  expect(widgetHeaderStyle("#767676")).toEqual({
    background: "linear-gradient(135deg, #767676, color-mix(in oklab, #767676, #ffffff 22%))",
    color: "#000000",
  });
  // The brand green, with its foreground for the mode; shaded toward that foreground's opposite.
  expect(widgetHeaderStyle(null)).toEqual({
    background: "linear-gradient(135deg, var(--primary), color-mix(in oklab, var(--primary), oklch(from var(--primary-foreground) calc(1 - l) 0 0) 22%))",
    color: "var(--primary-foreground)",
  });
});
