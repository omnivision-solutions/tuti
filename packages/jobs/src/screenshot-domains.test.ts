import { expect, test } from "vitest";

import { policyDomains } from "./screenshots";

const settings = (appUrl: string, otherDomains: string[] = []) => ({ appUrl, signIn: "NONE" as const, signInLink: null, otherDomains });

test("a run's browser opens the app's registrable domain, so its sibling hosts (an API, a sign-in, www) work", () => {
  expect(policyDomains(settings("https://app.example.com/home"))).toEqual(["example.com"]);
  expect(policyDomains(settings("https://www.example.co.uk"))).toEqual(["example.co.uk"]);
});

test("a domain under a shared suffix (a host's customers') stays itself: never the whole suffix", () => {
  expect(policyDomains(settings("https://acme.vercel.app"))).toEqual(["acme.vercel.app"]);
  expect(policyDomains(settings("https://acme.github.io"))).toEqual(["acme.github.io"]);
});

test("the team's other domains are added; an address with no registrable domain is kept as it is", () => {
  expect(policyDomains(settings("https://app.example.com", ["acme.auth0.com", "example.com"]))).toEqual(["acme.auth0.com", "example.com"]);
  expect(policyDomains(settings("http://localhost:3000"))).toEqual(["localhost"]);
});
