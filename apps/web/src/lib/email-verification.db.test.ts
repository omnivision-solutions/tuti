import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { configFile } from "@tuti/testkit";
import { expect, test, vi } from "vitest";

import ContinuePage from "@/app/app/(account-pages)/auth/continue/page";
import { actAs, createProject, redirectTarget, signUp as signUpUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { auth, VERIFICATION_SECONDS } from "./auth";
import { getSession } from "@/server/session";

import { PAGE_LANGUAGE_HEADER } from "./language-addresses";
import { BASE_HEADER } from "./portal-base";
import { randomSecret } from "./portal-handoff";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR } from "./sign-in-link";

const APP_URL = process.env.APP_URL!;

/** A POST to Better Auth's `path` on the app, as a browser's: no session. */
const postOnApp = (path: string, body: object) =>
  auth.handler(
    new Request(`${APP_URL}/api/auth/${path}`, {
      method: "POST",
      headers: { host: new URL(APP_URL).host, origin: APP_URL, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** Signs up on the app as its form does. */
async function signUp(callbackURL?: string) {
  const email = `e2e-${randomUUID()}@example.com`;
  expect((await postOnApp("sign-up/email", { email, name: "Ada", password: "correct horse battery staple", callbackURL })).ok).toBe(true);
  return email;
}

/** Every element in a rendered server component's tree (client components aren't rendered further). */
const elements = (node: unknown): React.ReactElement<{ children?: unknown; href?: string }>[] => {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }
  if (!node || typeof node !== "object" || !("props" in node)) {
    return [];
  }
  const element = node as React.ReactElement<{ children?: unknown; href?: string }>;
  return [element, ...elements(element.props.children)];
};

/** All the text in a rendered tree, as it reads. */
const textOf = (node: unknown): string =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : node && typeof node === "object" && "props" in node
        ? textOf((node as React.ReactElement<{ children?: unknown }>).props.children)
        : "";

/** Where the "Continue to <project>" card's button goes, for a page that rendered one (never a redirect by itself). */
async function continueButton(rendered: Promise<unknown>): Promise<string | undefined> {
  const tree = await rendered;
  expect(JSON.stringify((tree as React.ReactElement).props)).toContain("Continue to ");
  return elements(tree).find((element) => element.type === "a")?.props.href;
}

/** The verification link from the latest email to `email`. */
async function verificationLink(email: string) {
  const message = await mailbox.latestTo(email);
  const link = /https?:\/\/\S+\/api\/auth\/verify-email\?[^\s)"<]+/.exec(message.text)?.[0];
  expect(link).toBeDefined();
  return { message, link: new URL(link!.replaceAll("&amp;", "&")) };
}

const isVerified = async (email: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { email }, select: { emailVerified: true } })).emailVerified;

test("signing up sends a verification email; its link verifies the address and signs in", async () => {
  const email = await signUp("/app");
  const { message, link } = await verificationLink(email);
  expect(message.subject).toBe("Verify your email for Tuti");
  expect(message.html).toMatch(/<h1[^>]*>Confirm your email, (<!-- -->)?Ada<\/h1>/);
  expect(await isVerified(email)).toBe(false);

  const response = await auth.handler(new Request(link));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/app");
  expect(response.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
  expect(await isVerified(email)).toBe(true);
});

test("a password account isn't signed in until its address is verified: signing in before sends the link again", async () => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = "correct horse battery staple";
  const signedUp = await postOnApp("sign-up/email", { email, name: "Ada", password, callbackURL: "/app" });
  expect(signedUp.ok).toBe(true);
  expect(signedUp.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
  const first = (await verificationLink(email)).message;

  const early = await postOnApp("sign-in/email", { email, password });
  expect(early.status).toBe(403);
  expect(await early.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  expect(early.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
  const { message, link } = await verificationLink(email);
  expect(message).not.toBe(first);

  await auth.handler(new Request(link, { headers: { host: new URL(APP_URL).host } }));
  const later = await postOnApp("sign-in/email", { email, password });
  expect(later.ok).toBe(true);
  expect(later.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
});

test("signing in before verifying sends a link to where it was going: a portal through a new handoff; none, the app", async () => {
  const project = await createProject(await signUpUser("Owner"));
  const email = await signUp("/app");
  const password = "correct horse battery staple";
  // No way given: the app (Better Auth's "/" is Tuti's cloud's marketing site).
  expect((await postOnApp("sign-in/email", { email, password })).status).toBe(403);
  expect((await verificationLink(email)).link.searchParams.get("callbackURL")).toBe("/app");
  // An invite's page, say: the link comes back to it.
  expect((await postOnApp("sign-in/email", { email, password, callbackURL: "/app/auth/invite/abc" })).status).toBe(403);
  expect((await verificationLink(email)).link.searchParams.get("callbackURL")).toBe("/app/auth/invite/abc");
  // A portal's: its handoff's state is used up by then, so the way back is signed for this account, as signing up's is.
  const state = randomSecret();
  const continuing = `/app/auth/continue?${new URLSearchParams({ portal: project.slug, state, redirect: "/feedback" })}`;
  expect((await postOnApp("sign-in/email", { email, password, callbackURL: continuing })).status).toBe(403);
  const { link } = await verificationLink(email);
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.pathname).toBe("/app/auth/continue");
  expect(Object.fromEntries(back.searchParams)).toEqual({ portal: project.slug, redirect: "/feedback", issued: expect.stringMatching(/^\d+$/), mac: expect.any(String) });
  expect(link.toString()).not.toContain(state);

  // Signed in, the answer doesn't ask the browser to go there (the form does, without reloading the page).
  await auth.handler(new Request(link, { headers: { host: new URL(APP_URL).host } }));
  const signedIn = await postOnApp("sign-in/email", { email, password, callbackURL: "/app" });
  expect(signedIn.ok).toBe(true);
  expect(await signedIn.json()).toMatchObject({ redirect: false });
});

test("signing up with an address that has an account answers as for a new one, and emails its owner a password reset", async () => {
  request.host = new URL(APP_URL).host;
  const subjects = (email: string) => mailbox.emails.filter((e) => e.to.includes(email)).map((e) => e.subject);
  // Someone signed up first with an address that isn't theirs, and never verified it.
  const email = await signUp("/app");
  await verificationLink(email);
  // Its owner signs up: the same answer as a new account, and a password reset, never the verification link, which
  // would let the first password in. Resetting sets theirs (and verifies the address).
  const again = await postOnApp("sign-up/email", { email, name: "Owner", password: "the owner's own password", callbackURL: "/app" });
  expect(again.ok).toBe(true);
  expect(again.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
  await expect.poll(() => subjects(email)).toEqual(["Verify your email for Tuti", "Reset your password"]);
  // Under the emailed links' hourly limit per address: anyone can sign up with it.
  for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR + 2; i++) {
    expect((await postOnApp("sign-up/email", { email, name: "Owner", password: "the owner's own password" })).ok).toBe(true);
  }
  await expect.poll(() => subjects(email).length).toBe(1 + SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);
  expect(await isVerified(email)).toBe(false);

  // Verified: a password reset too, and the account as it was.
  const owner = await signUpUser("Olive");
  expect((await postOnApp("sign-up/email", { email: owner.email, name: "Someone", password: "another password entirely", callbackURL: "/app" })).ok).toBe(true);
  await expect.poll(() => subjects(owner.email).at(-1)).toBe("Reset your password");
  expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { name: true } })).toEqual({ name: "Olive" });
});

test("a session from before its address was verified is no session, on the app or a portal, unless the server sends no email; a single sign-on user's is", async () => {
  const project = await createProject(await signUpUser("Owner"));
  const smtp = process.env.SMTP_HOST;
  const sessionAs = async (user: { id: string; cookie: string }, host: string) => {
    request.host = host;
    actAs(user as never);
    return (await getSession())?.user.id;
  };
  const portalHost = `${project.slug}.localhost:3100`;
  // An unverified password account: its app session, and a portal one ("Continue as", or the previous release's while a
  // deploy overlaps).
  const ada = await signUpUser("Ada", undefined, { verified: false });
  expect(await sessionAs(ada, new URL(APP_URL).host)).toBeUndefined();
  await prisma.session.updateMany({ where: { userId: ada.id }, data: { boundTo: project.id } });
  expect(await sessionAs(ada, portalHost)).toBeUndefined();
  // A single sign-on user's address is the project's app's to vouch for: their portal session works.
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "ada", userId: ada.id } });
  expect(await sessionAs(ada, portalHost)).toBe(ada.id);
  await prisma.ssoIdentity.deleteMany({ where: { userId: ada.id } });
  // A server that sends no email can't verify anyone: sessions work as before.
  vi.stubEnv("SMTP_HOST", "");
  try {
    expect(await sessionAs(ada, portalHost)).toBe(ada.id);
  } finally {
    vi.stubEnv("SMTP_HOST", smtp);
  }
});

