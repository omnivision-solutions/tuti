import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { webPage } from "@/lib/answer-text";

// Its imports reach the server's settings.
vi.stubEnv("APP_URL", "https://tuti.example");
vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");
const { AnswerSources } = await import("./docs-answer");
const { TeamLanguageContext } = await import("./portal-look");

test("a source opening on its own page links only a web page's address; any other scheme is its title as text", () => {
  const sources = [
    { slug: "reference/create-a-post", title: "Create a post (POST /posts)", url: "https://acme.example/docs/reference/create-a-post" },
    { slug: "reference/evil", title: "Evil", url: "javascript:alert(document.cookie)" },
    { slug: "reference/data", title: "Data", url: "data:text/html,<script>alert(1)</script>" },
  ];
  const html = renderToStaticMarkup(createElement(AnswerSources, { sources, href: () => null }));
  expect(html).toContain('<a href="https://acme.example/docs/reference/create-a-post" target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("data:");
  expect(html).toContain('<span class="break-words">Evil</span>');
  expect(html).toContain('<span class="break-words">Data</span>');
});

test("webPage: http and https addresses only", () => {
  expect(webPage("https://acme.example/a")).toBe("https://acme.example/a");
  expect(webPage("http://acme.example")).toBe("http://acme.example/");
  for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "/docs/a", "not a url", "vbscript:x"]) {
    expect(webPage(url), url).toBeNull();
  }
});

test("each source's title is marked with its own language: a translation's, else the team's default", () => {
  const sources = [
    { slug: "abrechnung", title: "Abrechnung", url: null, language: "de" },
    { slug: "setup", title: "Setup", url: null },
  ];
  const html = renderToStaticMarkup(createElement(TeamLanguageContext.Provider, { value: "en" }, createElement(AnswerSources, { sources })));
  expect(html).toContain('<span lang="de" class="break-words">Abrechnung</span>');
  expect(html).toContain('<span lang="en" class="break-words">Setup</span>');
});
