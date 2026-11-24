import { createHash, randomBytes, randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { convert } from "html-to-text";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

// Continue with Google is set up when the auth config is read, so its fake starts before anything imports it.
const google = await vi.hoisted(async () => {
  const { startGoogleFake } = await import("@tuti/testkit");
  const fake = await startGoogleFake();
  // GitHub too, at its real address: nothing here fetches it.
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
 * redirect to the app's link scheme that carries a code and nothing of the session; the app that started the sign-in
 * exchanges the code, with the verifier of the challenge it started with, for a session that works on the API. Only
 * that scheme, on the app's host; no account is made from the app; and the web's own sign-in is as before.
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

/** What the app makes up before a sign-in: a verifier it keeps, and the challenge (its SHA-256) it starts with. */
function newProof() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type Sent = { body?: unknown; cookie?: string; host?: string; origin?: string | null; headers?: Record<string, string> };

/** A request to Better Auth as the mobile app sends them: no Origin, its scheme in `expo-origin`, cookies by hand. */
function fromApp(path: string, { body, cookie, host = APP.host, origin = "tuti://", headers }: Sent = {}) {
  return auth.handler(
    new Request(`http://${host}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host, ...(origin && { "expo-origin": origin }), ...(cookie && { cookie }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** What a redirect to the app carries: where, the state, and a code or an error. Never anything of the session. */
function handedOver(location: string | null) {
  const url = new URL(location ?? "");
  expect([...url.searchParams.keys()].filter((key) => !["state", "code", "error", "error_description"].includes(key))).toEqual([]);
  expect(location).not.toMatch(/session_token|cookie/i);
  return { to: `${url.protocol}//${url.host}${url.pathname}`, state: url.searchParams.get("state"), error: url.searchParams.get("error"), code: url.searchParams.get("code") };
}

/** The app's last step: the code and its verifier for the session. */
async function exchange(code: string | null, verifier: string, sent: Sent = {}) {
  const response = await fromApp("/app/session", { ...sent, body: { code, verifier } });
  return { status: response.status, body: (await response.json()) as { token?: string; cookie?: string; code?: string } };
}

const REFUSED = { status: 401, body: { code: "INVALID_CODE" } };

/** The projects the API lists for a session token: what the app does first with one. */
async function projectsOf(token: string | undefined) {
  const response = await listProjects(new Request(`${APP.origin}/api/v1/projects`, { headers: { host: APP.host, authorization: `Bearer ${token}` } }));
  return { status: response.status, body: await response.json() };
}

const sessionsOf = (userId: string) => prisma.session.count({ where: { userId } });
/** How many codes and links' challenges are kept: what a sign-in for the app leaves behind. */
const keptForApp = () => prisma.verification.count({ where: { identifier: { startsWith: "app-sign-in-" } } });

type Start = { fromThe?: "app" | "web"; challenge?: unknown; more?: Record<string, unknown>; before?: (state: string) => Promise<void>; throughProxy?: boolean };

/**
 * Continue with Google as `person`, back to `callbackURL`: the response of Google's redirect back to Tuti. From the app,
 * its own request starts it, with a challenge, and the device's browser goes through the proxy for the sign-in's state; a
 * page's browser starts it itself.
 */
async function continueWithGoogle(person: { email: string; name: string }, callbackURL: string, { fromThe = "app", challenge, more, before, throughProxy = fromThe === "app" }: Start = {}) {
  const started = await fromApp("/sign-in/social", {
    body: { provider: "google", callbackURL, ...(challenge !== undefined && { additionalData: { challenge } }), ...more },
    origin: fromThe === "app" ? "tuti://" : null,
  });
  if (started.status !== 200) {
    return started;
  }
  const { url } = (await started.json()) as { url: string };
  await before?.(new URL(url).searchParams.get("state")!);
  let browser = cookiesOf(started);
  if (throughProxy) {
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

const BACK = `tuti://sign-in?state=${STATE}`;
const olive = () => ({ email: owner.email, name: "Olive Owner" });

/** Olive continues with Google from the app, as far as the redirect to it. */
async function signedInWithGoogle(proof = newProof()) {
  const back = await continueWithGoogle(olive(), BACK, { challenge: proof.challenge });
  expect(back.status).toBe(302);
  // The browser it went through keeps no session.
  expect(back.headers.getSetCookie()).toEqual([]);
  return { ...handedOver(back.headers.get("location")), ...proof };
}

test("Continue with Google from the app ends at the app's link with a code, which the app exchanges once for a session", async () => {
  const signIn = await signedInWithGoogle();
  expect(signIn).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect(signIn.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Kept hashed, with the session's token as the session table has it: neither the code nor the bearer token is in the database.
  const kept = await prisma.verification.findMany({ where: { identifier: { startsWith: "app-sign-in-code:" } }, orderBy: { createdAt: "desc" }, take: 1 });
  expect(kept[0]!.identifier).toMatch(/^app-sign-in-code:[0-9a-f]{64}$/);
  expect(kept[0]!.expiresAt.getTime() - kept[0]!.createdAt.getTime()).toBeLessThanOrEqual(120_000);
  expect(JSON.stringify(kept)).not.toContain(signIn.code!);

  const { status, body } = await exchange(signIn.code, signIn.verifier);
  expect(status).toBe(200);
  expect(body.cookie).toBe(`tuti.session_token=${body.token}`);
  expect(JSON.stringify(kept)).not.toContain(decodeURIComponent(body.token!));
  // The token on the API, the cookie on Better Auth itself.
  expect(await projectsOf(body.token)).toEqual({ status: 200, body: { projects: [{ slug: project.slug, name: project.name, role: "OWNER", openConversations: 0 }] } });
  expect(await (await fromApp("/get-session", { cookie: body.cookie })).json()).toMatchObject({ user: { id: owner.id }, session: { boundTo: "app" } });
  // The app's own session, like one from the web's sign-in: nothing of Google's kept.
  expect(await prisma.account.findFirstOrThrow({ where: { userId: owner.id, providerId: "google" } })).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });

  // Signing out from the app: its cookie by hand and its scheme where a page's origin would be. Without that, a request
  // with a cookie and no origin is refused, as any is.
  expect((await fromApp("/sign-out", { body: {}, cookie: body.cookie, origin: null })).status).toBe(403);
  expect((await fromApp("/sign-out", { body: {}, cookie: body.cookie, origin: "evil://" })).status).toBe(403);
  expect((await fromApp("/sign-out", { body: {}, cookie: body.cookie })).status).toBe(200);
  expect(await projectsOf(body.token)).toMatchObject({ status: 401 });
});

test("a code works once, with its verifier, for two minutes: anything else is refused and ends the session behind it", async () => {
  // Used again: someone else has it, so the session it gave goes.
  const again = await signedInWithGoogle();
  const first = await exchange(again.code, again.verifier);
  expect(await projectsOf(first.body.token)).toMatchObject({ status: 200 });
  expect(await exchange(again.code, again.verifier)).toMatchObject(REFUSED);
  expect(await projectsOf(first.body.token)).toMatchObject({ status: 401 });

  // The wrong verifier (another app got the redirect): no session, and none left for the right one either.
  const before = await sessionsOf(owner.id);
  const stolen = await signedInWithGoogle();
  expect(await sessionsOf(owner.id)).toBe(before + 1);
  for (const guess of [newProof().verifier, stolen.challenge, ""]) {
    expect(await exchange(stolen.code, guess)).toMatchObject(REFUSED);
    expect(await sessionsOf(owner.id)).toBe(before);
  }
  expect(await exchange(stolen.code, stolen.verifier)).toMatchObject(REFUSED);

  // Too old, even with the right verifier.
  const late = await signedInWithGoogle();
  await prisma.verification.updateMany({ where: { identifier: { startsWith: "app-sign-in-code:" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await exchange(late.code, late.verifier)).toMatchObject(REFUSED);
  expect(await sessionsOf(owner.id)).toBe(before);

  // A code nobody was given, and a post without one.
  expect(await exchange(randomBytes(32).toString("base64url"), late.verifier)).toMatchObject(REFUSED);
  expect((await fromApp("/app/session", { body: { verifier: late.verifier } })).status).toBe(400);
});

test("the exchange is limited per visitor", async () => {
  const context = await auth.$context;
  context.rateLimit.enabled = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    context.rateLimit.enabled = false;
    vi.useRealTimers();
  });
  const from = (ip: string) => exchange("no-such-code", "no-such-verifier", { headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < 10; i++) {
    expect((await from("203.0.113.7")).status).toBe(401);
  }
  expect((await from("203.0.113.7")).status).toBe(429);
  expect((await from("203.0.113.8")).status).toBe(401);
});

test("a sign-in from the app starts with a challenge, or not at all", async () => {
  const before = await sessionsOf(owner.id);
  const kept = await keptForApp();
  // None, or one that isn't a SHA-256 in base64url: refused before anything starts.
  for (const challenge of [undefined, "", "short", newProof().verifier + "=", 42]) {
    const started = await continueWithGoogle(olive(), BACK, { challenge });
    expect({ status: started.status, body: await started.json() }, String(challenge)).toMatchObject({ status: 400, body: { code: "CHALLENGE_REQUIRED" } });
  }
  // Back to the app only for a new account or an error counts as the app's too: it comes back to the app, with a challenge.
  for (const more of [{ newUserCallbackURL: "tuti://welcome" }, { errorCallbackURL: "tuti://sign-in" }]) {
    expect((await continueWithGoogle(olive(), "/app", { fromThe: "web", more })).status).toBe(400);
    expect((await continueWithGoogle(olive(), "/app", { fromThe: "web", more, challenge: newProof().challenge })).status).toBe(400);
  }
  // One that reached Google's way back with no challenge kept (nothing starts one now) gives the app an error and no session.
  const { challenge } = newProof();
  const without = await continueWithGoogle(olive(), BACK, {
    challenge,
    throughProxy: false,
    before: async (state) => {
      const row = await prisma.verification.findFirstOrThrow({ where: { identifier: `auth-state:${state}` } });
      const kept = JSON.parse(row.value) as { serverContext?: unknown };
      delete kept.serverContext;
      await prisma.verification.update({ where: { id: row.id }, data: { value: JSON.stringify(kept) } });
    },
  });
  expect(handedOver(without.headers.get("location"))).toMatchObject({ to: "tuti://sign-in", state: STATE, error: "challenge_required", code: null });
  expect(without.headers.getSetCookie()).toEqual([]);
  expect(await sessionsOf(owner.id)).toBe(before);
  expect(await keptForApp()).toBeLessThanOrEqual(kept);
});

test("the app signs in accounts that exist: someone new is sent back with an error and gets no account, as the web still gives one", async () => {
  const newcomer = { email: newAddress(), name: "Nora New" };
  const refused = await continueWithGoogle(newcomer, BACK, { challenge: newProof().challenge });
  expect(refused.status).toBe(302);
  expect(handedOver(refused.headers.get("location"))).toMatchObject({ to: "tuti://sign-in", state: STATE, error: "signup_disabled", code: null });
  expect(refused.headers.getSetCookie().filter((cookie) => cookie.includes("session_token"))).toEqual([]);
  expect(await prisma.user.count({ where: { email: newcomer.email } })).toBe(0);
  // Whatever the start says: asking to sign up is the web's to do.
  const asking = await continueWithGoogle(newcomer, BACK, { challenge: newProof().challenge, more: { requestSignUp: true } });
  expect(handedOver(asking.headers.get("location"))).toMatchObject({ error: "signup_disabled", code: null });
  expect(await prisma.user.count({ where: { email: newcomer.email } })).toBe(0);

  // From the web, the same person signs up, as before: an account, the browser's cookie, and on to the page.
  const web = await continueWithGoogle(newcomer, "/app", { fromThe: "web" });
  expect(web.status).toBe(302);
  expect(web.headers.get("location")).toBe("/app");
  expect(cookiesOf(web)).toContain("tuti.session_token=");
  expect(await prisma.user.findUniqueOrThrow({ where: { email: newcomer.email } })).toMatchObject({ name: "Nora New", emailVerified: true });
  // What a web start says of itself changes nothing either, and neither does naming a challenge without a way back
  // to the app: the sign-in is the web's, as before.
  for (const more of [{ requestSignUp: false }, { additionalData: { challenge: newProof().challenge, app: { challenge: "x" } } }]) {
    const other = { email: newAddress(), name: "Otto Other" };
    expect((await continueWithGoogle(other, "/app", { fromThe: "web", more })).headers.get("location"), JSON.stringify(more)).toBe("/app");
    expect(await prisma.user.count({ where: { email: other.email } })).toBe(1);
  }
  // And with the account made, the app signs them in.
  const proof = newProof();
  const back = await continueWithGoogle(newcomer, BACK, { challenge: proof.challenge });
  expect((await exchange(handedOver(back.headers.get("location")).code, proof.verifier)).status).toBe(200);
});

test("only the app's link scheme is trusted, on the app's host, and the web's sign-in hands nothing over", async () => {
  const { challenge } = newProof();
  const kept = await keptForApp();
  // Another scheme, another site, and a scheme that only starts like the app's: refused before anything starts.
  for (const callbackURL of ["evil://sign-in", "https://evil.example/sign-in", "tutix://sign-in", "tuti.evil://sign-in"]) {
    expect((await continueWithGoogle(olive(), callbackURL, { challenge })).status, callbackURL).toBe(403);
    expect((await continueWithGoogle(olive(), callbackURL, { fromThe: "web" })).status, callbackURL).toBe(403);
  }
  // On a portal's host the scheme means nothing: neither as where to go back to, nor as where a request is from.
  const portal = `${project.slug}.localhost:3100`;
  expect((await fromApp("/sign-in/social", { host: portal, body: { provider: "google", callbackURL: "tuti://sign-in", additionalData: { challenge } } })).status).toBe(403);
  expect((await fromApp("/sign-out", { host: portal, body: {}, cookie: owner.cookie })).status).toBe(403);

  // From the web, back to a page of the app's: the browser gets its cookie, and nothing rides in the address.
  const web = await continueWithGoogle(olive(), "/app", { fromThe: "web" });
  expect(web.status).toBe(302);
  expect(web.headers.get("location")).toBe("/app");
  expect(cookiesOf(web)).toContain("tuti.session_token=");
  expect(await keptForApp()).toBe(kept);
});

test("the browser's first stop takes the sign-in's state and goes on to the provider, and nowhere else", async () => {
  const additionalData = { challenge: newProof().challenge };
  // The app starts Continue with GitHub, then opens the device's browser at the proxy, which gives that browser the
  // state the app's request got and sends it on.
  const started = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: BACK, additionalData } });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  expect(new URL(url).origin).toBe("https://github.com");
  const proxy = (authorizationURL: string) => fromApp(`/expo-authorization-proxy?${new URLSearchParams({ authorizationURL })}`, { origin: null });
  const onward = await proxy(url);
  expect(onward.status).toBe(302);
  expect(onward.headers.get("location")).toBe(url);
  expect(cookiesOf(onward)).toContain("tuti.state=");
  // Not an open redirect, to another site or within the provider's: the address is the one the start gave, to the
  // letter, and the browser goes to the one the server makes again. Another page of GitHub's, another app's consent
  // there (its client, its own way back), a parameter more or less: refused, and no state is given to the browser.
  const state = new URL(url).searchParams.get("state")!;
  const changed = (change: (to: URL) => void) => {
    const to = new URL(url);
    change(to);
    return to.toString();
  };
  for (const elsewhere of [
    `https://evil.example/login/oauth/authorize?state=${state}`,
    `https://github.com.evil.example/login/oauth/authorize?state=${state}`,
    `https://github.com/attacker/repository?state=${state}`,
    changed((to) => (to.pathname = "/attacker/repository")),
    changed((to) => to.searchParams.set("client_id", "the-attackers-own-app")),
    changed((to) => to.searchParams.set("redirect_uri", "https://evil.example/callback")),
    changed((to) => to.searchParams.delete("redirect_uri")),
    changed((to) => to.searchParams.set("login", "someone")),
    changed((to) => to.searchParams.set("scope", "repo")),
  ]) {
    const refused = await proxy(elsewhere);
    expect(refused.status, elsewhere).toBe(400);
    expect(refused.headers.getSetCookie(), elsewhere).toEqual([]);
  }
  // Nor does a start from the app put anything of its own into the provider's address.
  for (const extra of [{ additionalParams: { login: "someone" } }, { scopes: ["repo"] }, { loginHint: "someone@example.com" }]) {
    expect((await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: BACK, additionalData, ...extra } })).status, JSON.stringify(extra)).toBe(400);
  }
  // Nor does what it says of the provider in its extra data count: the one it started with is kept, where only the server writes.
  const lying = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: BACK, additionalData: { ...additionalData, provider: "google", serverContext: { app: { provider: "google" } } } } });
  const lyingUrl = ((await lying.json()) as { url: string }).url;
  expect((await proxy(lyingUrl)).headers.get("location")).toBe(lyingUrl);
  expect(new URL(lyingUrl).origin).toBe("https://github.com");

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
    const mixed = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: BACK, additionalData, ...elsewhere } });
    expect((await proxy(((await mixed.json()) as { url: string }).url)).status, JSON.stringify(elsewhere)).toBe(400);
  }
  // With each of them the app's, it goes on.
  const all = await fromApp("/sign-in/social", { body: { provider: "github", callbackURL: BACK, additionalData, newUserCallbackURL: "tuti://welcome", errorCallbackURL: "tuti://sign-in" } });
  expect((await proxy(((await all.json()) as { url: string }).url)).status).toBe(302);
  // A value to put in a cookie as given (Better Auth's other way to keep a state) is ignored.
  const planted = await fromApp(`/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: url, oauthState: "anything" })}`, { origin: null });
  expect(cookiesOf(planted)).not.toContain("anything");
  // Nor on to anything but the provider's own address, or a link with a fragment.
  expect((await proxy(url.replace("https://", "http://"))).status).toBe(400);
  expect((await proxy(`${url}#fragment`)).status).toBe(400);
  expect((await proxy("not an address")).status).toBe(400);
});