test("a tampered link doesn't verify anything", async () => {
  const email = await signUp("/app");
  const { link } = await verificationLink(email);
  link.searchParams.set("token", `${link.searchParams.get("token")}x`);

  const response = await auth.handler(new Request(link));
  expect(response.headers.get("location")).toMatch(/error=/);
  expect(await isVerified(email)).toBe(false);
});

test("with the mail server down, signing up still works but asking to resend, or signing in before verifying, says it failed", async () => {
  const { createServer } = await import("node:net");
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = String((closed.address() as { port: number }).port);
  await new Promise((resolve) => closed.close(resolve));

  const origin = process.env.APP_URL!;
  const email = `e2e-${randomUUID()}@example.com`;
  // Signed out: signing up signs no one in until the address is verified.
  const resend = () =>
    auth.handler(
      new Request(`${origin}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, callbackURL: "/app" }),
      }),
    );

  const workingPort = process.env.SMTP_PORT;
  process.env.SMTP_PORT = closedPort;
  try {
    await auth.api.signUpEmail({ body: { email, name: "Ada", password: "correct horse battery staple" } });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect((await resend()).ok).toBe(false);
    // Not "Check your email" (EMAIL_NOT_VERIFIED): the email didn't go.
    const early = await postOnApp("sign-in/email", { email, password: "correct horse battery staple" });
    expect(early.ok).toBe(false);
    const answer = await early.json();
    expect(answer).toMatchObject({ message: "We couldn't send the email. Try again in a minute." });
    expect(answer.code).not.toBe("EMAIL_NOT_VERIFIED");

    process.env.SMTP_PORT = workingPort;
    expect(await (await postOnApp("sign-in/email", { email, password: "correct horse battery staple" })).json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect((await resend()).ok).toBe(true);
    expect((await mailbox.latestTo(email)).subject).toBe("Verify your email for Tuti");
  } finally {
    process.env.SMTP_PORT = workingPort;
  }
});

test("with SMTP but no EMAIL_FROM, sending fails clearly instead of using someone else's address", async () => {
  const { sendEmail, verifyEmail } = await import("@tuti/email");
  const from = process.env.EMAIL_FROM;
  delete process.env.EMAIL_FROM;
  try {
    await expect(
      sendEmail({ to: "e2e-nobody@example.com", ...verifyEmail({ name: "Ada", url: "https://tuti.example/" }) }),
    ).rejects.toThrow("EMAIL_FROM is not set");
  } finally {
    process.env.EMAIL_FROM = from;
  }
});

test("signed up from a portal, the verification link comes back through a new handoff, not the used one", async () => {
  const project = await createProject(await signUpUser("Owner"));
  // Sent from the portal to the app's sign-up: its way back is this handoff's /continue, with its state.
  const state = randomSecret();
  const email = await signUp(`/app/auth/continue?${new URLSearchParams({ portal: project.slug, state, redirect: "/feedback/ideas" })}`);
  const { message, link } = await verificationLink(email);
  // A portal's reader isn't signing up for Tuti itself: no welcome to it, just the confirmation.
  expect(message.text).not.toMatch(/welcome to tuti/i);
  expect(message.html).toMatch(/<h1[^>]*>Confirm your email, (<!-- -->)?Ada<\/h1>/);
  expect(message.text).toContain("Confirm this is your email to finish signing up.");
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.pathname).toBe("/app/auth/continue");
  // In the state's place, when it was made and the app's MAC for this account: only that starts a new handoff.
  expect(Object.fromEntries(back.searchParams)).toEqual({
    portal: project.slug,
    redirect: "/feedback/ideas",
    issued: expect.stringMatching(/^\d+$/),
    mac: expect.any(String),
  });
  expect(link.toString()).not.toContain(state);

  // Opened later: verified and signed in on the app, then its /continue without a state starts a new handoff on the portal.
  const appHost = new URL(process.env.APP_URL!).host;
  const response = await auth.handler(new Request(link, { headers: { host: appHost } }));
  expect(response.headers.get("location")).toBe(`${back.pathname}${back.search}`);
  expect(await isVerified(email)).toBe(true);
  const ada = { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, email, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  request.host = appHost;
  actAs(ada);
  const page = (query: Record<string, string>) =>
    ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(query) } as PageProps<"/app/auth/continue">);
  const signed = Object.fromEntries(back.searchParams);
  // Not by itself: the card names the portal and its address, and the person clicks on.
  const rendered = await page(signed);
  expect(textOf(rendered)).toContain(`at ${project.slug}.localhost:3100.`);
  expect(await continueButton(Promise.resolve(rendered))).toBe(`http://${project.slug}.localhost:3100/continue?redirect=%2Ffeedback%2Fideas`);

  // Anything else is a link that isn't valid, going nowhere (a portal's address can be its team's own domain or site):
  const notValid = async (query: Record<string, string>) => {
    const rendered = await page(query).catch((error: { digest?: string }) => error.digest);
    expect(JSON.stringify((rendered as React.ReactElement).props)).toContain("Link not valid");
  };
  // unsigned, for a project that exists;
  await notValid({ portal: project.slug, redirect: "/feedback/ideas" });
  // its MAC, with another path, another portal, another time, or bent (in the middle: the last character can be padding);
  await notValid({ ...signed, redirect: "/elsewhere" });
  const other = await createProject(await signUpUser("Other owner"));
  await notValid({ ...signed, portal: other.slug });
  await notValid({ ...signed, issued: String(Number(signed.issued) - 1) });
  const middle = Math.floor(signed.mac!.length / 2);
  await notValid({ ...signed, mac: `${signed.mac!.slice(0, middle)}${signed.mac![middle] === "A" ? "B" : "A"}${signed.mac!.slice(middle + 1)}` });
  // a portal that doesn't exist;
  await notValid({ ...signed, portal: "no-such-project" });
  // the same link with someone else signed in (say its owner's teammate, who lifted it from their own email);
  actAs(await signUpUser("Someone else"));
  await notValid(signed);
  // and, for its account, once it's older than the verification link it came in.
  actAs(ada);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (VERIFICATION_SECONDS + 1) * 1000 });
  try {
    await notValid(signed);
  } finally {
    vi.useRealTimers();
  }
  expect(await continueButton(page(signed))).toContain("/continue?redirect=");

  // Opened again, signed out on the app (the address is verified, so it doesn't sign in): verified, back to the same
  // /continue, which asks to sign in first and then checks the MAC for whoever did.
  const again = await auth.handler(new Request(link, { headers: { host: appHost } }));
  expect(again.headers.get("location")).toBe(`${back.pathname}${back.search}`);
  expect(again.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
  actAs(null);
  const signIn = new URL(await redirectTarget(page(signed)), APP_URL);
  expect(signIn.pathname).toBe("/app/auth/sign-in");
  expect(signIn.searchParams.get("next")).toBe(`/app/auth/continue?${new URLSearchParams({ portal: project.slug, redirect: signed.redirect!, issued: signed.issued!, mac: signed.mac! })}`);
  actAs(ada);
  expect(await continueButton(page(Object.fromEntries(new URL(signIn.searchParams.get("next")!, APP_URL).searchParams)))).toBe(
    `http://${project.slug}.localhost:3100/continue?redirect=%2Ffeedback%2Fideas`,
  );
});

test("a way back someone gets signed by signing up with a hand-picked callback works for nobody else", async () => {
  // Their own project (whose address they may run), and a sign-up through the API asking for a way back there.
  const theirs = await createProject(await signUpUser("Owner"));
  const email = await signUp(`/app/auth/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}`);
  const { link } = await verificationLink(email);
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.searchParams.get("mac")).toBeTruthy();

  // Sent to anyone else: signed in as someone else, not valid; signed out, asked to sign in (and then, as anyone but
  // that account, not valid). Never a redirect to that address.
  request.host = new URL(APP_URL).host;
  const open = () =>
    ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/app/auth/continue">).catch(
      (error: { digest?: string }) => error.digest,
    );
  actAs(await signUpUser("Someone else"));
  expect(JSON.stringify(((await open()) as React.ReactElement).props)).toContain("Link not valid");
  actAs(null);
  expect(await open()).toMatch(/^NEXT_REDIRECT;[^;]+;\/app\/auth\/sign-in\?next=%2Fapp%2Fauth%2Fcontinue%3F/);
});

