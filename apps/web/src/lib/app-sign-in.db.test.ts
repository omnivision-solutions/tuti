import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";

// Continue with Google is set up when the auth config is read, so its fake starts before anything imports it.
const google = await vi.hoisted(async () => {
  const { startGoogleFake } = await import("@tuti/testkit");
  const fake = await startGoogleFake();
  Object.assign(process.env, fake.env);
  return fake;
});

import AppSignInLinkPage from "@/app/app/(account-pages)/auth/app-link/page";
import { GET as listProjects } from "@/app/api/v1/projects/route";
import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/hosts";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR } from "@/lib/sign-in-link";
import { confirmAppSignInLink, confirmSignInLink, emailSignInLink } from "@/server/sign-in-link";
import { actAs, createProject, signUp, type TestUser, withoutEmail } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

/**
 * Signing in from the mobile app (lib/app-sign-in.ts): Google and the emailed link end in the device's browser with a
 * redirect to the app's link scheme that carries the session, which then works on the API. Only that scheme, on the
 * app's host, and the web's own sign-in is as before.
 */

const APP = appUrl();
const STATE = "state-the-app-made-up-0123";
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

// Better Auth checks no origin or callback under tests unless told to: here they're what's tested.
beforeAll(async () => {
  (await auth.$context).skipOriginCheck = false;
});

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(null);
  request.host = APP.host;
  request.headers = {};
  request.written = [];
});

const newAddress = () => `e2e-${randomUUID()}@example.com`;

/** A request to Better Auth as the mobile app sends them: no Origin, its scheme in `expo-origin`, cookies by hand. */
function fromApp(path: string, { body, cookie, host = APP.host, origin = "tuti://" }: { body?: unknown; cookie?: string; host?: string; origin?: string | null } = {}) {
  return auth.handler(
    new Request(`http://${host}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host, ...(origin && { "expo-origin": origin }), ...(cookie && { cookie }), ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** The session a redirect to the app carries: its `cookie` parameter's session token, as the app would keep and send it. */
function handedOver(location: string | null) {
  const url = new URL(location ?? "");
  const token = /session_token=([^;]+)/.exec(url.searchParams.get("cookie") ?? "")?.[1];
  return { to: `${url.protocol}//${url.host}${url.pathname}`, state: url.searchParams.get("state"), error: url.searchParams.get("error"), token };
}

/** The projects the API lists for a session token: what the app does first with one. */
async function projectsOf(token: string | undefined) {
  const response = await listProjects(new Request(`${APP.origin}/api/v1/projects`, { headers: { host: APP.host, authorization: `Bearer ${token}` } }));
  return { status: response.status, body: await response.json() };
}

/** Continue with Google from the app as `person`, back to `callbackURL`: the response of Google's redirect back to Tuti. */
async function continueWithGoogle(person: { email: string; name: string }, callbackURL: string) {
  const started = await fromApp("/sign-in/social", { body: { provider: "google", callbackURL } });
  if (started.status !== 200) {
    return started;
  }
  const { url } = (await started.json()) as { url: string };
  const browser = randomUUID();
  await fetch(`${google.url}/_fake/next-sign-in`, { method: "POST", body: JSON.stringify({ forwardedFor: browser, sub: randomUUID(), ...person }) });
  const consented = await fetch(url, { headers: { "x-forwarded-for": browser }, redirect: "manual" });
  const back = new URL(consented.headers.get("location")!);
  // In the device's browser, which has the sign-in's state cookie (Better Auth's Expo plugin puts it there on the way out).
  return fromApp(`${back.pathname.replace("/api/auth", "")}${back.search}`, { cookie: cookiesOf(started), origin: null });
}

test("Continue with Google from the app ends at the app's link with a session that works on the API", async () => {
  const back = await continueWithGoogle({ email: owner.email, name: "Olive Owner" }, `tuti://sign-in?state=${STATE}`);
  expect(back.status).toBe(302);
  const session = handedOver(back.headers.get("location"));
  expect(session).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect(await projectsOf(session.token)).toEqual({ status: 200, body: { projects: [{ slug: project.slug, name: project.name, role: "OWNER", openConversations: 0 }] } });
  // The app's own session, like one from the web's sign-in: nothing of Google's kept.
  expect(await prisma.session.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ boundTo: "app" });
  expect(await prisma.account.findFirstOrThrow({ where: { userId: owner.id, providerId: "google" } })).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
});

test("only the app's link scheme is trusted, on the app's host, and the web's sign-in hands nothing over", async () => {
  const person = { email: owner.email, name: "Olive Owner" };
  // Another scheme, another site, and a scheme that only starts like the app's: refused before anything starts.
  for (const callbackURL of ["evil://sign-in", "https://evil.example/sign-in", "tutix://sign-in", "tuti.evil://sign-in"]) {
    expect((await continueWithGoogle(person, callbackURL)).status, callbackURL).toBe(403);
  }
  // On a portal's host the scheme means nothing: neither as where to go back to, nor as where a request is from.
  const portal = `${project.slug}.localhost:3100`;
  expect((await fromApp("/sign-in/social", { host: portal, body: { provider: "google", callbackURL: "tuti://sign-in" } })).status).toBe(403);
  expect((await fromApp("/sign-out", { host: portal, body: {}, cookie: owner.cookie })).status).toBe(403);

  // From the web, back to a page of the app's: the browser gets its cookie, and no session rides in the address.
  const web = await continueWithGoogle(person, "/app");
  expect(web.status).toBe(302);
  expect(web.headers.get("location")).toBe("/app");
  expect(cookiesOf(web)).toContain("tuti.session_token=");
});

/** Asks for the app's sign-in link as the app does. */
const ask = (email: string, state = STATE, host?: string) => fromApp("/app/sign-in-link", { host, body: { email, state } });

/** The link in the latest "Sign in to Tuti" email to `email`. */
async function linkTo(email: string) {
  const message = await mailbox.latestTo(email);
  expect(message.subject).toBe("Sign in to Tuti");
  return new URL(message.text.split(/\s+/).find((word) => word.includes("/app/auth/app-link?"))!);
}

/** The page the link opens, as text. */
async function view(link: URL) {
  const page = await AppSignInLinkPage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(link.searchParams)) } as PageProps<"/app/auth/app-link">);
  const html = renderToStaticMarkup(page).replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  return html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
}

