import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("the mobile app signs in with a password: the session comes back for the API, and the browser stays as it was", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);

  // The app posts the address and password, its link scheme where a page's origin would be: no browser.
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const signIn = async (password: string, headers: Record<string, string> = { "expo-origin": "tuti://" }) => {
    const response = await fetch(`${APP_URL}/api/auth/app/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
      body: JSON.stringify({ email: olive.email, password }),
    });
    return { status: response.status, body: (await response.json()) as { token?: string; cookie?: string; code?: string }, setCookie: response.headers.getSetCookie() };
  };
  expect(await signIn("not the password")).toMatchObject({ status: 401, body: { code: "INVALID_EMAIL_OR_PASSWORD" } });
  const session = await signIn("correct horse battery staple");
  expect(session.status).toBe(200);
  expect(session.setCookie).toEqual([]);
  const { token } = session.body;

  // What the app does with it: its projects, then the Inbox of one.
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`${APP_URL}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  expect(await (await api("/projects")).json()).toEqual({ projects: [{ slug, name: "Acme", role: "OWNER", openConversations: 0 }] });
  const inbox = await api("/conversations", { "tuti-project": slug });
  expect({ status: inbox.status, body: await inbox.json() }).toMatchObject({ status: 200, body: { conversations: [] } });

  // A page can't get a token here: its post has an Origin.
  expect((await signIn("correct horse battery staple", { "expo-origin": "tuti://", origin: APP_URL })).status).toBe(403);

  // The browser Olive signed up in is still signed in as it was, and the app's emailed link is gone.
  await olive.goto("/app");
  await olive.waitForURL(new RegExp(`/app/${slug}`));
  expect((await olive.goto("/app/auth/app-link?token=anything"))?.status()).toBe(404);
});
