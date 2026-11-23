import { expect, test } from "vitest";

import { sitePrompt } from "./site-prompt";

test("the prompt forwards the path and /_tuti to the Tuti address, paths and all, and says how to test it", () => {
  const prompt = sitePrompt({ url: "https://acme.com/help", tuti: "https://acme.tuti.so" });
  expect(prompt).toContain("Put our Tuti help portal at https://acme.com/help on our site.");
  expect(prompt).toContain("/help and /help/*  ->  https://acme.tuti.so/help and https://acme.tuti.so/help/*");
  expect(prompt).toContain("/_tuti/*  ->  https://acme.tuti.so/_tuti/*");
  expect(prompt).toContain("with the Host header acme.tuti.so");
  expect(prompt).toContain("Match /help itself and everything under /help/, never /help* (that would also take a page like /help-news)");
  expect(prompt).toContain("Next.js: rewrites in next.config under beforeFiles");
  expect(prompt).toContain("proxy_pass https://acme.tuti.so (no path after it), proxy_set_header Host acme.tuti.so");
  expect(prompt).toContain("the routes acme.com/help, acme.com/help/* and acme.com/_tuti/*");
  expect(prompt).toContain("https://acme.com/help/.well-known/tuti-site and https://acme.com/_tuti/.well-known/tuti-site");
});

test("a Tuti address with a port (a local install) keeps it", () => {
  const prompt = sitePrompt({ url: "http://localhost:4000/portal", tuti: "http://acme.localhost:3000" });
  expect(prompt).toContain("the Host header acme.localhost:3000");
  expect(prompt).toContain("http://localhost:4000/portal/.well-known/tuti-site");
});