/** "Open the app" on that page. */
function open(link: URL, state = link.searchParams.get("state") ?? "") {
  const form = new FormData();
  form.set("token", link.searchParams.get("token") ?? "");
  form.set("state", state);
  return confirmAppSignInLink(form);
}

const sentTo = (email: string) => mailbox.emails.filter((e) => e.to.includes(email)).length;

/** The browser's cookies as the page's action left them: the last write to each. */
const cookiesKept = () => new Map(request.written.map((cookie) => [cookie.name, cookie]));

test("the emailed link opens a page that hands the app a session, once, and leaves the browser signed out", async () => {
  const asked = await ask(owner.email);
  expect({ status: asked.status, body: await asked.json() }).toEqual({ status: 200, body: { status: true } });
  const link = await linkTo(owner.email);
  expect(link.origin + link.pathname).toBe(`${APP.origin}/app/auth/app-link`);
  expect(link.searchParams.get("state")).toBe(STATE);

  // Opening it uses nothing up: it says whose account, and waits for the tap.
  expect(await view(link)).toBe(`Sign in to the Tuti app as ${owner.email}, on the phone or tablet you're holding. Open the app`);
  expect(await view(link)).toContain("Open the app");

  const session = handedOver((await open(link)).location);
  expect(session).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect(await projectsOf(session.token)).toMatchObject({ status: 200, body: { projects: [{ slug: project.slug, role: "OWNER" }] } });
  expect(await prisma.session.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ boundTo: "app" });
  // The browser that opened it (maybe a desk's) keeps no session: each cookie Better Auth set is taken back.
  expect(cookiesKept().get("tuti.session_token")).toMatchObject({ value: "", maxAge: 0 });
  expect([...cookiesKept().values()].filter((cookie) => cookie.value !== "")).toEqual([]);

  // Used once: again, the app is told so and gets no session, and the page says to ask for a new one.
  expect(handedOver((await open(link)).location)).toMatchObject({ to: "tuti://sign-in", state: STATE, error: "INVALID_TOKEN", token: undefined });
  expect(await view(link)).toBe("This link doesn't work any more It was used already, or it has expired. Ask for a new one in the Tuti app.");
});

