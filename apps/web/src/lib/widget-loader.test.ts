import { expect, test } from "vitest";

import { widgetLoader } from "./widget-loader";

test("the loader is valid JavaScript with the portal template and the slug check built in", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain('"https://{project}.tuti.example".replace("{project}", slug)');
  expect(script).toContain("/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)");
  // Text goes in with textContent; nothing builds HTML from strings.
  expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("sign-in tokens go to the panel only, on the portal's origin, when it asks", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  // postMessage to the frame names its origin; never "*" for a token.
  expect(script).toMatch(/target\.postMessage\(\{ type: "tuti:identify", token: token \}, origin\)/);
  expect(script).not.toMatch(/postMessage\([^)]*token[^)]*"\*"\)/);
  // Messages count only from the panel's own window and origin.
  expect(script).toContain("event.source !== frame.contentWindow || event.origin !== origin");
});

test("the new-updates dot asks the app when the latest announcement was and remembers what this browser has seen", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  expect(script).toContain('fetch(api + "/api/widget/latest?project=" + encodeURIComponent(slug))');
  expect(script).toContain('var seenKey = "tuti:seen:" + slug;');
  // Storage can be blocked; reading or writing it never breaks the widget.
  expect(script).toContain("try { return fn(window.localStorage); } catch (error) { return null; }");
});
