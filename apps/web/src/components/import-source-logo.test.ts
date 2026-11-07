import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { IMPORT_SOURCES } from "@/lib/import-parts";

import { IMPORT_SOURCE_LOGOS, ImportSourceLogo } from "./import-source-logo";

test("every source the picker offers, and starting fresh, has its logo rather than the neutral fallback", () => {
  expect(["fresh", ...Object.keys(IMPORT_SOURCES)].filter((key) => !(key in IMPORT_SOURCE_LOGOS))).toEqual([]);
});

test("a logo is hidden from screen readers (the name labels the card) and drawn inline, never fetched", () => {
  for (const key of Object.keys(IMPORT_SOURCE_LOGOS)) {
    const html = renderToStaticMarkup(createElement(ImportSourceLogo, { source: key }));
    expect(html).toMatch(/^<span aria-hidden="true"[^>]*><svg/);
    expect(html).not.toMatch(/<image|href=/);
  }
});
