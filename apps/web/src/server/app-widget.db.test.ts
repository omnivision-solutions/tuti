import { prisma } from "@tuti/db";
import { decodeJwt, jwtVerify } from "jose";
import { afterEach, expect, test, vi } from "vitest";

import { generateSsoSecret } from "@/lib/sso";
import { actAs, createProject, signUp } from "@/test/helpers";

import { appWidgetToken } from "./app-widget";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("the team app's widget gets a token for the account, signed with its project's SSO secret, once SSO is on there", async () => {
  const project = await createProject(await signUp());
  vi.stubEnv("APP_WIDGET_PROJECT", project.slug);
  const ada = await signUp("Ada");
  actAs(ada);

  // SSO off: no token, so the widget is signed out.
  expect(await appWidgetToken()).toEqual({});

  const secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
  const { token } = await appWidgetToken();
  const { payload } = await jwtVerify(token!, new TextEncoder().encode(secret));
  expect(payload).toMatchObject({ sub: ada.id, name: "Ada" });
  // Not verified yet: no address for the project's emails.
  expect(payload.email).toBeUndefined();
  expect(payload.exp! - payload.iat!).toBe(300);
  // Each token is used once, so each call makes a new one.
  expect(decodeJwt((await appWidgetToken()).token!).jti).not.toBe(payload.jti);
});

test("no project named: no token", async () => {
  actAs(await signUp());
  expect(await appWidgetToken()).toEqual({});
});
