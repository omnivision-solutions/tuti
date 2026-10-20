import { createHash, randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";

import SignInLinkPage from "@/app/portal/[project]/(site)/sign-in/link/page";
import { auth } from "@/lib/auth";
import {
  SIGN_IN_LINK_MINUTES,
  SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR,
  SIGN_IN_LINKS_PER_CLIENT_PER_HOUR,
  SIGN_IN_LINKS_PER_PORTAL_PER_HOUR,
} from "@/lib/sign-in-link";
import { actAs, createProject, redirectTarget, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { confirmSignInLink, emailSignInLink } from "./sign-in-link";

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
  actAs(null);
  request.host = "";
  request.headers = {};
  delete process.env.TRUSTED_IP_HEADER;
});

/** Ask as a visitor from `ip`, given in Cloudflare's header (trusted when TRUSTED_IP_HEADER names it). */
function askFrom(ip: string, email = newAddress(), extraHeaders: Record<string, string> = {}) {
  request.headers = { "cf-connecting-ip": ip, ...extraHeaders };
  return ask(email);
}
const sentTo = (email: string) => mailbox.emails.filter((e) => e.to.includes(email)).length;

const newAddress = () => `e2e-${randomUUID()}@example.com`;
const portalHost = (slug = project.slug) => `${slug}.localhost:3100`;
const FAILED = "/sign-in?link=failed";

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

