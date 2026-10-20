import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { GET as openLink } from "@/app/portal/[project]/(site)/sign-in/link/route";
import { auth } from "@/lib/auth";
import { SIGN_IN_LINK_MINUTES, SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR, SIGN_IN_LINKS_PER_PORTAL_PER_HOUR } from "@/lib/sign-in-link";
import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { emailSignInLink } from "./sign-in-link";

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
  actAs(null);
});

const newAddress = () => `e2e-${randomUUID()}@example.com`;
const portalHost = (slug = project.slug) => `${slug}.localhost:3100`;

function ask(email: string, next = "/", slug = project.slug) {
  const form = new FormData();
  form.set("email", email);
  return emailSignInLink(slug, next, form);
}

/** The link in the latest sign-in email to `email`. */
async function linkTo(email: string) {
  const message = await mailbox.latestTo(email);
  expect(message.subject).toBe(`Sign in to ${project.name}`);
  return new URL(message.text.split(/\s+/).find((word) => word.includes("/sign-in/link?"))!);
}

/** Opens `link` in a browser on `host`: where it goes, and who it signed in. */
async function open(link: URL, host = link.host) {
  const slug = host.split(".")[0]!;
  const response = await openLink(new Request(`http://${host}${link.pathname}${link.search}`, { headers: { host } }), {
    params: Promise.resolve({ project: slug }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const session = cookie ? await auth.api.getSession({ headers: new Headers({ cookie, host }) }) : null;
  const location = new URL(response.headers.get("location")!, `http://${host}`);
  return { location: location.origin === `http://${host}` ? location.pathname + location.search : location.href, user: session?.user ?? null };
}

test("the email has a one-time link to this portal that signs a new address up, named after it", async () => {
  const email = newAddress();
  expect(await ask(email)).toEqual({ sentTo: email });

  const message = await mailbox.latestTo(email);
  expect(message.text).toContain(project.name);
  expect(message.text).toContain(`expires in ${SIGN_IN_LINK_MINUTES} minutes`);
  expect(message.text).toContain("If you didn't ask for this, ignore it.");
  const link = await linkTo(email);
  expect(link.origin + link.pathname).toBe(`http://${portalHost()}/sign-in/link`);

  const { location, user } = await open(link);
  expect(location).toBe("/");
  expect(user).toMatchObject({ email, name: email.split("@")[0], emailVerified: true });

  // Used once.
  expect(await open(link)).toEqual({ location: "/sign-in?link=failed&error=INVALID_TOKEN", user: null });
});

test("an existing account gets the same answer and email, and the link signs in that account", async () => {
  const existing = await signUp("Ada");
  const unknown = newAddress();
  const [forExisting, forUnknown] = [await ask(existing.email), await ask(unknown)];
  expect(forExisting).toEqual({ sentTo: existing.email });
  expect(forUnknown).toEqual({ sentTo: unknown });
  const [a, b] = [await mailbox.latestTo(existing.email), await mailbox.latestTo(unknown)];
  expect(a.subject).toBe(b.subject);
  expect(a.text.replace(/token=\S+/, "")).toBe(b.text.replace(/token=\S+/, ""));

  const { user } = await open(await linkTo(existing.email));
  expect(user).toMatchObject({ id: existing.id, name: "Ada" });
});

test(`a link expires after ${SIGN_IN_LINK_MINUTES} minutes`, async () => {
  const email = newAddress();
  await ask(email);
  const link = await linkTo(email);
  const verification = await prisma.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" } },
    orderBy: { createdAt: "desc" },
  });
  expect(verification.expiresAt.getTime() - Date.now()).toBeGreaterThan((SIGN_IN_LINK_MINUTES - 1) * 60_000);
  expect(verification.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SIGN_IN_LINK_MINUTES * 60_000);

  await prisma.verification.update({ where: { id: verification.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await open(link)).toEqual({ location: "/sign-in?link=failed&error=INVALID_TOKEN", user: null });
  expect(await prisma.user.count({ where: { email } })).toBe(0);
});

test("a link only works on the portal that sent it", async () => {
  const email = newAddress();
  await ask(email);
  const link = await linkTo(email);
  const other = await createProject(await signUp("Other owner"));

  expect(await open(link, portalHost(other.slug))).toEqual({ location: "/sign-in?link=failed", user: null });
  // A made-up or missing token goes the same way.
  expect(await open(new URL(`http://${portalHost()}/sign-in/link?token=nope`))).toEqual({ location: "/sign-in?link=failed", user: null });
  expect(await open(new URL(`http://${portalHost()}/sign-in/link`))).toEqual({ location: "/sign-in?link=failed", user: null });
  // Still good where it belongs.
  expect((await open(link)).user).toMatchObject({ email });
});

test("it goes back to the page they came from, on this portal only", async () => {
  const email = newAddress();
  await ask(email, "/b/feature-requests?title=Dark+mode");
  const link = await linkTo(email);
  expect(link.searchParams.get("next")).toBe("/b/feature-requests?title=Dark+mode");
  expect((await open(link)).location).toBe("/b/feature-requests?title=Dark+mode");

  for (const next of ["//evil.example/", "https://evil.example/", "/\t/evil.example"]) {
    const address = newAddress();
    await ask(address, next);
    const asked = await linkTo(address);
    expect(asked.searchParams.has("next")).toBe(false);
    // Nor when someone edits the link.
    const edited = new URL(asked);
    edited.searchParams.set("next", next);
    expect(await open(edited)).toMatchObject({ location: "/", user: { email: address } });
  }
});

test("only hashes of the token and the address are stored", async () => {
  const email = newAddress();
  await ask(email);
  const token = (await linkTo(email)).searchParams.get("token")!;
  const stored = JSON.stringify([await prisma.verification.findMany(), await prisma.signInLink.findMany()]);
  expect(stored).not.toContain(token);
  expect(await prisma.signInLink.count({ where: { emailHash: { contains: "@" } } })).toBe(0);
});

test("an address gets a limited number of links an hour, on any portal", async () => {
  const email = newAddress();
  for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR; i++) {
    expect(await ask(email)).toEqual({ sentTo: email });
  }
  const refused = { error: "We've sent a lot of sign-in links to this address in the last hour. Try again later." };
  expect(await ask(email)).toEqual(refused);
  // The same on another portal, and in another case.
  const other = await createProject(await signUp("Other owner"));
  expect(await ask(email, "/", other.slug)).toEqual(refused);
  expect(await ask(email.toUpperCase())).toEqual(refused);
  expect(mailbox.emails.filter((e) => e.to.includes(email))).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);

  // Older requests don't count.
  await prisma.signInLink.updateMany({ data: { createdAt: new Date(Date.now() - 61 * 60 * 1000) } });
  expect(await ask(email)).toEqual({ sentTo: email });
});

test("a portal sends a limited number of links an hour", async () => {
  await prisma.signInLink.createMany({
    data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR }, (_, i) => ({ projectId: project.id, emailHash: `h${i}` })),
  });
  const email = newAddress();
  expect(await ask(email)).toEqual({ error: "This site has sent a lot of sign-in links in the last hour. Try again later." });
  expect(mailbox.emails.filter((e) => e.to.includes(email))).toEqual([]);
});

test("bad input and unknown portals send nothing", async () => {
  expect(await ask("not-an-email")).toEqual({ error: "Enter a valid email address" });
  expect(await ask(newAddress(), "/", "no-such-project")).toEqual({ error: "Project not found." });
  expect(await prisma.signInLink.count({ where: { projectId: project.id } })).toBe(0);
});

test("without email set up there are no sign-in links", async () => {
  const smtpHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  try {
    const email = newAddress();
    expect(await ask(email)).toEqual({ error: "Sign-in links aren't available here." });
    expect(await prisma.signInLink.count({ where: { projectId: project.id } })).toBe(0);
  } finally {
    process.env.SMTP_HOST = smtpHost;
  }
});

test("Better Auth's own magic-link endpoints aren't served (they'd skip the limits and the portal check)", async () => {
  const host = portalHost();
  const post = await auth.handler(
    new Request(`http://${host}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { host, "content-type": "application/json", origin: `http://${host}` },
      body: JSON.stringify({ email: newAddress() }),
    }),
  );
  expect(post.status).toBe(404);
  const verify = await auth.handler(new Request(`http://${host}/api/auth/magic-link/verify?token=x`, { headers: { host } }));
  expect(verify.status).toBe(404);
});