test("a link signs in an account only: no address is told apart, and none signs up", async () => {
  const stranger = newAddress();
  const asked = await ask(stranger);
  expect({ status: asked.status, body: await asked.json() }).toEqual({ status: 200, body: { status: true } });
  expect(sentTo(stranger)).toBe(0);
  expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);

  // Malformed asks, and a portal's host, are refused; so is a server that sends no email.
  expect((await ask("not-an-address")).status).toBe(400);
  expect((await ask(owner.email, "short")).status).toBe(400);
  expect((await ask(owner.email, "tuti://evil?state=0123456789")).status).toBe(400);
  expect((await ask(owner.email, STATE, `${project.slug}.localhost:3100`)).status).toBe(400);
  expect((await withoutEmail(() => ask(owner.email))).status).toBe(400);
  expect(sentTo(owner.email)).toBe(0);

  // Under the limits every emailed link shares.
  for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR; i++) {
    expect((await ask(owner.email)).status).toBe(200);
  }
  expect((await ask(owner.email)).status).toBe(429);
  expect(sentTo(owner.email)).toBe(SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);
});

test("the app's link and a portal's are never each other's, and a state that isn't the app's opens nothing", async () => {
  await ask(owner.email);
  const appLink = await linkTo(owner.email);
  // On the portal's own confirm, the app's token is a dead link.
  request.host = `${project.slug}.localhost:3100`;
  const onPortal = new FormData();
  onPortal.set("token", appLink.searchParams.get("token")!);
  onPortal.set("next", "/");
  expect(await confirmSignInLink(onPortal)).toEqual({ location: "/sign-in?link=failed" });
  // And the app's confirm does nothing from a portal's host.
  expect(await open(appLink)).toEqual({ location: null });
  request.host = APP.host;

  // A portal's link, opened as if it were the app's: no session for the app, and the portal's link still works there.
  const reader = newAddress();
  const form = new FormData();
  form.set("email", reader);
  await emailSignInLink(project.slug, "/", form);
  const portalLink = new URL((await mailbox.latestTo(reader)).text.split(/\s+/).find((word) => word.includes("/sign-in/link?"))!);
  portalLink.searchParams.set("state", STATE);
  expect(await view(portalLink)).toContain("This link doesn't work any more");
  expect(handedOver((await open(portalLink)).location)).toMatchObject({ error: "INVALID_TOKEN", token: undefined });
  expect(await prisma.user.count({ where: { email: reader } })).toBe(0);

  // The state goes into the app's link as it is: only what the app could have made up.
  for (const state of ["", "short", "x&cookie=stolen-0123456789", "tuti://elsewhere/0123456789"]) {
    expect(await open(appLink, state)).toEqual({ location: null });
  }
  // The app's link still works after all of that: none of it used it up.
  expect(handedOver((await open(appLink)).location).token).toBeTruthy();
});

test("a browser signed in to the web app stays signed in as it was when it opens the app's link", async () => {
  const other = await signUp("Wes Web");
  await ask(owner.email);
  // Wes's browser opens Olive's link (a shared desk): the app gets Olive's session, the browser keeps Wes's.
  actAs(other);
  const session = handedOver((await open(await linkTo(owner.email))).location);
  expect(await projectsOf(session.token)).toMatchObject({ status: 200, body: { projects: [{ slug: project.slug }] } });
  const mine = /session_token=([^;]+)/.exec(other.cookie)![1];
  // Put back as it was (not cleared), and not the app's.
  expect(cookiesKept().get("tuti.session_token")!.value).toBe(mine);
  expect(cookiesKept().get("tuti.session_token")!.maxAge).toBeGreaterThan(0);
  expect(mine).not.toBe(session.token);
});

test("a verification link never opens the app: anyone can have one sent, and it signs in whoever opens it", async () => {
  const unverified = await signUp("Una Unverified", undefined, { verified: false });
  const sent = await fromApp("/send-verification-email", { body: { email: unverified.email, callbackURL: `tuti://sign-in?state=${STATE}` } });
  expect(sent.status).toBe(200);
  const message = await mailbox.latestTo(unverified.email);
  const link = new URL(message.text.split(/\s+/).find((word) => word.includes("/verify-email?"))!);
  expect(link.searchParams.get("callbackURL")).toBe("/app");
  // Opened, it verifies and signs the browser in, on the web: nothing is handed to an app.
  const opened = await fromApp(`/verify-email${link.search}`, { origin: null });
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe("/app");
});
