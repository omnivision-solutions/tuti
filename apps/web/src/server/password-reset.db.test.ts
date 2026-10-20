import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import ForgotPasswordPage from "@/app/(marketing)/forgot-password/page";
import ResetPasswordPage from "@/app/(marketing)/reset-password/page";
import PortalResetPasswordPage from "@/app/portal/[project]/(site)/reset-password/page";
import { NewPasswordForm } from "@/components/password-reset-forms";
import { auth } from "@/lib/auth";
import {
  PASSWORD_RESET_MINUTES,
  SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR,
  SIGN_IN_LINKS_PER_CLIENT_PER_HOUR,
  SIGN_IN_LINKS_PER_PORTAL_PER_HOUR,
} from "@/lib/sign-in-link";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { emailPasswordReset, setNewPassword } from "./password-reset";
import { emailSignInLink } from "./sign-in-link";

const OLD_PASSWORD = "correct horse battery staple"; // what signUp() sets
const NEW_PASSWORD = "a brand new password";
const APP_HOST = "tuti.localhost:3100";
const FAILED = "/forgot-password?link=failed";

let project: Awaited<ReturnType<typeof createProject>>;
let user: TestUser;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
  user = await signUp("Ada");
  actAs(null);
  request.host = "";
  request.headers = {};
  delete process.env.TRUSTED_IP_HEADER;
  // The limits count every request in this file's database; each test starts with none.
  await prisma.signInLink.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const portalHost = (slug = project.slug) => `${slug}.localhost:3100`;
const newAddress = () => `e2e-${randomUUID()}@example.com`;
/** How many reset emails `email` got (sign-ups send a verification email too). */
const sentTo = (email: string, subjects = ["Reset your password"]) =>
  mailbox.emails.filter((e) => e.to.includes(email) && subjects.includes(e.subject)).length;

/** "Forgot your password?" for `email`, on `host`. */
function ask(email: string, host = APP_HOST) {
  request.host = host;
  const form = new FormData();
  form.set("email", email);
  return emailPasswordReset(form);
}

/** The link in the latest reset email to `email`. */
async function linkTo(email: string) {
  const message = await mailbox.latestTo(email);
  expect(message.subject).toBe("Reset your password");
  return new URL(message.text.split(/\s+/).find((word) => word.includes("/reset-password?"))!);
}

/** Opens `link` on `host` (the app's page, or a portal's): the account its form is for, or where it sent the browser instead. */
async function view(link: URL, host = link.host) {
  const searchParams = Promise.resolve(Object.fromEntries(link.searchParams));
  const page =
    host === APP_HOST
      ? ResetPasswordPage({ params: Promise.resolve({}), searchParams } as PageProps<"/reset-password">)
      : PortalResetPasswordPage({
          params: Promise.resolve({ project: host.split(".")[0]! }),
          searchParams,
        } as PageProps<"/portal/[project]/reset-password">);
  const rendered = await page.catch((error: unknown) => error);
  if ((rendered as { digest?: string }).digest?.startsWith("NEXT_REDIRECT;")) {
    return { location: await redirectTarget(Promise.reject(rendered)) };
  }
  // The form (a client component, so not rendered here) and what it's given.
  const form = rendered as React.ReactElement<React.ComponentProps<typeof NewPasswordForm>>;
  expect(form.type).toBe(NewPasswordForm);
  expect(form.props.token).toBe(link.searchParams.get("token"));
  return { email: form.props.email };
}

/** Sets `password` with `link`, on `host`: an error to show, or where it went. */
async function setPassword(link: URL, password = NEW_PASSWORD, { host = link.host, confirm = password } = {}) {
  request.host = host;
  const form = new FormData();
  form.set("token", link.searchParams.get("token") ?? "");
  form.set("password", password);
  form.set("confirm", confirm);
  return setNewPassword(form);
}

const signsInWith = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } }).then(
    () => true,
    () => false,
  );

test("an app user gets an email with a link to the app; it sets a new password once and goes to sign in", async () => {
  expect(await ask(user.email)).toEqual({ sentTo: user.email });
  const message = await mailbox.latestTo(user.email);
  expect(message.text).toContain("your account on Tuti");
  expect(message.text).toContain(`expires in ${PASSWORD_RESET_MINUTES} minutes`);
  const link = await linkTo(user.email);
  expect(link.origin + link.pathname).toBe(`http://${APP_HOST}/reset-password`);

  // Opening it changes nothing (mail scanners open links too) and names the account.
  expect(await view(link)).toEqual({ email: user.email });
  expect(await view(link)).toEqual({ email: user.email });

  expect(await setPassword(link)).toEqual({ location: "/sign-in?reset=done" });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
  expect(await signsInWith(user.email, OLD_PASSWORD)).toBe(false);

  // Used once.
  expect(await view(link)).toEqual({ location: FAILED });
  expect(await setPassword(link, "yet another password")).toEqual({ location: FAILED });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
});

