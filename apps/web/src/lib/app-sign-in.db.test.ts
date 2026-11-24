import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";

// Continue with Google is set up when the auth config is read, so its fake starts before anything imports it.
const google = await vi.hoisted(async () => {
  const { startGoogleFake } = await import("@tuti/testkit");
  const fake = await startGoogleFake();
  // GitHub too, at its real address: nothing here fetches it, and the Expo plugin's step in the browser takes https only.
  Object.assign(process.env, fake.env, { GITHUB_CLIENT_ID: "test-github-client", GITHUB_CLIENT_SECRET: "test-github-secret", GITHUB_URL: "", GITHUB_API_URL: "" });
  return fake;
});

import AppSignInLinkPage from "@/app/app/(account-pages)/auth/app-link/page";
import { GET as listProjects } from "@/app/api/v1/projects/route";
import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/hosts";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR } from "@/lib/sign-in-link";
import { POST as openAppLink } from "@/app/app/(account-pages)/auth/app-link/open/route";
import { confirmSignInLink, emailSignInLink } from "@/server/sign-in-link";
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

/**
 * Continue with Google as `person`, back to `callbackURL`: the response of Google's redirect back to Tuti. From the app,
 * its own request starts it and the device's browser goes through the proxy for the sign-in's state; a page's browser
 * starts it itself.
 */
async function continueWithGoogle(person: { email: string; name: string }, callbackURL: string, { fromThe = "app" as "app" | "web" } = {}) {
  const started = await fromApp("/sign-in/social", { body: { provider: "google", callbackURL }, origin: fromThe === "app" ? "tuti://" : null });
  if (started.status !== 200) {
    return started;
  }
  const { url } = (await started.json()) as { url: string };
  let browser = cookiesOf(started);
  if (fromThe === "app") {
    const proxied = await fromApp(`/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: url })}`, { origin: null });
    expect(proxied.status).toBe(302);
    expect(proxied.headers.get("location")).toBe(url);
    browser = cookiesOf(proxied);
  }
  const who = randomUUID();
  await fetch(`${google.url}/_fake/next-sign-in`, { method: "POST", body: JSON.stringify({ forwardedFor: who, sub: randomUUID(), ...person }) });
  const consented = await fetch(url, { headers: { "x-forwarded-for": who }, redirect: "manual" });
  const back = new URL(consented.headers.get("location")!);
  return fromApp(`${back.pathname.replace("/api/auth", "")}${back.search}`, { cookie: browser, origin: null });
}

test("Continue with Google from the app ends at the app's link with a session that works on the API", async () => {
  const back = await continueWithGoogle({ email: owner.email, name: "Olive Owner" }, `tuti://sign-in?state=${STATE}`);
  expect(back.status).toBe(302);
  const session = handedOver(back.headers.get("location"));
  expect(session).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect(await projectsOf(session.token)).toEqual({ status: 200, body: { projects: [{ slug: project.slug, name: project.name, role: "OWNER", openConversations: 0 }] } });
  // The browser it went through keeps no session: it's the app's alone.
  expect(back.headers.getSetCookie()).toEqual([]);
  // The app's own session, like one from the web's sign-in: nothing of Google's kept.
  expect(await prisma.session.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ boundTo: "app" });
  expect(await prisma.account.findFirstOrThrow({ where: { userId: owner.id, providerId: "google" } })).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });

  // Signing out from the app: its cookie by hand and its scheme where a page's origin would be. Without that, a request
  // with a cookie and no origin is refused, as any is.
  const cookie = `tuti.session_token=${session.token}`;
  expect((await fromApp("/sign-out", { body: {}, cookie, origin: null })).status).toBe(403);
  expect((await fromApp("/sign-out", { body: {}, cookie, origin: "evil://" })).status).toBe(403);
  expect((await fromApp("/sign-out", { body: {}, cookie })).status).toBe(200);
  expect(await projectsOf(session.token)).toMatchObject({ status: 401 });
});

test("only the app's link scheme is trusted, on the app's host, and the web's sign-in hands nothing over", async () => {
  const person = { email: owner.email, name: "Olive Owner" };
  // Another scheme, another site, and a scheme that only starts like the app's: refused before anything starts.
  for (const callbackURL of ["evil://sign-in", "https://evil.example/sign-in", "tutix://sign-in", "tuti.evil://sign-in"]) {
    expect((await continueWithGoogle(person, callbackURL)).status, callbackURL).toBe(403);
    expect((await continueWithGoogle(person, callbackURL, { fromThe: "web" })).status, callbackURL).toBe(403);
  }
  // On a portal's host the scheme means nothing: neither as where to go back to, nor as where a request is from.
  const portal = `${project.slug}.localhost:3100`;
  expect((await fromApp("/sign-in/social", { host: portal, body: { provider: "google", callbackURL: "tuti://sign-in" } })).status).toBe(403);
  expect((await fromApp("/sign-out", { host: portal, body: {}, cookie: owner.cookie })).status).toBe(403);

  // From the web, back to a page of the app's: the browser gets its cookie, and no session rides in the address.
  const web = await continueWithGoogle(person, "/app", { fromThe: "web" });
  expect(web.status).toBe(302);
  expect(web.headers.get("location")).toBe("/app");
  expect(cookiesOf(web)).toContain("tuti.session_token=");
});

