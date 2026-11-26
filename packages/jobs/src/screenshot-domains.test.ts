import { expect, test } from "vitest";

import { allowedHosts } from "./screenshots";

const settings = (appUrl: string, otherDomains: string[] = []) => ({ appUrl, signIn: "NONE" as const, signInLink: null, otherDomains });

test("a run's browser opens the app's own host, never its registrable domain: a sibling (another tenant's) only if listed", () => {
  expect(allowedHosts(settings("https://acme.saas.com/home"))).toEqual(["acme.saas.com"]);
  expect(allowedHosts(settings("https://app.example.com", ["api.example.com"]))).toEqual(["api.example.com", "app.example.com"]);
});

test("the team's other hosts are added once each", () => {
  expect(allowedHosts(settings("https://app.example.com", ["acme.auth0.com", "app.example.com"]))).toEqual(["acme.auth0.com", "app.example.com"]);
  expect(allowedHosts(settings("http://localhost:3000"))).toEqual(["localhost"]);
});
