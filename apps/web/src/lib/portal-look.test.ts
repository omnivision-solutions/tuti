import { expect, test } from "vitest";

import { isFromPortal, isToPortal, webOnly } from "./portal-look";

test("a change from the app keeps web links and images and a #rrggbb colour, and drops anything else", () => {
  expect(
    webOnly({
      color: "#5b21b6",
      logo: { url: "https://media.example.com/logo.webp" },
      logoDark: { url: "javascript:alert(1)" },
      headerLinks: [
        { label: "Docs", url: "https://docs.example.com" },
        { label: "Bad", url: "javascript:alert(1)" },
      ],
      footerLinks: [{ label: "Data", url: "data:text/html,hi" }],
      poweredBy: false,
    }),
  ).toEqual({
    color: "#5b21b6",
    logo: { url: "https://media.example.com/logo.webp" },
    logoDark: null,
    headerLinks: [{ label: "Docs", url: "https://docs.example.com" }],
    footerLinks: [],
    poweredBy: false,
  });
  // A colour that isn't one is left out, so what's saved stays; null is the brand green.
  expect(webOnly({ color: "red}html{display:none" })).toEqual({});
  expect(webOnly({ color: null, logo: null })).toEqual({ color: null, logo: null });
});

test("only the preview's own messages are taken as such", () => {
  expect(isToPortal({ type: "tuti:look", look: {} })).toBe(true);
  expect(isToPortal({ type: "tuti:theme", theme: "dark" })).toBe(true);
  expect(isToPortal({ type: "tuti:theme", theme: "sepia" })).toBe(false);
  expect(isToPortal({ type: "tuti:look", look: null })).toBe(false);
  expect(isToPortal({ type: "other" })).toBe(false);
  expect(isToPortal("tuti:look")).toBe(false);
  expect(isFromPortal({ type: "tuti:ready", path: "/docs" })).toBe(true);
  expect(isFromPortal({ type: "tuti:ready" })).toBe(false);
});
