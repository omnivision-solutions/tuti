import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CollectionIcon } from "./collection-icon";

const drawn = async (name: string | null) => {
  const icon = await CollectionIcon({ name });
  return icon && renderToStaticMarkup(icon);
};

test("a known icon is an inline SVG, hidden from screen readers and drawn in the text's colour", async () => {
  const svg = await drawn("credit-card");
  expect(svg).toMatch(/^<svg [^>]*aria-hidden="true"/);
  expect(svg).toContain('stroke="currentColor"');
  expect(svg).toContain('<path d="M6 14h2"></path>');
});

test("an unknown name, or none, draws nothing", async () => {
  expect(await drawn("not-an-icon")).toBeNull();
  expect(await drawn("constructor")).toBeNull();
  expect(await drawn(null)).toBeNull();
});
