import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import ContinuePage from "@/app/(marketing)/continue/page";
import { actAs, createProject, redirectTarget, signUp as signUpUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { auth, VERIFICATION_SECONDS } from "./auth";
import { randomSecret } from "./portal-handoff";

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
  expect(message.text).toContain("Hi Ada,");
  expect(await isVerified(email)).toBe(false);

  const response = await auth.handler(new Request(link));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/app");
  expect(response.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
  expect(await isVerified(email)).toBe(true);
});

test("a tampered link doesn't verify anything", async () => {
  const email = await signUp("/app");
  const { link } = await verificationLink(email);
  link.searchParams.set("token", `${link.searchParams.get("token")}x`);

  const response = await auth.handler(new Request(link));
  expect(response.headers.get("location")).toMatch(/error=/);
  expect(await isVerified(email)).toBe(false);
});

test("with the mail server down, signing up still works but asking to resend says it failed", async () => {
  const { createServer } = await import("node:net");
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = String((closed.address() as { port: number }).port);
  await new Promise((resolve) => closed.close(resolve));

  const origin = process.env.APP_URL!;
  const email = `e2e-${randomUUID()}@example.com`;
  const resend = (cookie: string) =>
    auth.handler(
      new Request(`${origin}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ email, callbackURL: "/app" }),
      }),
    );

  const workingPort = process.env.SMTP_PORT;
  process.env.SMTP_PORT = closedPort;
  try {
    const { headers } = await auth.api.signUpEmail({
      body: { email, name: "Ada", password: "correct horse battery staple" },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect((await resend(cookie)).ok).toBe(false);

    process.env.SMTP_PORT = workingPort;
    expect((await resend(cookie)).ok).toBe(true);
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
  const email = await signUp(`/continue?${new URLSearchParams({ portal: project.slug, state, redirect: "/feedback/ideas" })}`);
  const { link } = await verificationLink(email);
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.pathname).toBe("/continue");
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
    ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(query) } as PageProps<"/continue">);
  const signed = Object.fromEntries(back.searchParams);
  // Not by itself: the card names the portal and its address, and the person clicks on.
  const rendered = await page(signed);
  expect(JSON.stringify((rendered as React.ReactElement).props)).toContain(`at ${project.slug}.localhost:3100.`);
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
  expect(signIn.pathname).toBe("/sign-in");
  expect(signIn.searchParams.get("next")).toBe(`/continue?${new URLSearchParams({ portal: project.slug, redirect: signed.redirect!, issued: signed.issued!, mac: signed.mac! })}`);
  actAs(ada);
  expect(await continueButton(page(Object.fromEntries(new URL(signIn.searchParams.get("next")!, APP_URL).searchParams)))).toBe(
    `http://${project.slug}.localhost:3100/continue?redirect=%2Ffeedback%2Fideas`,
  );
});

test("a way back someone gets signed by signing up with a hand-picked callback works for nobody else", async () => {
  // Their own project (whose address they may run), and a sign-up through the API asking for a way back there.
  const theirs = await createProject(await signUpUser("Owner"));
  const email = await signUp(`/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}`);
  const { link } = await verificationLink(email);
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.searchParams.get("mac")).toBeTruthy();

  // Sent to anyone else: signed in as someone else, not valid; signed out, asked to sign in (and then, as anyone but
  // that account, not valid). Never a redirect to that address.
  request.host = new URL(APP_URL).host;
  const open = () =>
    ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/continue">).catch(
      (error: { digest?: string }) => error.digest,
    );
  actAs(await signUpUser("Someone else"));
  expect(JSON.stringify(((await open()) as React.ReactElement).props)).toContain("Link not valid");
  actAs(null);
  expect(await open()).toMatch(/^NEXT_REDIRECT;[^;]+;\/sign-in\?next=%2Fcontinue%3F/);
});

test("asking for a verification email again never signs a way back: anyone can ask, for anyone's address", async () => {
  // Bea signed up on the app and hasn't verified; someone else asks for her email again, with a way back to their portal.
  const email = await signUp("/app");
  const theirs = await createProject(await signUpUser("Owner"));
  const asked = await postOnApp("send-verification-email", { email, callbackURL: `/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}` });
  expect(asked.ok).toBe(true);
  const { link } = await verificationLink(email);
  // No way back to the portal in it: the app's home.
  expect(link.searchParams.get("callbackURL")).toBe("/");
  expect(link.toString()).not.toContain(theirs.slug);

  // Bea opens it: verified and signed in, on the app's home, not that portal.
  const response = await auth.handler(new Request(link, { headers: { host: new URL(APP_URL).host } }));
  expect(response.headers.get("location")).toBe("/");
  expect(await isVerified(email)).toBe(true);
});

test("someone else's address signed up with a hand-picked callback: its own verify click shows the card, never a redirect", async () => {
  // Whoever signs up an address chooses the way back, and the inbox's owner's click signs that account in.
  const theirs = await createProject(await signUpUser("Owner"));
  const email = await signUp(`/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}`);
  const { link } = await verificationLink(email);
  const appHost = new URL(APP_URL).host;
  const verified = await auth.handler(new Request(link, { headers: { host: appHost } }));
  const back = new URL(verified.headers.get("location")!, APP_URL);
  const id = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  actAs({ id, email, cookie: verified.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
  request.host = appHost;

  // As that account: a page saying where it goes, with a button, not a redirect.
  const rendered = ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/continue">);
  const outcome = await rendered.then(
    (tree) => ({ tree }),
    (error: { digest?: string }) => ({ redirect: error.digest }),
  );
  expect(outcome).not.toHaveProperty("redirect");
  expect(JSON.stringify(((outcome as { tree: React.ReactElement }).tree).props)).toContain(`["Continue to ","${theirs.name}"]`);
  expect(await continueButton(Promise.resolve((outcome as { tree: unknown }).tree))).toBe(`http://${theirs.slug}.localhost:3100/continue?redirect=%2F`);
});
