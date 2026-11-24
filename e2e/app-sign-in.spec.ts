import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

test("the mobile app's emailed link sends the app a code it exchanges for a session on the API, and leaves the browser signed out", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(olive, "Acme", slug);

  // The app asks for a link, with a state it made up and the challenge of a verifier it keeps: no browser, its link
  // scheme where a page's origin would be.
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const post = (path: string, body: unknown) =>
    fetch(`${APP_URL}/api/auth/app/${path}`, { method: "POST", headers: { "content-type": "application/json", "expo-origin": "tuti://", "x-forwarded-for": ip }, body: JSON.stringify(body) });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const ask = async (state: string) => {
    const before = countEmailsTo(olive.email);
    expect((await post("sign-in-link", { email: olive.email, state, challenge })).status).toBe(200);
    return linkIn(await latestEmailTo(olive.email, { after: before, subject: /^Sign in to Tuti$/ }), `${APP_URL}/app/auth/app-link`);
  };
  const state = randomUUID();
  const link = await ask(state);

  // Opened from the mail app, in the phone's browser, where nobody is signed in.
  const phone = await newPerson(browser, APP_URL);
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(link);
  await expect(phone.getByText("Sign in to the Tuti app")).toBeVisible();
  await expect(phone.getByText(`as ${olive.email}`)).toBeVisible();
  await expect(phone.getByText("It opens the Tuti app, so use the phone or tablet the app is on.")).toBeVisible();
  await checkpoint(phone, "confirm");

  // "Open the app" is answered with a redirect to the app's own link, as a provider's sign-in ends. This browser has no
  // such app, so it stays where it is.
  const open = async (page: typeof phone) => {
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/app/auth/app-link/open")),
      page.getByRole("button", { name: "Open the app" }).click(),
    ]);
    expect(response.status()).toBe(303);
    // The link works once: the button is off after the tap, so a second can't take the first's place.
    await expect(page.getByRole("button", { name: "Open the app" })).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("Opening the Tuti app… If it didn't open, ask for a new link in the app.");
    await expect(page.getByRole("button", { name: "Open the app" })).toBeFocused();
    return new URL((await response.headerValue("location"))!);
  };
  const handed = await open(phone);
  await checkpoint(phone, "opening");
  expect(`${handed.protocol}//${handed.host}`).toBe("tuti://sign-in");
  expect(handed.searchParams.get("state")).toBe(state);
  // A code, and nothing of the session: whatever app the phone opens with it can't use it without the verifier.
  expect([...handed.searchParams.keys()].sort()).toEqual(["code", "state"]);
  const exchange = async (code: string | null, proof: string) => {
    const response = await post("session", { code, verifier: proof });
    return { status: response.status, body: (await response.json()) as { token?: string; cookie?: string } };
  };

  // What the app does with it: the code and its verifier for the session, then the session's token on the API, first
  // for its projects, then in one of them.
  const session = await exchange(handed.searchParams.get("code"), verifier);
  expect(session.status).toBe(200);
  const { token } = session.body;
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`${APP_URL}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const projects = await api("/projects");
  expect(await projects.json()).toEqual({ projects: [{ slug, name: "Acme", role: "OWNER", openConversations: 0 }] });
  const inbox = await api("/conversations", { "tuti-project": slug });
  expect({ status: inbox.status, body: await inbox.json() }).toMatchObject({ status: 200, body: { conversations: [] } });
  expect((await api("/conversations")).status).toBe(400);

  // The code worked once: again, even with the verifier, it's refused, and the session it gave is ended.
  expect((await exchange(handed.searchParams.get("code"), verifier)).status).toBe(401);
  expect((await api("/projects")).status).toBe(401);

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
  expect((await exchange((await open(olive)).searchParams.get("code"), verifier)).status).toBe(200);
  await olive.goto("/app");
  await olive.waitForURL(new RegExp(`/app/${slug}`));
});