test("a portal user's link goes to that portal, names the portal, and works there", async () => {
  expect(await ask(user.email, portalHost())).toEqual({ sentTo: user.email });
  expect((await mailbox.latestTo(user.email)).text).toContain(`your account on ${project.name}`);
  const link = await linkTo(user.email);
  expect(link.origin + link.pathname).toBe(`http://${portalHost()}/reset-password`);
  expect(await view(link)).toEqual({ email: user.email });
  expect(await setPassword(link)).toEqual({ location: "/sign-in?reset=done" });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
});

test("a portal's link only works on that portal, and an app link only on the app", async () => {
  const other = await createProject(await signUp("Other owner"));
  await ask(user.email, portalHost());
  const portalLink = await linkTo(user.email);
  for (const host of [portalHost(other.slug), APP_HOST]) {
    expect(await view(portalLink, host)).toEqual({ location: FAILED });
    expect(await setPassword(portalLink, NEW_PASSWORD, { host })).toEqual({ location: FAILED });
  }

  await ask(user.email);
  const appLink = await linkTo(user.email);
  for (const host of [portalHost(), portalHost(other.slug)]) {
    expect(await view(appLink, host)).toEqual({ location: FAILED });
    expect(await setPassword(appLink, NEW_PASSWORD, { host })).toEqual({ location: FAILED });
  }
  // Nor on a host that's neither.
  expect(await setPassword(appLink, NEW_PASSWORD, { host: "elsewhere.example" })).toEqual({ location: FAILED });
  expect(await signsInWith(user.email, OLD_PASSWORD)).toBe(true);

  // Each still works where it belongs.
  expect(await view(portalLink)).toEqual({ email: user.email });
  expect(await setPassword(appLink)).toEqual({ location: "/sign-in?reset=done" });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);

  // Made-up or missing tokens go the same way.
  expect(await view(new URL(`http://${APP_HOST}/reset-password?token=nope`))).toEqual({ location: FAILED });
  expect(await view(new URL(`http://${APP_HOST}/reset-password`))).toEqual({ location: FAILED });
  expect(await setPassword(new URL(`http://${APP_HOST}/reset-password?token=nope`))).toEqual({ location: FAILED });
});

test("setting a new password uses up the account's other reset links too", async () => {
  await ask(user.email);
  const first = await linkTo(user.email);
  await ask(user.email, portalHost());
  const second = await linkTo(user.email);
  const someoneElse = await signUp("Bea");
  await ask(someoneElse.email);
  const theirs = await linkTo(someoneElse.email);

  expect(await setPassword(second)).toEqual({ location: "/sign-in?reset=done" });
  expect(await view(first)).toEqual({ location: FAILED });
  expect(await setPassword(first, "yet another password")).toEqual({ location: FAILED });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
  // Other people's links aren't touched.
  expect(await view(theirs)).toEqual({ email: someoneElse.email });
});

test(`a link expires after ${PASSWORD_RESET_MINUTES} minutes`, async () => {
  await ask(user.email);
  const link = await linkTo(user.email);
  const verification = await prisma.verification.findFirstOrThrow({ where: { value: user.id } });
  expect(verification.expiresAt.getTime() - Date.now()).toBeGreaterThan((PASSWORD_RESET_MINUTES - 1) * 60_000);
  expect(verification.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PASSWORD_RESET_MINUTES * 60_000);

  await prisma.verification.update({ where: { id: verification.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await view(link)).toEqual({ location: FAILED });
  expect(await setPassword(link)).toEqual({ location: FAILED });
  expect(await signsInWith(user.email, OLD_PASSWORD)).toBe(true);
});

test("an unknown address gets the same answer, and nothing is sent", async () => {
  const unknown = newAddress();
  expect(await ask(unknown)).toEqual({ sentTo: unknown });
  expect(await ask(user.email)).toEqual({ sentTo: user.email });
  expect(sentTo(unknown)).toBe(0);
  expect(sentTo(user.email)).toBe(1);
  expect(await prisma.user.count({ where: { email: unknown } })).toBe(0);
  // Unknown addresses count against the limits too, so being refused tells nothing either.
  for (let i = 1; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR; i++) {
    await ask(unknown);
  }
  expect(await ask(unknown)).toEqual({ error: "We've sent a lot of emails to this address in the last hour. Try again later." });
});

test("setting it signs the account out everywhere, marks the email verified and sends a notice", async () => {
  // Signed in twice (say on the app and on a portal: each host gets its own session); the address was never verified.
  await signsInWith(user.email, OLD_PASSWORD);
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ emailVerified: false });

  await ask(user.email);
  expect(await setPassword(await linkTo(user.email))).toEqual({ location: "/sign-in?reset=done" });
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ emailVerified: true });
  const notice = await mailbox.latestTo(user.email);
  expect(notice.subject).toBe("Your password was changed");
  expect(notice.text).toContain("you were signed out everywhere else");
});

test("an account whose password was removed (opening a sign-in link before verifying) gets one back", async () => {
  await prisma.account.deleteMany({ where: { userId: user.id, providerId: "credential" } });
  expect(await signsInWith(user.email, OLD_PASSWORD)).toBe(false);
  await ask(user.email, portalHost());
  expect(await setPassword(await linkTo(user.email))).toEqual({ location: "/sign-in?reset=done" });
  expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
});

