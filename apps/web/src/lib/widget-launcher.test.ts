import { expect, test } from "vitest";

import { hidesLauncher } from "./widget-launcher";

test("Custom code hides its widget's launcher every way the loader takes, however it's written", () => {
  for (const html of [
    '<script src="https://app.example/widget.js" data-project="acme" data-hide-launcher async></script>',
    "<script>window.TutiSettings = { hideLauncher: true };</script>",
    '<script src="https://app.example/widget.js" data-display="inline"></script>',
    "<script src=https://app.example/widget.js data-display = 'inline'></script>",
    '<script>window.TutiSettings = { display: "inline" };</script>',
    '<script>window.TutiSettings = { "display": "inline" };</script>',
    '<script>TutiSettings.display = "inline";</script>',
  ]) {
    expect(hidesLauncher(html), html).toBe(true);
  }
  for (const html of ['<script src="https://app.example/widget.js" data-project="acme" async></script>', '<script>window.TutiSettings = { display: "sidebar" };</script>']) {
    expect(hidesLauncher(html), html).toBe(false);
  }
});
