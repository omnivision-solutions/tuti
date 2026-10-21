import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { IconField } from "./icon-field";

const field = (defaultValue: string | null, known: boolean) => renderToStaticMarkup(createElement(IconField, { defaultValue, known }));

test("an icon Lucide dropped shows as none, is sent unchanged, and can still be removed", () => {
  const html = field("gone-icon", false);
  expect(html).toContain('value="gone-icon"');
  expect(html).toContain("Add icon");
  expect(html).toContain("Remove icon");
});

test("no icon: only Add icon", () => {
  const html = field(null, true);
  expect(html).toContain("Add icon");
  expect(html).not.toContain("Remove icon");
});