/** Asks for the app's sign-in link as the app does. */
const ask = (email: string, { state = STATE as unknown, challenge = newProof().challenge as unknown, host = undefined as string | undefined } = {}) =>
  fromApp("/app/sign-in-link", { host, body: { email, state, challenge } });

/** The link in the latest "Sign in to Tuti" email to `email`. */
async function linkTo(email: string) {
  const message = await mailbox.latestTo(email);
  expect(message.subject).toBe("Sign in to Tuti");
  return new URL(message.text.split(/\s+/).find((word) => word.includes("/app/auth/app-link?"))!);
}

/** The page the link opens, as text. */
async function view(link: URL) {
  const page = await AppSignInLinkPage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(link.searchParams)) } as PageProps<"/app/auth/app-link">);
  const text = convert(renderToStaticMarkup(page), { wordwrap: false, selectors: [1, 2, 3].map((level) => ({ selector: `h${level}`, options: { uppercase: false } })) });
  return text.replace(/\s+/g, " ").trim();
}

/** "Open the app" on that page, on `host`: where its form's post sends the browser. */
async function open(link: URL, { host = APP.host, more = {} as Record<string, string> } = {}) {
  const form = new URLSearchParams({ token: link.searchParams.get("token") ?? "", ...more });
  const response = await openAppLink(new Request(`http://${host}/app/auth/app-link/open`, { method: "POST", headers: { host }, body: form }));
  expect(response.status).toBe(303);
  return { location: response.headers.get("location") };
}