test("the browser's first stop takes the sign-in's state and goes on to the provider, and nowhere else", async () => {
  // The app starts Continue with GitHub, then opens the device's browser at the proxy, which gives that browser the
  // state the app's request got and sends it on.
  const started = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: `tuti://sign-in?state=${STATE}` } });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  expect(new URL(url).origin).toBe("https://github.com");
  const proxy = (authorizationURL: string) => fromApp(`/expo-authorization-proxy?${new URLSearchParams({ authorizationURL })}`, { origin: null });
  const onward = await proxy(url);
  expect(onward.status).toBe(302);
  expect(onward.headers.get("location")).toBe(url);
  expect(cookiesOf(onward)).toContain("tuti.state=");
  // Not an open redirect: only to a provider set up here.
  expect((await proxy(`https://evil.example/login/oauth/authorize?state=${new URL(url).searchParams.get("state")}`)).status).toBe(400);
  expect((await proxy("https://github.com.evil.example/login/oauth/authorize?state=x")).status).toBe(400);

  // Never for a sign-in of the web's: a page that sent a visitor here with the state of its own sign-in would have their
  // browser finish it, signed in to the page's account. Nor a state nobody started, or one to put in a cookie as given.
  const web = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: "/app" }, origin: null });
  const webUrl = ((await web.json()) as { url: string }).url;
  const refused = await proxy(webUrl);
  expect(refused.status).toBe(400);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect((await proxy("https://github.com/login/oauth/authorize?state=nobody-started-this")).status).toBe(400);
  // Nor one that ends at the app for an account that exists but on a page for a new one, or for an error.
  for (const elsewhere of [{ newUserCallbackURL: "/app" }, { errorCallbackURL: "/app/auth/sign-in" }]) {
    const mixed = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: `tuti://sign-in?state=${STATE}`, ...elsewhere } });
    expect((await proxy(((await mixed.json()) as { url: string }).url)).status, JSON.stringify(elsewhere)).toBe(400);
  }
  // With each of them the app's, it goes on.
  const all = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: `tuti://sign-in?state=${STATE}`, newUserCallbackURL: "tuti://welcome", errorCallbackURL: "tuti://sign-in" } });
  expect((await proxy(((await all.json()) as { url: string }).url)).status).toBe(302);
  // A value to put in a cookie as given (Better Auth's other way to keep a state) is ignored.
  const planted = await fromApp(`/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: url, oauthState: "anything" })}`, { origin: null });
  expect(cookiesOf(planted)).not.toContain("anything");
  // Nor on to anything but the provider's own address, or a link with a fragment.
  expect((await proxy(url.replace("https://", "http://"))).status).toBe(400);
  expect((await proxy(`${url}#fragment`)).status).toBe(400);
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

/** "Open the app" on that page, on `host`: where its form's post sends the browser. */
async function open(link: URL, state = link.searchParams.get("state") ?? "", host = APP.host) {
  const form = new URLSearchParams({ token: link.searchParams.get("token") ?? "", state });
  const response = await openAppLink(new Request(`http://${host}/app/auth/app-link/open`, { method: "POST", headers: { host }, body: form }));
  expect(response.status).toBe(303);
  return { location: response.headers.get("location") };
}

/** Back on the page, which says the link doesn't work: nothing for the app. */
const NOTHING = { location: "/app/auth/app-link" };

const sentTo = (email: string) => mailbox.emails.filter((e) => e.to.includes(email)).length;

test("the emailed link opens a page that hands the app a session, once, and leaves the browser signed out", async () => {
  const asked = await ask(owner.email);
  expect({ status: asked.status, body: await asked.json() }).toEqual({ status: 200, body: { status: true } });
  const link = await linkTo(owner.email);
  expect(link.origin + link.pathname).toBe(`${APP.origin}/app/auth/app-link`);
  expect(link.searchParams.get("state")).toBe(STATE);

  // Opening it uses nothing up: it says whose account, and waits for the tap.
  expect(await view(link)).toBe(`Sign in to the Tuti app as ${owner.email} Open the app It opens the Tuti app, so use the phone or tablet the app is on.`);
  expect(await view(link)).toContain("Open the app");

  const session = handedOver((await open(link)).location);
  expect(session).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect(await projectsOf(session.token)).toMatchObject({ status: 200, body: { projects: [{ slug: project.slug, role: "OWNER" }] } });
  expect(await prisma.session.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ boundTo: "app" });
  // The browser that opened it (maybe a desk's) gets no cookie: the session is the app's alone.
  expect(request.written).toEqual([]);

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
  // And the app's own does nothing from a portal's host.
  expect(await open(appLink, STATE, `${project.slug}.localhost:3100`)).toEqual(NOTHING);
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
    expect(await open(appLink, state)).toEqual(NOTHING);
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
  // Its own cookie isn't touched, and isn't the app's.
  expect(request.written).toEqual([]);
  expect(/session_token=([^;]+)/.exec(other.cookie)![1]).not.toBe(session.token);
});

test("a verification link never opens the app: anyone can have one sent, and it signs in whoever opens it", async () => {
  const unverified = await signUp("Una Unverified", undefined, { verified: false });
  let link!: URL;
  // However the scheme is written: Better Auth takes it in any case, with or without the slashes.
  for (const scheme of ["tuti://", "TUTI://", "tuti:"]) {
    const sent = await fromApp("/send-verification-email", { body: { email: unverified.email, callbackURL: `${scheme}sign-in?state=${STATE}` } });
    expect(sent.status, scheme).toBe(200);
    const message = await mailbox.latestTo(unverified.email);
    link = new URL(message.text.split(/\s+/).find((word) => word.includes("/verify-email?"))!);
    expect(link.searchParams.get("callbackURL"), scheme).toBe("/app");
  }
  // Opened, it verifies and signs the browser in, on the web: nothing is handed to an app.
  const opened = await fromApp(`/verify-email${link.search}`, { origin: null });
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe("/app");
});
