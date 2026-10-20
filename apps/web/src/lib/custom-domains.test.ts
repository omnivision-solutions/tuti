import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { normalizeHostname } from "./custom-domains";

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}--dev.tuti.example");
});
afterEach(() => vi.unstubAllEnvs());

test("hostnames as people paste them", () => {
  expect(normalizeHostname("help.acme.com")).toEqual({ hostname: "help.acme.com" });
  expect(normalizeHostname(" HTTPS://Help.Acme.com/docs?x#y ")).toEqual({ hostname: "help.acme.com" });
  expect(normalizeHostname("help.acme.com.")).toEqual({ hostname: "help.acme.com" });
  expect(normalizeHostname("acme.com")).toEqual({ hostname: "acme.com" });
  expect(normalizeHostname("docs.xn--bcher-kva.example")).toEqual({ hostname: "docs.xn--bcher-kva.example" });
});

test("not the app's domain or the portals', nor anything under them", () => {
  for (const hostname of ["tuti.example", "acme.tuti.example", "acme--dev.tuti.example", "a.b.tuti.example"]) {
    expect(normalizeHostname(hostname)).toEqual({ error: "Pick a domain of your own, not one under tuti.example" });
  }
  // Only under it: a domain that ends the same way is someone else's.
  expect(normalizeHostname("help.mytuti.example")).toEqual({ hostname: "help.mytuti.example" });
});

test("anything that isn't a hostname", () => {
  for (const input of ["", "acme", "help..acme.com", "help_desk.acme.com", "help.acme.123", `${"a".repeat(64)}.acme.com`, "help.acme-.com", "user@acme.com"]) {
    expect(normalizeHostname(input)).toEqual({ error: "Enter a domain like help.example.com" });
  }
  expect(normalizeHostname("help.acme.com:443")).toEqual({ error: "Enter the domain without a port" });
});