/** Back on the page, which says the link doesn't work: nothing for the app. */
const NOTHING = { location: "/app/auth/app-link" };

const sentTo = (email: string) => mailbox.emails.filter((e) => e.to.includes(email)).length;

test("the emailed link opens a page that sends the app a code, once, and leaves the browser signed out", async () => {
  const { verifier, challenge } = newProof();
  const asked = await ask(owner.email, { challenge });
  expect({ status: asked.status, body: await asked.json() }).toEqual({ status: 200, body: { status: true } });
  const link = await linkTo(owner.email);
  expect(link.origin + link.pathname).toBe(`${APP.origin}/app/auth/app-link`);
  // Nothing of what the app asked with is in the link: it's kept with it.
  expect([...link.searchParams.keys()]).toEqual(["token"]);
  expect(link.href).not.toContain(challenge);

  // Opening it uses nothing up: it says whose account, and waits for the tap.
  expect(await view(link)).toBe(`Sign in to the Tuti app as ${owner.email} Open the app It opens the Tuti app, so use the phone or tablet the app is on.`);
  expect(await view(link)).toContain("Open the app");

  const before = await sessionsOf(owner.id);
  const redirect = handedOver((await open(link)).location);
  expect(redirect).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  // The browser that opened it (maybe a desk's) gets no cookie: the session is the app's alone.
  expect(request.written).toEqual([]);
  const { status, body } = await exchange(redirect.code, verifier);
  expect(status).toBe(200);
  expect(await projectsOf(body.token)).toMatchObject({ status: 200, body: { projects: [{ slug: project.slug, role: "OWNER" }] } });
  expect(await prisma.session.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } })).toMatchObject({ boundTo: "app" });

  // Used once: again, the app is told so and gets no code, and the page says to ask for a new one.
  expect(handedOver((await open(link)).location)).toMatchObject({ to: "tuti://sign-in", state: STATE, error: "INVALID_TOKEN", code: null });
  expect(await view(link)).toBe("This link doesn't work any more It was used already, or it has expired. Ask for a new one in the Tuti app.");
  expect(await sessionsOf(owner.id)).toBe(before + 1);

  // Someone who asked for a link to this address and isn't the app that opens it: their code is no use without the
  // verifier, and the try ends the session.
  await ask(owner.email, { challenge });
  const taken = handedOver((await open(await linkTo(owner.email))).location);
  expect(await exchange(taken.code, newProof().verifier)).toMatchObject(REFUSED);
  expect(await sessionsOf(owner.id)).toBe(before + 1);
});

