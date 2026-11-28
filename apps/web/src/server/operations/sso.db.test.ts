import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { callerAs, createProject, signUp } from "@/test/helpers";

/** Settings → Single sign-on's operations: the secret only ever comes back when it's made, and the sign-in page is https. */
test("single sign-on: turned on with a key shown once, read back without it, its sign-in page https only, then off", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const caller = await callerAs(owner);
  expect(await caller.sso.get({ project: project.slug })).toEqual({ enabled: false, signInUrl: null });

  const { secret } = await caller.sso.rotate({ project: project.slug });
  expect(secret).toEqual((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { ssoSecret: true } })).ssoSecret);
  // Read back: on, never the key.
  expect(await caller.sso.get({ project: project.slug })).toEqual({ enabled: true, signInUrl: null });
  // Replacing it makes another.
  expect((await caller.sso.rotate({ project: project.slug })).secret).not.toBe(secret);

  await expect(caller.sso.update({ project: project.slug, signInUrl: "http://app.example.com/login" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Enter an https:// address" });
  await caller.sso.update({ project: project.slug, signInUrl: "  https://app.example.com/login  " });
  expect(await caller.sso.get({ project: project.slug })).toEqual({ enabled: true, signInUrl: "https://app.example.com/login" });
  // Empty removes it.
  await caller.sso.update({ project: project.slug, signInUrl: "" });
  await caller.sso.disable({ project: project.slug });
  expect(await caller.sso.get({ project: project.slug })).toEqual({ enabled: false, signInUrl: null });
});
