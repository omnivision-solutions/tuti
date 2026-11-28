import { expect, test } from "vitest";

import { allowedHosts } from "./screenshots";
import { partlyScannedFor, scannedFor } from "./sign-in-hosts";

const settings = (appUrl: string, otherDomains: string[] = [], found: Partial<{ signInServices: unknown; signInServicesFor: string | null; skippedDomains: string[] }> = {}) => ({
  appUrl,
  signIn: "NONE" as const,
  signInLink: null,
  otherDomains,
  signInServices: null,
  signInServicesFor: null,
  skippedDomains: [],
  ...found,
});

test("a run's browser opens the app's own host, never its registrable domain: a sibling (another tenant's) only if listed", () => {
  expect(allowedHosts(settings("https://acme.saas.com/home"))).toEqual(["acme.saas.com"]);
  expect(allowedHosts(settings("https://app.example.com", ["api.example.com"]))).toEqual(["api.example.com", "app.example.com"]);
});

test("the team's other hosts are added once each", () => {
  expect(allowedHosts(settings("https://app.example.com", ["acme.auth0.com", "app.example.com"]))).toEqual(["acme.auth0.com", "app.example.com"]);
  expect(allowedHosts(settings("http://localhost:3000"))).toEqual(["localhost"]);
});

const firebase = [{ provider: "Firebase", hosts: ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"] }];

test("the hosts found for the app's sign-in open too, without the team adding them: not those removed, nor another address's", () => {
  const appUrl = "https://app.example.com";
  expect(allowedHosts(settings(appUrl, [], { signInServices: firebase, signInServicesFor: scannedFor(appUrl) }))).toEqual(["app.example.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com"]);
  // What a read that wasn't complete found counts too.
  expect(allowedHosts(settings(appUrl, [], { signInServices: firebase, signInServicesFor: partlyScannedFor(appUrl) }))).toContain("securetoken.googleapis.com");
  expect(allowedHosts(settings(appUrl, [], { signInServices: firebase, signInServicesFor: scannedFor(appUrl), skippedDomains: ["securetoken.googleapis.com"] }))).toEqual(["app.example.com", "identitytoolkit.googleapis.com"]);
  expect(allowedHosts(settings(appUrl, [], { signInServices: firebase, signInServicesFor: scannedFor("https://old.example.com") }))).toEqual(["app.example.com"]);
});

test("a found host is never a shared suffix, nor a Clerk host on another site than the app's", () => {
  const appUrl = "https://app.example.com";
  const signInServices = [{ provider: "Clerk", hosts: ["vercel.app", "clerk.example.com", "clerk.elsewhere.com", "acme-12.clerk.accounts.dev"] }];
  expect(allowedHosts(settings(appUrl, [], { signInServices, signInServicesFor: scannedFor(appUrl) }))).toEqual(["acme-12.clerk.accounts.dev", "app.example.com", "clerk.example.com"]);
});
