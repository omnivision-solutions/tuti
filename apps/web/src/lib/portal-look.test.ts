import { expect, test } from "vitest";

import { CUSTOM_CODE_MAX, isFromPortal, isToPortal, styleText, webOnly } from "./portal-look";

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
  // Only a look's own keys, of their own kinds.
  expect(webOnly({ contentActions: { menu: true }, docsHome: { title: 1 }, other: "x" } as never)).toEqual({});
  expect(webOnly({ contentActions: { menu: false, copyMarkdown: true, chatGpt: true, claude: false, updatedDate: true } })).toEqual({
    contentActions: { menu: false, copyMarkdown: true, chatGpt: true, claude: false, updatedDate: true },
  });
  expect(webOnly({ docsHome: { title: "x".repeat(100), subtitle: "Hi", popular: true } }).docsHome).toEqual({ title: "x".repeat(80), subtitle: "Hi", popular: true });
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

test("the rest of a change: a known colour scheme, web or mailto: Contact us, web links for the logo", () => {
  expect(webOnly({ colorScheme: "dark", logoText: "Acme", logoLink: "https://acme.example", contact: { label: "", url: "mailto:help@acme.example" } })).toEqual({
    colorScheme: "dark",
    logoText: "Acme",
    logoLink: "https://acme.example",
    contact: { label: "", url: "mailto:help@acme.example" },
  });
  expect(webOnly({ colorScheme: "sepia" as never, logoLink: "javascript:alert(1)", contact: { label: "", url: "javascript:alert(1)" } })).toEqual({});
  expect(webOnly({ contact: null, logoLink: null })).toEqual({ contact: null, logoLink: null });
  expect(webOnly({ sidebarLinks: [{ label: "Status", url: "https://status.example.com" }, { label: "Bad", url: "javascript:x" }] })).toEqual({
    sidebarLinks: [{ label: "Status", url: "https://status.example.com" }],
  });
});

test("fonts: only the portal fonts, or null", () => {
  expect(webOnly({ fonts: { heading: "lora", body: null } })).toEqual({ fonts: { heading: "lora", body: null } });
  expect(webOnly({ fonts: { heading: "url(https://evil.example/x.woff)" as never, body: null } })).toEqual({});
});

test("the team's CSS can't close its style element and become HTML; it's capped", () => {
  expect(styleText("a { color: red } </style><script>alert(1)</script>")).toBe("a { color: red } <\\/style><script>alert(1)</script>");
  expect(styleText("</STYLE >")).toBe("<\\/STYLE >");
  expect(styleText(".a > .b { content: '<' }")).toBe(".a > .b { content: '<' }");
  expect(webOnly({ customCss: "x".repeat(CUSTOM_CODE_MAX + 10) }).customCss).toHaveLength(CUSTOM_CODE_MAX);
});
