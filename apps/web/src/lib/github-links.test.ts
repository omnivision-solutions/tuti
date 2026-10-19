import { expect, test } from "vitest";

import { parseGitHubUrl } from "./github-links";

test.each([
  ["https://github.com/acme/app/pull/12", { kind: "PULL_REQUEST", repo: "acme/app", number: 12, tag: null, url: "https://github.com/acme/app/pull/12" }],
  ["https://github.com/acme/app/pull/12/files#diff", { kind: "PULL_REQUEST", number: 12, url: "https://github.com/acme/app/pull/12" }],
  ["https://www.github.com/acme/app/issues/7?x=1", { kind: "ISSUE", number: 7, url: "https://github.com/acme/app/issues/7" }],
  ["https://github.com/acme/app/releases/tag/v1.2.0", { kind: "RELEASE", repo: "acme/app", number: null, tag: "v1.2.0" }],
])("%s", (url, expected) => {
  expect(parseGitHubUrl(url)).toMatchObject(expected);
});

test.each([
  "http://github.com/acme/app/pull/12",
  "https://github.com.evil.example/acme/app/pull/12",
  "https://gitlab.com/acme/app/pull/12",
  "https://github.com/acme/app",
  "https://github.com/acme/app/pull/abc",
  "https://github.com/acme/app/commit/abc123",
  "javascript:alert(1)",
  "not a url",
])("%s isn't a link we take", (url) => {
  expect(parseGitHubUrl(url)).toBeNull();
});
