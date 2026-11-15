import { expect, test } from "vitest";

import { pageTitle, templateText } from "./page-title";

test("a title with dollar signs comes out of a layout's template as written", () => {
  // As Next.js fills in a template (lib/metadata/resolvers/resolve-title.js).
  const filled = (title: string) => "%s · Acme".replace(/%s/g, title);
  for (const text of ["Charged $$ twice", "Costs $5", "Odd $& and $' and $`"]) {
    expect(filled(pageTitle(text))).toBe(`${text} · Acme`);
  }
});

test("a project's name with %s comes out of its template as written, bar an invisible word joiner", () => {
  const template = `%s · ${templateText("100%sure")}`;
  expect(template.replace(/%s/g, "Inbox").replaceAll("\u2060", "")).toBe("Inbox · 100%sure");
});