test("a link signs in an account only: no address is told apart, and none signs up", async () => {
  const stranger = newAddress();
  const asked = await ask(stranger);
  expect({ status: asked.status, body: await asked.json() }).toEqual({ status: 200, body: { status: true } });
  expect(sentTo(stranger)).toBe(0);
  expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);

  // Malformed asks, one without a challenge, and a portal's host are refused; so is a server that sends no email.
  expect((await ask("not-an-address")).status).toBe(400);
  expect((await ask(owner.email, { state: "short" })).status).toBe(400);
  expect((await ask(owner.email, { state: "tuti://evil?state=0123456789" })).status).toBe(400);
  for (const challenge of [null, "", "short", newProof().verifier + "="]) {
    expect((await ask(owner.email, { challenge })).status, String(challenge)).toBe(400);
  }
  expect((await ask(owner.email, { host: `${project.slug}.localhost:3100` })).status).toBe(400);
  expect((await withoutEmail(() => ask(owner.email))).status).toBe(400);
  expect(sentTo(owner.email)).toBe(0);

  // An account deleted since the link was sent isn't made again by it.
  const gone = await signUp("Greta Gone");
  await ask(gone.email);
  const link = await linkTo(gone.email);
  await prisma.user.delete({ where: { id: gone.id } });
  expect(handedOver((await open(link)).location)).toMatchObject({ error: "INVALID_TOKEN", code: null });
  expect(await prisma.user.count({ where: { email: gone.email } })).toBe(0);

  // Under the limits every emailed link shares.
  for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR; i++) {
    expect((await ask(owner.email)).status).toBe(200);
  }
  expect((await ask(owner.email)).status).toBe(429);
  expect(sentTo(owner.email)).toBe(SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);
});