/** Opens `link` on `host`: the confirm page's text, or where it sent the browser instead. */
async function view(link: URL, host = link.host) {
  const page = SignInLinkPage({
    params: Promise.resolve({ project: host.split(".")[0]! }),
    searchParams: Promise.resolve(Object.fromEntries(link.searchParams)),
  } as PageProps<"/portal/[project]/sign-in/link">);
  const rendered = await page.catch((error: unknown) => error);
  if ((rendered as { digest?: string }).digest?.startsWith("NEXT_REDIRECT;")) {
    return { location: await redirectTarget(Promise.reject(rendered)) };
  }
  const html = renderToStaticMarkup(rendered as React.ReactElement).replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  return { text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

/** Clicks "Sign in" on the confirm page of `link`, on `host`: where it goes, and who it signed in. */
async function confirm(link: URL, host = link.host) {
  request.host = host;
  const form = new FormData();
  form.set("token", link.searchParams.get("token") ?? "");
  form.set("next", link.searchParams.get("next") ?? "/");
  const before = new Date(Date.now() - 1);
  const location = await redirectTarget(confirmSignInLink(form));
  const session = await prisma.session.findFirst({ where: { createdAt: { gt: before } }, include: { user: true } });
  return { location, user: session?.user ?? null };
}

test("the email has a link to a page that asks to confirm, then signs a new address up, named after it", async () => {
  const email = newAddress();
  expect(await ask(email)).toEqual({ sentTo: email });

  const message = await mailbox.latestTo(email);
  expect(message.text).toContain(project.name);
  expect(message.text).toContain(`expires in ${SIGN_IN_LINK_MINUTES} minutes`);
  expect(message.text).toContain("If you didn't ask for this, ignore it.");
  const link = await linkTo(email);
  expect(link.origin + link.pathname).toBe(`http://${portalHost()}/sign-in/link`);

  expect(await view(link)).toEqual({ text: `Sign in to ${project.name} as ${email} Sign in` });
  const { location, user } = await confirm(link);
  expect(location).toBe("/");
  expect(user).toMatchObject({ email, name: email.split("@")[0], emailVerified: true });

  // Used once: confirming again fails, and the page now sends them to ask for a new one.
  expect(await confirm(link)).toEqual({ location: FAILED, user: null });
  expect(await view(link)).toEqual({ location: FAILED });
});

test("opening the link uses nothing up (mail scanners open links too); only confirming does", async () => {
  const email = newAddress();
  await ask(email);
  const link = await linkTo(email);
  await view(link);
  await view(link);
  expect(await prisma.user.count({ where: { email } })).toBe(0);
  expect(await prisma.session.count({ where: { user: { email } } })).toBe(0);
  expect((await confirm(link)).user).toMatchObject({ email });
});

test("an existing account gets the same answer and email; the page names that address and signs in that account", async () => {
  const existing = await signUp("Ada");
  const unknown = newAddress();
  const [forExisting, forUnknown] = [await ask(existing.email), await ask(unknown)];
  expect(forExisting).toEqual({ sentTo: existing.email });
  expect(forUnknown).toEqual({ sentTo: unknown });
  const [a, b] = [await mailbox.latestTo(existing.email), await mailbox.latestTo(unknown)];
  expect(a.subject).toBe(b.subject);
  expect(a.text.replace(/token=\S+/, "")).toBe(b.text.replace(/token=\S+/, ""));

  // The address comes from the stored link, whatever the URL says.
  const link = await linkTo(existing.email);
  link.searchParams.set("email", unknown);
  expect(await view(link)).toEqual({ text: `Sign in to ${project.name} as ${existing.email} Sign in` });
  expect((await confirm(link)).user).toMatchObject({ id: existing.id, name: "Ada" });
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
  expect(await view(link)).toEqual({ location: FAILED });
  expect(await confirm(link)).toEqual({ location: FAILED, user: null });
  expect(await prisma.user.count({ where: { email } })).toBe(0);
});

test("a link only works on the portal that sent it", async () => {
  const email = newAddress();
  await ask(email);
  const link = await linkTo(email);
  const other = await createProject(await signUp("Other owner"));

  expect(await view(link, portalHost(other.slug))).toEqual({ location: FAILED });
  expect(await confirm(link, portalHost(other.slug))).toEqual({ location: FAILED, user: null });
  // Nor on the app host, where there's no portal.
  expect(await confirm(link, "tuti.localhost:3100")).toEqual({ location: FAILED, user: null });
  // A made-up or missing token goes the same way.
  expect(await view(new URL(`http://${portalHost()}/sign-in/link?token=nope`))).toEqual({ location: FAILED });
  expect(await view(new URL(`http://${portalHost()}/sign-in/link`))).toEqual({ location: FAILED });
  expect(await confirm(new URL(`http://${portalHost()}/sign-in/link?token=nope`))).toEqual({ location: FAILED, user: null });
  // Still good where it belongs.
  expect((await confirm(link)).user).toMatchObject({ email });
});

test("it goes back to the page they came from, on this portal only", async () => {
  const email = newAddress();
  await ask(email, "/b/feature-requests?title=Dark+mode");
  const link = await linkTo(email);
  expect(link.searchParams.get("next")).toBe("/b/feature-requests?title=Dark+mode");
  expect((await confirm(link)).location).toBe("/b/feature-requests?title=Dark+mode");
  // A dead link keeps it too, for the new link they ask for.
  expect(await view(link)).toEqual({ location: `${FAILED}&next=%2Fb%2Ffeature-requests%3Ftitle%3DDark%2Bmode` });

  for (const next of ["//evil.example/", "https://evil.example/", "/\t/evil.example"]) {
    const address = newAddress();
    await ask(address, next);
    const asked = await linkTo(address);
    expect(asked.searchParams.has("next")).toBe(false);
    // Nor when someone edits the link.
    const edited = new URL(asked);
    edited.searchParams.set("next", next);
    expect(await view(edited)).toMatchObject({ text: expect.stringContaining(address) });
    expect(await confirm(edited)).toMatchObject({ location: "/", user: { email: address } });
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

test("a visitor gets a limited number of links an hour, quietly, before they can use up the portal's", async () => {
  process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
  // The portal has just enough room left for one visitor's limit and one more link.
  await prisma.signInLink.createMany({
    data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR - SIGN_IN_LINKS_PER_CLIENT_PER_HOUR - 1 }, (_, i) => ({
      projectId: project.id,
      emailHash: `h${i}`,
    })),
  });
  for (let i = 0; i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
    const email = newAddress();
    expect(await askFrom("203.0.113.7", email)).toEqual({ sentTo: email });
    expect(sentTo(email)).toBe(1);
  }
  // Over it: the same answer, but nothing is sent or counted against the portal.
  for (let i = 0; i < 5; i++) {
    const email = newAddress();
    expect(await askFrom("203.0.113.7", email)).toEqual({ sentTo: email });
    expect(sentTo(email)).toBe(0);
  }
  // Other visitors still get theirs.
  const email = newAddress();
  expect(await askFrom("198.51.100.20", email)).toEqual({ sentTo: email });
  expect(sentTo(email)).toBe(1);
});

test("an IPv6 visitor is their whole /64: rotating addresses in it doesn't get more links", async () => {
  process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
  for (let i = 0; i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
    const email = newAddress();
    await askFrom(`2001:db8:0:42::${(i + 1).toString(16)}`, email);
    expect(sentTo(email)).toBe(1);
  }
  const rotated = newAddress();
  await askFrom("2001:0DB8:0:42:dead:beef:0:1", rotated);
  expect(sentTo(rotated)).toBe(0);
  // The next /64 is someone else.
  const neighbour = newAddress();
  await askFrom("2001:db8:0:43::1", neighbour);
  expect(sentTo(neighbour)).toBe(1);
  // A value that isn't an IP address gets no per-visitor limit (rather than one shared key).
  for (let i = 0; i <= SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
    const email = newAddress();
    await askFrom("unknown", email);
    expect(sentTo(email)).toBe(1);
  }
});

test("visitors are told apart only by the trusted header, and only a keyed hash of their address is stored", async () => {
  // Not configured: headers anyone can send are ignored, so there's no per-visitor limit.
  for (let i = 0; i <= SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
    const email = newAddress();
    expect(await askFrom("203.0.113.7", email, { "x-forwarded-for": "203.0.113.7" })).toEqual({ sentTo: email });
    expect(sentTo(email)).toBe(1);
  }
  expect(await prisma.signInLink.count({ where: { projectId: project.id, clientHash: { not: null } } })).toBe(0);

  // Configured: a made-up X-Forwarded-For doesn't make a new visitor.
  process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
  for (let i = 0; i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
    await askFrom("192.0.2.55", newAddress(), { "x-forwarded-for": `10.0.0.${i}` });
  }
  const email = newAddress();
  await askFrom("192.0.2.55", email, { "x-forwarded-for": "10.0.0.99" });
  expect(sentTo(email)).toBe(0);

  const rows = await prisma.signInLink.findMany({ where: { projectId: project.id, clientHash: { not: null } } });
  expect(rows).toHaveLength(SIGN_IN_LINKS_PER_CLIENT_PER_HOUR);
  expect(new Set(rows.map((row) => row.clientHash)).size).toBe(1);
  expect(rows[0]!.clientHash).toMatch(/^[0-9a-f]{64}$/);
  // Keyed: not a plain hash anyone could match against a list of addresses.
  expect(rows[0]!.clientHash).not.toBe(createHash("sha256").update("192.0.2.55").digest("hex"));
  expect(JSON.stringify(await prisma.signInLink.findMany())).not.toContain("192.0.2.55");
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
