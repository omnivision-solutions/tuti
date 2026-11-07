import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import ContinuePage from "@/app/(marketing)/continue/page";
import { actAs, createProject, redirectTarget, signUp as signUpUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { auth, VERIFICATION_SECONDS } from "./auth";
import { randomSecret } from "./portal-handoff";

async function signUp(callbackURL?: string) {
  const email = `e2e-${randomUUID()}@example.com`;
  await auth.api.signUpEmail({
    body: { email, name: "Ada", password: "correct horse battery staple", callbackURL },
  });
  return email;
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
  expect(await redirectTarget(page(signed))).toBe(`http://${project.slug}.localhost:3100/continue?redirect=%2Ffeedback%2Fideas`);

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
  // the same link with someone else signed in (say its owner's teammate, who lifted it from their own email), or no one;
  actAs(await signUpUser("Someone else"));
  await notValid(signed);
  actAs(null);
  await notValid(signed);
  // and, for its account, once it's older than the verification link it came in.
  actAs(ada);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (VERIFICATION_SECONDS + 1) * 1000 });
  try {
    await notValid(signed);
  } finally {
    vi.useRealTimers();
  }
  expect(await redirectTarget(page(signed))).toContain("/continue?redirect=");
});

test("a way back someone gets signed by signing up with a hand-picked callback works for nobody else", async () => {
  // Their own project (whose address they may run), and a sign-up through the API asking for a way back there.
  const theirs = await createProject(await signUpUser("Owner"));
  const email = await signUp(`/continue?${new URLSearchParams({ portal: theirs.slug, redirect: "/" })}`);
  const { link } = await verificationLink(email);
  const back = new URL(link.searchParams.get("callbackURL")!, link);
  expect(back.searchParams.get("mac")).toBeTruthy();

  // Sent to anyone else, opened signed in as someone else or no one: not valid, and no redirect to that address.
  request.host = new URL(process.env.APP_URL!).host;
  const open = () =>
    ContinuePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/continue">).catch(
      (error: { digest?: string }) => error.digest,
    );
  for (const someone of [await signUpUser("Someone else"), null]) {
    actAs(someone);
    expect(JSON.stringify(((await open()) as React.ReactElement).props)).toContain("Link not valid");
  }
});