test("asking for a verification email again never signs a way back: anyone can ask, for anyone's address", async () => {
  // Bea signed up on the app and hasn't verified; someone else asks for her email again, with a way back to their portal.
  const email = await signUp("/app");
  const theirs = await createProject(await signUpUser("Owner"));
  const asked = await postOnApp("send-verification-email", { email, callbackURL: `/app/auth/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}` });
  expect(asked.ok).toBe(true);
  const { link } = await verificationLink(email);
  // No way back to the portal in it: the app.
  expect(link.searchParams.get("callbackURL")).toBe("/app");
  expect(link.toString()).not.toContain(theirs.slug);

  // Bea opens it: verified and signed in, on the app, not that portal.
  const response = await auth.handler(new Request(link, { headers: { host: new URL(APP_URL).host } }));
  expect(response.headers.get("location")).toBe("/app");
  expect(await isVerified(email)).toBe(true);
});

test("someone else's address signed up with a hand-picked callback: its own verify click shows the card, never a redirect", async () => {
  // Whoever signs up an address chooses the way back, and the inbox's owner's click signs that account in.
  const theirs = await createProject(await signUpUser("Owner"));
  const email = await signUp(`/app/auth/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}`);
  const { link } = await verificationLink(email);
  const appHost = new URL(APP_URL).host;
  const verified = await auth.handler(new Request(link, { headers: { host: appHost } }));
  const back = new URL(verified.headers.get("location")!, APP_URL);
  const id = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  actAs({ id, email, cookie: verified.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
  request.host = appHost;

  // As that account: a page saying where it goes, with a button, not a redirect.
  const rendered = ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/app/auth/continue">);
  const outcome = await rendered.then(
    (tree) => ({ tree }),
    (error: { digest?: string }) => ({ redirect: error.digest }),
  );
  expect(outcome).not.toHaveProperty("redirect");
  expect(JSON.stringify(((outcome as { tree: React.ReactElement }).tree).props)).toContain(`["Continue to ","${theirs.name}"]`);
  expect(await continueButton(Promise.resolve((outcome as { tree: unknown }).tree))).toBe(`http://${theirs.slug}.localhost:3100/continue?redirect=%2F`);
});

test("asked again on a portal (Resend email), the verification email is in its page's language while the portal serves it, else its default; on the app, English", async () => {
  const project = await createProject(await signUpUser("Owner"));
  await prisma.projectLanguage.create({ data: { projectId: project.id, code: "de", live: true, automatic: false } });
  const ada = await signUpUser("Ada", undefined, { verified: false });
  const origin = `http://${project.slug}.localhost:3100`;
  /** Resend email on `at`, as its button does: saying the page's language (PAGE_LANGUAGE_HEADER). */
  const resendAt = async (at: string, language: string, more: Record<string, string> = {}) => {
    const response = await auth.handler(
      new Request(`${at}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { host: new URL(at).host, origin: at, "content-type": "application/json", [PAGE_LANGUAGE_HEADER]: language, ...more },
        body: JSON.stringify({ email: ada.email, callbackURL: "/account" }),
      }),
    );
    expect(response.ok, await response.clone().text()).toBe(true);
    return (await mailbox.latestTo(ada.email)).subject;
  };
  expect(await resendAt(origin, "de")).toBe("Bestätige deine E-Mail-Adresse für Tuti");
  // A language it doesn't serve (any word a browser sends): its default's.
  expect(await resendAt(origin, "fr")).toBe("Verify your email for Tuti");
  await prisma.project.update({ where: { id: project.id }, data: { language: "de" } });
  await prisma.projectLanguage.deleteMany({ where: { projectId: project.id } });
  expect(await resendAt(origin, "fr")).toBe("Bestätige deine E-Mail-Adresse für Tuti");
  // The app's (its sign-up and sign-in pages, a portal's password sign-up included): English, whatever it says.
  expect(await resendAt(APP_URL, "de")).toBe("Verify your email for Tuti");
  // Tuti's own portal, under its path on the app's host (the proxy says so with BASE_HEADER): a portal's.
  vi.stubEnv("TUTI_CONFIG", configFile({ ownPortal: { project: project.slug } }));
  try {
    expect(await resendAt(APP_URL, "fr", { [BASE_HEADER]: `/${project.slug}` })).toBe("Bestätige deine E-Mail-Adresse für Tuti");
  } finally {
    vi.unstubAllEnvs();
  }
});
