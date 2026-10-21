import { createPublicKey, generateKeyPairSync } from "node:crypto";

import { expect, test, vi } from "vitest";

import { issueLicense } from "@/test/license";

import { licensedUntil } from "./license";

vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey);

const DAY = 24 * 60 * 60 * 1000;

test("a key Tuti signed for the project licenses it until it expires", () => {
  const until = licensedUntil(issueLicense("project-1", 30), "project-1");
  expect(until!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  expect(licensedUntil(` ${issueLicense("project-1")}\n`, "project-1")).not.toBeNull();
  expect(licensedUntil(issueLicense("project-1", 30), "project-1", new Date(Date.now() + 31 * DAY))).toBeNull();
  expect(licensedUntil(issueLicense("project-1", -1), "project-1")).toBeNull();
});

test("a key for another project, signed by anyone else, or edited doesn't", () => {
  expect(licensedUntil(issueLicense("project-2"), "project-1")).toBeNull();
  expect(licensedUntil(issueLicense("project-1", 30, { signedWith: generateKeyPairSync("ed25519").privateKey }), "project-1")).toBeNull();

  // The claims of another project's key, with its signature.
  const [, signature] = issueLicense("project-2").split(".");
  const claims = Buffer.from(JSON.stringify({ project: "project-1", exp: Date.now() / 1000 + 9e9 })).toString("base64url");
  expect(licensedUntil(`${claims}.${signature}`, "project-1")).toBeNull();

  for (const junk of [null, "", "nope", "a.b", "a.b.c", `${issueLicense("project-1")}.x`]) {
    expect(licensedUntil(junk, "project-1")).toBeNull();
  }
});

test("Tuti's own public key is an Ed25519 key", async () => {
  const { LICENSE_PUBLIC_KEY } = await vi.importActual<typeof import("./license-key")>("./license-key");
  expect(createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ed25519");
});
