import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { OneClickDns } from "@/server/domain-connect";

import { OneClickDnsButton } from "./one-click-dns";

/** A lookup that's already in, as React reads one without waiting. */
const settled = (value: OneClickDns | null) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });

test("a provider that can add the records gets its button, linking to it", () => {
  const html = renderToStaticMarkup(createElement(OneClickDnsButton, { link: settled({ provider: "Cloudflare", url: "https://dash.cloudflare.com/domainconnect/apply?a=1&sig=x" }) }));
  expect(html).toContain("Your DNS is at Cloudflare, which can add these records for you.");
  expect(html).toContain('href="https://dash.cloudflare.com/domainconnect/apply?a=1&amp;sig=x"');
  expect(html).toContain("Add with Cloudflare");
});

test("none without one", () => {
  expect(renderToStaticMarkup(createElement(OneClickDnsButton, { link: settled(null) }))).toBe("");
  expect(renderToStaticMarkup(createElement(OneClickDnsButton, { link: null }))).toBe("");
});
