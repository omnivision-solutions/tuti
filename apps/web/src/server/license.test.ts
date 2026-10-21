import { createPublicKey, generateKeyPairSync } from "node:crypto";

import { expect, test, vi } from "vitest";

import { issueLicense } from "@/test/license";

import { licensedUntil } from "./license";

vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey);

const DAY = 24 * 60 * 60 * 1000;
const ours = { installation: "installation-1", project: "project-1" };

test("a key Tuti signed for the project on this installation licenses it until it expires", () => {
  expect(licensedUntil(issueLicense(ours, 30), ours)!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  expect(licensedUntil(` ${issueLicense(ours)}\n`, ours)).not.toBeNull();
  expect(licensedUntil(issueLicense(ours, 30), ours, new Date(Date.now() + 31 * DAY))).toBeNull();
  expect(licensedUntil(issueLicense(ours, -1), ours)).toBeNull();
});

test("a key for another project or installation, signed by anyone else, or edited doesn't", () => {
  expect(licensedUntil(issueLicense({ ...ours, project: "project-2" }), ours)).toBeNull();
  expect(licensedUntil(issueLicense({ ...ours, installation: "installation-2" }), ours)).toBeNull();
  expect(licensedUntil(issueLicense(ours, 30, { signedWith: generateKeyPairSync("ed25519").privateKey }), ours)).toBeNull();

  // Another installation's claims, edited to be ours, with its signature.
  const [, signature] = issueLicense({ ...ours, installation: "installation-2" }).split(".");
  const claims = Buffer.from(JSON.stringify({ ...ours, exp: Date.now() / 1000 + 9e9 })).toString("base64url");
  expect(licensedUntil(`${claims}.${signature}`, ours)).toBeNull();

  for (const junk of [null, "", "nope", "a.b", "a.b.c", `${issueLicense(ours)}.x`]) {
    expect(licensedUntil(junk, ours)).toBeNull();
  }
});

test("Tuti's own public keys are Ed25519 keys", async () => {
  const { LICENSE_PUBLIC_KEYS } = await vi.importActual<typeof import("./license-key")>("./license-key");
  expect(LICENSE_PUBLIC_KEYS.length).toBeGreaterThan(0);
  for (const key of LICENSE_PUBLIC_KEYS) {
    expect(createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ed25519");
  }
});
