import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import AccountPage from "./account/page";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

let s3: S3Fake;
beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

const account = async () => renderToStaticMarkup(await AccountPage()).replace(/&#x27;/g, "'");

/** Account's Photo: uploads go to a project of theirs; without one, a photo they have can still be removed. */
test("a photo uploads into their project; without a project, theirs can only be removed, and with neither there's no field", async () => {
  const owner = await signUp("Owner");
  await createProject(owner);
  actAs(owner);
  expect(await account()).toMatch(/aria-disabled="false"[^>]*aria-label="Upload photo"/);

  const loner = await signUp("Loner");
  actAs(loner);
  expect(await account()).not.toContain(">Photo<");

  await prisma.user.update({ where: { id: loner.id }, data: { image: "https://example.com/face.png" } });
  const markup = await account();
  expect(markup).toContain(">Photo<");
  expect(markup).toContain(">Remove<");
  // Upload is there, off (and still focusable, so Remove can hand it focus).
  expect(markup).toMatch(/aria-disabled="true"[^>]*aria-label="Upload photo"/);
  // The reason is Upload's description, for whoever reaches the button.
  const described = markup.match(/<button[^>]*aria-label="Upload photo"[^>]*>/)![0].match(/aria-describedby="([^"]+)"/)?.[1];
  expect(markup).toContain(`id="${described}">Join a project to upload a photo. Without one, your initials show.</p>`);
});

test("on a server without uploads, a photo can only be removed, and says why; without a photo there's no field", async () => {
  vi.stubEnv("MEDIA_S3_ENDPOINT", "");
  const owner = await signUp("Owner");
  await createProject(owner);
  actAs(owner);
  expect(await account()).not.toContain(">Photo<");

  await prisma.user.update({ where: { id: owner.id }, data: { image: "https://example.com/face.png" } });
  const markup = await account();
  expect(markup).toContain(">Remove<");
  expect(markup).toMatch(/aria-disabled="true"[^>]*aria-label="Upload photo"/);
  expect(markup).toContain("Photo uploads aren't set up on this server. Without one, your initials show.");
});
