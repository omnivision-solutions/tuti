import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

test("the mobile app's emailed link hands the app a session for the API, and leaves the browser signed out", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);

  // The app asks for a link, with a state it made up: no browser, its link scheme where a page's origin would be.
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const ask = async (state: string) => {
    const before = countEmailsTo(olive.email);
    const asked = await fetch(`${APP_URL}/api/auth/app/sign-in-link`, {
      method: "POST",
      headers: { "content-type": "application/json", "expo-origin": "tuti://", "x-forwarded-for": ip },
      body: JSON.stringify({ email: olive.email, state }),
    });
    expect(asked.status).toBe(200);
    return linkIn(await latestEmailTo(olive.email, { after: before, subject: /^Sign in to Tuti$/ }), `${APP_URL}/app/auth/app-link`);
  };
  const state = randomUUID();
  const link = await ask(state);

  // Opened from the mail app, in the phone's browser, where nobody is signed in.
  const phone = await newPerson(browser, APP_URL);
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(link);
  await expect(phone.getByText("Sign in to the Tuti app")).toBeVisible();
  await expect(phone.getByText(`as ${olive.email}, on the phone or tablet you're holding.`)).toBeVisible();
  await checkpoint(phone, "confirm");

  // "Open the app" goes to the app's own link. This browser has no such app, so the link stays to tap.
  await phone.getByRole("button", { name: "Open the app" }).click();
  const open = phone.getByRole("link", { name: "Open the Tuti app" });
  await expect(open).toBeVisible();
  await expect(phone.getByText("Nothing happened? This works on a phone or tablet with the Tuti app.")).toBeVisible();
  await checkpoint(phone, "open-the-app");
  const handed = new URL((await open.getAttribute("href"))!);
  expect(`${handed.protocol}//${handed.host}`).toBe("tuti://sign-in");
  expect(handed.searchParams.get("state")).toBe(state);

  // What the app does with it: the session's token on the API, first for its projects, then in one of them.
  const token = /session_token=([^;]+)/.exec(handed.searchParams.get("cookie") ?? "")![1]!;
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`${APP_URL}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const projects = await api("/projects");
  expect(await projects.json()).toEqual({ projects: [{ slug, name: "Acme", role: "OWNER", openConversations: 0 }] });
  const inbox = await api("/conversations", { "tuti-project": slug });
  expect({ status: inbox.status, body: await inbox.json() }).toMatchObject({ status: 200, body: { conversations: [] } });
  expect((await api("/conversations")).status).toBe(400);

  // The browser that opened the link isn't signed in: the session is the app's alone.
  await phone.goto("/app");
  await phone.waitForURL(/\/app\/auth\/sign-in/);

  // Used once: the link now says to ask for a new one.
  await phone.goto(link);
  await expect(phone.getByText("This link doesn't work any more")).toBeVisible();
  await expect(phone.getByText("It was used already, or it has expired. Ask for a new one in the Tuti app.")).toBeVisible();
  await checkpoint(phone, "used");

  // A browser already signed in to the web app (Olive's own) opens another link: the app gets its session, and the
  // browser stays signed in as it was.
  await olive.goto(await ask(randomUUID()));
  await olive.getByRole("button", { name: "Open the app" }).click();
  await expect(olive.getByRole("link", { name: "Open the Tuti app" })).toBeVisible();
  await olive.goto("/app");
  await olive.waitForURL(new RegExp(`/app/${slug}`));
});
