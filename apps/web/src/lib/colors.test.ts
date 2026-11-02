import { expect, test } from "vitest";

import { parseHex, widgetHeaderStyle } from "./colors";

test("the widget's header shades its colour only away from its text, so the text reads everywhere on it", () => {
  // Near where black and white text swap: whichever is picked, the gradient never moves toward it.
  expect(widgetHeaderStyle("#757575")).toEqual({
    backgroundColor: "#757575",
    backgroundImage: "linear-gradient(135deg, #757575, color-mix(in oklab, #757575, #000000 22%))",
    color: "#ffffff",
  });
  expect(widgetHeaderStyle("#767676")).toEqual({
    backgroundColor: "#767676",
    backgroundImage: "linear-gradient(135deg, #767676, color-mix(in oklab, #767676, #ffffff 22%))",
    color: "#000000",
  });
  // The brand green, with its foreground for the mode; shaded toward that foreground's opposite. The colour
  // is there on its own too, for browsers that drop the gradient (no relative colours or color-mix).
  expect(widgetHeaderStyle(null)).toEqual({
    backgroundColor: "var(--primary)",
    backgroundImage: "linear-gradient(135deg, var(--primary), color-mix(in oklab, var(--primary), oklch(from var(--primary-foreground) calc(1 - l) 0 0) 22%))",
    color: "var(--primary-foreground)",
  });
});

test("a colour typed as hex is read as #rrggbb, #rgb expanded, and anything else isn't a colour", () => {
  expect(parseHex("#2563EB")).toBe("#2563eb");
  expect(parseHex(" 2563eb ")).toBe("#2563eb");
  expect(parseHex("#abc")).toBe("#aabbcc");
  for (const typed of ["", "#", "#25", "#2563", "#2563e", "#2563ebf", "#ggg", "blue"]) {
    expect(parseHex(typed)).toBeNull();
  }
});
