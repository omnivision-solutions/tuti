import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { previewUser } from "@/server/auth/preview-session";
import { callerAs, createProject, signUp } from "@/test/helpers";

/** customize.preview (Portal settings' preview): a person gets a token that reads the portal as them; a key never does. */
test("the preview's token is the signed-in admin's own, and a key gets none", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);

  const asOwner = await (await callerAs(owner)).customize.preview({ project: project.slug, path: "/feedback" });
  expect(asOwner).toMatchObject({ path: "/feedback", token: expect.any(String) });
  expect(previewUser(project.id, asOwner.token!)).toBe(owner.id);

  const key = await prisma.apiKey.create({ data: { projectId: project.id, name: "Read", scope: "READ", keyHash: crypto.randomUUID(), prefix: "tuti_r", createdById: owner.id } });
  const asKey = await (await callerAs({ apiKeyId: key.id })).customize.preview({ project: project.slug, path: "/feedback" });
  expect(asKey.path).toBe("/feedback");
  expect(asKey).not.toHaveProperty("token");
});