test("the app's link and a portal's are never each other's, and where it goes back to isn't the form's to say", async () => {
  const { verifier, challenge } = newProof();
  await ask(owner.email, { challenge });
  const appLink = await linkTo(owner.email);
  // On the portal's own confirm, the app's token is a dead link.
  request.host = `${project.slug}.localhost:3100`;
  const onPortal = new FormData();
  onPortal.set("token", appLink.searchParams.get("token")!);
  onPortal.set("next", "/");
  expect(await confirmSignInLink(onPortal)).toEqual({ location: "/sign-in?link=failed" });
  // And the app's own does nothing from a portal's host.
  expect(await open(appLink, { host: `${project.slug}.localhost:3100` })).toEqual(NOTHING);
  request.host = APP.host;

  // A portal's link, opened as if it were the app's: nothing for the app, and no account from it.
  const reader = newAddress();
  const form = new FormData();
  form.set("email", reader);
  await emailSignInLink(project.slug, "/", form);
  const portalLink = new URL((await mailbox.latestTo(reader)).text.split(/\s+/).find((word) => word.includes("/sign-in/link?"))!);
  expect(await view(portalLink)).toContain("This link doesn't work any more");
  expect(await open(portalLink)).toEqual(NOTHING);
  expect(await prisma.user.count({ where: { email: reader } })).toBe(0);
  expect(await open(new URL(`${APP.origin}/app/auth/app-link?token=${"x".repeat(200)}`))).toEqual(NOTHING);

  // The app's link still works after all of that, and goes back with the state it was asked with whatever the form adds.
  const redirect = handedOver((await open(appLink, { more: { state: "another-state-0123456789", callbackURL: "tuti://elsewhere", challenge: newProof().challenge } })).location);
  expect(redirect).toMatchObject({ to: "tuti://sign-in", state: STATE, error: null });
  expect((await exchange(redirect.code, verifier)).status).toBe(200);
});

test("a browser signed in to the web app stays signed in as it was when it opens the app's link", async () => {
  const other = await signUp("Wes Web");
  const { verifier, challenge } = newProof();
  await ask(owner.email, { challenge });
  // Wes's browser opens Olive's link (a shared desk): the app gets Olive's session, the browser keeps Wes's.
  actAs(other);
  const redirect = handedOver((await open(await linkTo(owner.email))).location);
  const { body } = await exchange(redirect.code, verifier);
  expect(await projectsOf(body.token)).toMatchObject({ status: 200, body: { projects: [{ slug: project.slug }] } });
  // Its own cookie isn't touched, and isn't the app's.
  expect(request.written).toEqual([]);
  expect(/session_token=([^;]+)/.exec(other.cookie)![1]).not.toBe(body.token);
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