test("passwords that don't match or are too short are refused, and the link still works", async () => {
  await ask(user.email);
  const link = await linkTo(user.email);
  expect(await setPassword(link, NEW_PASSWORD, { confirm: "something else" })).toEqual({ error: "The passwords don't match." });
  expect(await setPassword(link, "short")).toEqual({ error: "Password too short" });
  expect(await setPassword(link)).toEqual({ location: "/sign-in?reset=done" });
});

test("only hashes of the token and the address are stored, and the token is never logged", async () => {
  const output: string[] = [];
  const capture = (...args: unknown[]) => void output.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(capture);
  }
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (capture(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (capture(String(chunk)), true));

  await ask(user.email);
  const link = await linkTo(user.email);
  const token = link.searchParams.get("token")!;
  const stored = JSON.stringify([await prisma.verification.findMany(), await prisma.signInLink.findMany()]);
  expect(stored).not.toContain(token);
  expect(await prisma.signInLink.count({ where: { emailHash: { contains: "@" } } })).toBe(0);
  await setPassword(link, "short");
  await setPassword(link);
  await setPassword(link);
  vi.restoreAllMocks();
  expect(output.join("\n")).not.toContain(token);
});

test("reset links and sign-in links share the hourly limit per address", async () => {
  for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR - 1; i++) {
    const form = new FormData();
    form.set("email", user.email);
    expect(await emailSignInLink(project.slug, "/", form)).toEqual({ sentTo: user.email });
  }
  expect(await ask(user.email, portalHost())).toEqual({ sentTo: user.email });
  const refused = { error: "We've sent a lot of emails to this address in the last hour. Try again later." };
  expect(await ask(user.email)).toEqual(refused);
  expect(await ask(user.email.toUpperCase(), portalHost())).toEqual(refused);
  expect(sentTo(user.email, ["Reset your password", `Sign in to ${project.name}`])).toBe(SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);
});

test("the app host and each portal send a limited number an hour", async () => {
  const full = { error: "This site has sent a lot of emails in the last hour. Try again later." };
  await prisma.signInLink.createMany({
    data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR }, (_, i) => ({ projectId: null, emailHash: `h${i}` })),
  });
  expect(await ask(user.email)).toEqual(full);
  // Portals have their own.
  expect(await ask(user.email, portalHost())).toEqual({ sentTo: user.email });

  await prisma.signInLink.createMany({
    data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR }, (_, i) => ({ projectId: project.id, emailHash: `p${i}` })),
  });
  expect(await ask(newAddress(), portalHost())).toEqual(full);
  expect(sentTo(user.email)).toBe(1);
});

test("a visitor gets a limited number an hour, quietly", async () => {
  process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
  request.headers = { "cf-connecting-ip": "203.0.113.7" };
  const users = await Promise.all(Array.from({ length: SIGN_IN_LINKS_PER_CLIENT_PER_HOUR + 2 }, () => signUp("Someone")));
  for (const [i, someone] of users.entries()) {
    expect(await ask(someone.email)).toEqual({ sentTo: someone.email });
    expect(sentTo(someone.email)).toBe(i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR ? 1 : 0);
  }
  // Someone else still gets theirs.
  request.headers = { "cf-connecting-ip": "198.51.100.20" };
  expect(await ask(user.email)).toEqual({ sentTo: user.email });
  expect(sentTo(user.email)).toBe(1);
});

test("bad input, unknown portals and other hosts send nothing", async () => {
  expect(await ask("not-an-email")).toEqual({ error: "Enter a valid email address" });
  expect(await ask(user.email, portalHost("no-such-project"))).toEqual({ error: "Password resets aren't available here." });
  expect(await ask(user.email, "elsewhere.example")).toEqual({ error: "Password resets aren't available here." });
  expect(await prisma.signInLink.count()).toBe(0);
  expect(sentTo(user.email)).toBe(0);
});

test("without email set up there are no password resets", async () => {
  const smtpHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  try {
    expect(await ask(user.email)).toEqual({ error: "Password resets aren't available here." });
    expect(await prisma.signInLink.count()).toBe(0);
    const page = ForgotPasswordPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as PageProps<"/forgot-password">);
    expect(await page.catch((error: { digest?: string }) => error.digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
  } finally {
    process.env.SMTP_HOST = smtpHost;
  }
});

test("Better Auth's own reset endpoints aren't served (they'd skip the limits and the host check)", async () => {
  for (const host of [APP_HOST, portalHost()]) {
    for (const [path, body] of [
      ["request-password-reset", { email: user.email }],
      ["reset-password", { token: "x", newPassword: NEW_PASSWORD }],
    ] as const) {
      const response = await auth.handler(
        new Request(`http://${host}/api/auth/${path}`, {
          method: "POST",
          headers: { host, "content-type": "application/json", origin: `http://${host}` },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(404);
    }
  }
  expect(sentTo(user.email)).toBe(0);
});
