import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { mailbox } from "@/test/mailbox";

import { auth } from "./auth";

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
