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
