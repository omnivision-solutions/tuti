import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { changelogReach, type ChangelogReach, handlers, resumeToken, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import SubscriptionPage from "@/app/portal/[project]/(site)/changelog/subscription/page";
import UnsubscribePage from "@/app/portal/[project]/(site)/unsubscribe/page";
import { POST as confirmRoute } from "@/app/portal/[project]/(site)/changelog/subscription/confirm/route";
import { POST as unsubscribeRoute } from "@/app/portal/[project]/(site)/changelog/subscription/unsubscribe/route";
import { POST as emailsOnRoute } from "@/app/portal/[project]/(site)/changelog/subscription/emails-on/route";
import { POST as optOutRoute } from "@/app/portal/[project]/(site)/unsubscribe/confirm/route";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR } from "@/lib/sign-in-link";
import { entryTold } from "@/server/changelog-queries";
import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry } from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { subscribeToChangelog } from "./changelog-subscribe";
import { CONFIRM_LINK_HOURS } from "./changelog-subscription";
import { resumeEmailSending } from "./email-pause";

/** The portal changelog's "Get updates by email": confirmed by email, then each published entry emailed once. */

// Something to happen as an email goes out (a run's next step meanwhile), to play out runs that overlap.
const sending = vi.hoisted(() => ({ hook: null as ((to: string) => Promise<void>) | null }));
vi.mock("@tuti/email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tuti/email")>();
  return {
    ...real,
    sendEmail: async (...args: Parameters<typeof real.sendEmail>) => {
      await sending.hook?.(args[0].to);
      return real.sendEmail(...args);
    },
  };
});
afterEach(() => {
  sending.hook = null;
});

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
  request.headers = {};
});
afterEach(() => vi.unstubAllEnvs());
// The project's own sender (SUPPORT_EMAIL_DOMAIN, below) asks SES for its tenant.
const ses = await startSesFake();
afterAll(() => ses.close());

const log = { info: () => {}, warn: () => {} };
const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const newAddress = () => `e2e-${randomUUID()}@example.com`;
const emailsTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));
const entryEmailsTo = (address: string) => emailsTo(address).filter((email) => email.subject.startsWith(`${project.name}: `));

function subscribe(email: string, slug = project.slug) {
  const form = new FormData();
  form.set("email", email);
  return subscribeToChangelog(slug, form);
}

/** The confirmation token (`confirm`) in the latest confirmation email to `email`. */
async function confirmationTo(email: string) {
  const message = await mailbox.latestTo(email);
  // To an address that's turned the project's emails off, it offers to turn them back on instead.
  expect([`Confirm ${project.name}'s updates by email`, `Turn ${project.name}'s emails back on?`]).toContain(message.subject);
  const link = new URL(message.text.split(/\s+/).find((word) => word.includes("/changelog/subscription?"))!);
  return link.searchParams.get("confirm")!;
}

const routeUrl = (action: string, query: string) =>
  `http://${project.slug}.localhost:3100/portal/${project.slug}/changelog/subscription/${action}?${query}`;
const params = () => Promise.resolve({ project: project.slug });
/** "Get updates by email" on a confirmation link's page. */
/** The confirmation page's button: "Get updates by email", or (`emailsOn`) the opted-out page's "Turn Acme's emails back on". */
const confirm = (token: string, emailsOn = false) =>
  confirmRoute(
    new Request(routeUrl("confirm", `confirm=${encodeURIComponent(token)}`), {
      method: "POST",
      ...(emailsOn && { body: new URLSearchParams({ "emails-on": "1" }) }),
    }),
    { params: params() },
  );
const unsubscribe = (token: string, oneClick = false) =>
  unsubscribeRoute(
    new Request(routeUrl("unsubscribe", `token=${encodeURIComponent(token)}`), {
      method: "POST",
      ...(oneClick && { body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }),
    }),
    { params: params() },
  );
/** "Turn Acme's emails back on" on a subscription's page. */
const emailsOn = (token: string) =>
  emailsOnRoute(new Request(routeUrl("emails-on", `token=${encodeURIComponent(token)}`), { method: "POST" }), { params: params() });
/** Their subscription's token (in every changelog email's unsubscribe link). */
const tokenOf = async (email: string) => (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).token;

/** Subscribes `email` and confirms it from the email: their subscription's token. */
async function confirmed(email = newAddress()) {
  expect(await subscribe(email)).toEqual({ sentTo: email });
  expect((await confirm(await confirmationTo(email))).status).toBe(303);
  return tokenOf(email);
}

/** The subscription page's text, from an unsubscribe link (`token`) or a confirmation link (`confirm`). */
async function page(query: { token: string; sent?: string } | { confirm: string }) {
  const rendered = await SubscriptionPage({
    params: params(),
    searchParams: Promise.resolve(query),
  } as PageProps<"/portal/[project]/changelog/subscription">);
  return renderToStaticMarkup(rendered).replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
}

/** Until a query in another connection waits on a lock taken `FOR SHARE` (a claim's), by asking Postgres. */
async function waitingOnALock() {
  for (let tries = 0; tries < 300; tries++) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR SHARE%' AND pid <> pg_backend_pid()`;
    if (waiting > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No claim came to wait on a lock");
}

/** `user` turns the project's emails off (the unsubscribe link in a shipped email). */
async function optOut(userId: string) {
  const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const url = `http://${project.slug}.localhost:3100/portal/${project.slug}/unsubscribe/confirm?token=${unsubscribeToken}`;
  expect((await optOutRoute(new Request(url, { method: "POST" }), { params: params() })).status).toBe(303);
}

/** Someone the project's SSO signs in: their account's address a stand-in, the project's emails going to `address`. */
async function ssoUser(address: string) {
  const user = await signUp("Sam SSO");
  await prisma.user.update({ where: { id: user.id }, data: { email: `sso-${user.id}@sso.invalid` } });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: user.id, userId: user.id, email: address } });
  return user;
}

async function publishEntry(title: string, input: { emailSubscribers?: boolean } = { emailSubscribers: true }) {
  const entry = await call(createChangelogEntry, team(), { title, body: `${title}, for everyone.` });
  await call(publishChangelogEntry, team(), { number: entry.number, ...input });
  return entry.number;
}

describe("subscribing", () => {
  test("nothing is sent until the address confirms; confirmed, a published entry arrives with its link and an unsubscribe link", async () => {
    const [kim, lee] = [newAddress(), newAddress()];
    expect(await subscribe(kim.toUpperCase())).toEqual({ sentTo: kim });
    expect(await subscribe(lee)).toEqual({ sentTo: lee });
    const link = await confirmationTo(kim);
    expect(await page({ confirm: link })).toContain(`Get ${project.name}'s updates by email? The changelog entries ${project.name} emails to subscribers go to ${kim}.`);

    // Lee never confirms.
    const token = await tokenOf(kim);
    expect((await confirm(link)).headers.get("location")).toBe(`/changelog/subscription?token=${token}`);
    expect(await page({ token })).toContain(`You get ${project.name}'s updates by email`);
    await publishEntry("Dark mode");

    expect(entryEmailsTo(lee)).toEqual([]);
    const [email] = entryEmailsTo(kim);
    expect(email!.subject).toBe(`${project.name}: Dark mode`);
    expect(email!.text).toContain("Dark mode, for everyone.");
    expect(email!.text).toContain(`http://${project.slug}.localhost:3100/changelog/1`);
    expect(email!.text).toContain(`http://${project.slug}.localhost:3100/changelog/subscription?token=${token}`);
    expect(email!.headers["list-unsubscribe"]).toBe(`<http://${project.slug}.localhost:3100/changelog/subscription/unsubscribe?token=${token}>`);
    expect(email!.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    // How many it told: the subscriber emailed.
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(await entryTold(entry.id)).toBe(1);
  });

  test("unsubscribing (the email's link, or one click from a mail app) stops them; subscribing again asks to confirm again", async () => {
    const [kim, lee] = [newAddress(), newAddress()];
    const [kimToken, leeToken] = [await confirmed(kim), await confirmed(lee)];
    expect((await unsubscribe("not-a-token")).status).toBe(404);
    const fromPage = await unsubscribe(kimToken);
    expect(fromPage.status).toBe(303);
    expect(fromPage.headers.get("location")).toBe(`/changelog/subscription?token=${kimToken}`);
    expect(await page({ token: kimToken })).toContain(`You're unsubscribed ${project.name}'s changelog won't be emailed to ${kim} anymore.`);
    const oneClick = await unsubscribe(leeToken, true);
    expect(oneClick.status).toBe(200);
    // A portal under a path of the team's site goes back to the page there.
    request.headers = { "x-tuti-base": "/updates" };
    expect((await unsubscribe(kimToken)).headers.get("location")).toBe(`/updates/changelog/subscription?token=${kimToken}`);
    request.headers = {};
    // The page says to subscribe again.
    expect(await page({ token: kimToken })).toContain("To get it again, subscribe on the changelog");
    await publishEntry("Dark mode");
    expect([...entryEmailsTo(kim), ...entryEmailsTo(lee)]).toEqual([]);

    // Back on the portal: confirmed again before anything is sent.
    expect(await subscribe(kim)).toEqual({ sentTo: kim });
    const again = await confirmationTo(kim);
    expect(await page({ confirm: again })).toContain(`Get ${project.name}'s updates by email?`);
    await publishEntry("Exports");
    expect(entryEmailsTo(kim)).toEqual([]);
    // Back where the portal is under a path of the team's site.
    request.headers = { "x-tuti-base": "/updates" };
    expect((await confirm(again)).headers.get("location")).toBe(`/updates/changelog/subscription?token=${kimToken}`);
    request.headers = {};
    await publishEntry("Search");
    expect(entryEmailsTo(kim).map((email) => email.subject)).toEqual([`${project.name}: Search`]);
  });

  test("on a portal gone private, the page says the changelog isn't emailed: nothing to confirm (refused too), Unsubscribe still works", async () => {
    const [kim, lee] = [newAddress(), newAddress()];
    const kimToken = await confirmed(kim);
    expect(await subscribe(lee)).toEqual({ sentTo: lee });
    const leeLink = await confirmationTo(lee);
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });

    expect(await page({ token: kimToken })).toContain(
      `Updates by email aren't available here ${project.name}'s portal is private, so its changelog isn't emailed to ${kim}. Unsubscribe`,
    );
    expect(await page({ confirm: leeLink })).toBe(`Updates by email aren't available here ${project.name}'s portal is private, so its changelog isn't emailed.`);
    expect((await confirm(leeLink)).status).toBe(403);
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: lee } })).confirmedAt).toBeNull();
    expect((await unsubscribe(kimToken)).status).toBe(303);
    expect(await page({ token: kimToken })).toBe(`You're unsubscribed ${project.name}'s changelog won't be emailed to ${kim} anymore.`);
  });

  test("a confirmation link confirms only its own request: not once a newer one replaced it, nor after unsubscribing, used or expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const kim = newAddress();
    const dead = (link: string) => page({ confirm: link }).then((text) => expect(text).toContain("This link doesn't work any more"));
    // Subscribe, unsubscribe, subscribe again: the first email's link (forwarded, say) no longer confirms.
    await subscribe(kim);
    const first = await confirmationTo(kim);
    expect((await confirm(first)).status).toBe(303);
    await unsubscribe(await tokenOf(kim));
    await subscribe(kim);
    const second = await confirmationTo(kim);
    expect((await confirm(first)).status).toBe(404);
    await dead(first);
    // Unsubscribing before confirming takes the pending link with it.
    await unsubscribe(await tokenOf(kim));
    expect((await confirm(second)).status).toBe(404);
    // Asked twice, only the latest link works, and only once.
    await subscribe(kim);
    const third = await confirmationTo(kim);
    await subscribe(kim);
    const fourth = await confirmationTo(kim);
    expect((await confirm(third)).status).toBe(404);
    expect((await confirm(fourth)).status).toBe(303);
    expect((await confirm(fourth)).status).toBe(404);
    // Opened again, a link they've confirmed with says where they stand, and offers nothing (anyone may hold an old link).
    const alreadyConfirmed = `Already confirmed The changelog entries ${project.name} emails to subscribers go to ${kim}. The emails ${project.name} sends you have their own links to unsubscribe.`;
    expect(await page({ confirm: fourth })).toBe(alreadyConfirmed);
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: kim } })).confirmedAt).not.toBeNull();

    // Past its hours a link confirms nothing; a used one still says where they stand (not "ask again", which would do nothing).
    vi.setSystemTime(Date.now() + (CONFIRM_LINK_HOURS + 1) * 60 * 60_000);
    expect(await page({ confirm: fourth })).toBe(alreadyConfirmed);
    expect((await confirm(fourth)).status).toBe(404);
    const lee = newAddress();
    await subscribe(lee);
    const late = await confirmationTo(lee);
    vi.setSystemTime(Date.now() + (CONFIRM_LINK_HOURS + 1) * 60 * 60_000);
    await dead(late);
    expect(await page({ confirm: late })).toContain("To get updates by email, ask again on the changelog");
    expect((await confirm(late)).status).toBe(404);
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: lee } })).confirmedAt).toBeNull();
    // On a portal gone private there's nowhere to ask again: the page doesn't say to.
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    await dead(late);
    expect(await page({ confirm: late })).not.toContain("ask again");
  });

  test("a link sent before the address turned the project's emails off can't turn them back on: the newer word stands", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const ada = await signUp("Ada");
    await subscribe(ada.email);
    const link = await confirmationTo(ada.email);
    vi.setSystemTime(Date.now() + 60_000);
    await optOut(ada.id);
    expect(await page({ confirm: link })).toContain("This link doesn't work any more");
    expect((await confirm(link, true)).status).toBe(404);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(1);
  });

  test("\"Email me a link\" only where it can help: not to someone getting it already, nor from a portal gone private", async () => {
    const kim = newAddress();
    const kimToken = await confirmed(kim);
    const before = emailsTo(kim).length;
    // Getting it: nothing to turn back on, so nothing is sent (anyone holding the token could have links sent at will).
    const asked = await emailsOn(kimToken);
    expect(asked.headers.get("location")).toBe(`/changelog/subscription?token=${kimToken}`);
    expect(emailsTo(kim)).toHaveLength(before);
    // Opted out, but the portal's private: nothing could come of it.
    const ada = await signUp("Ada");
    const adaToken = await confirmed(ada.email);
    await optOut(ada.id);
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    const sent = emailsTo(ada.email).length;
    expect((await emailsOn(adaToken)).status).toBe(403);
    expect(emailsTo(ada.email)).toHaveLength(sent);
  });

  test("an address already confirmed gets no second confirmation, but the same answer", async () => {
    const kim = newAddress();
    await confirmed(kim);
    const before = emailsTo(kim).length;
    expect(await subscribe(kim)).toEqual({ sentTo: kim });
    expect(emailsTo(kim)).toHaveLength(before);
  });

  test("a bad address, a private portal, or another project's token are refused", async () => {
    expect(await subscribe("not an address")).toEqual({ error: "Enter a valid email address" });
    // A live confirmation link and an unsubscribe token of this project, each used on another project's portal.
    const [kim, lee] = [newAddress(), newAddress()];
    const token = await confirmed(kim);
    await subscribe(lee);
    const link = await confirmationTo(lee);
    const other = await createProject(owner);
    const elsewhere = (route: typeof confirmRoute, action: string, query: string) =>
      route(new Request(routeUrl(action, query).replaceAll(project.slug, other.slug), { method: "POST" }), { params: Promise.resolve({ project: other.slug }) });
    expect((await elsewhere(confirmRoute, "confirm", `confirm=${encodeURIComponent(link)}`)).status).toBe(404);
    expect((await elsewhere(unsubscribeRoute, "unsubscribe", `token=${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: lee } })).confirmedAt).toBeNull();
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: kim } })).confirmedAt).not.toBeNull();

    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    const ada = newAddress();
    expect(await subscribe(ada)).toEqual({ error: "Updates by email aren't available here." });
    expect(emailsTo(ada)).toEqual([]);
  });

  test("asking is limited like the other emailed links: per address, shared with sign-in links", async () => {
    const kim = newAddress();
    for (let i = 0; i < SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR; i++) {
      expect(await subscribe(kim)).toEqual({ sentTo: kim });
    }
    expect(await subscribe(kim)).toEqual({ error: "We've sent a lot of emails to this address in the last hour. Try again later." });
    expect(emailsTo(kim)).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR);
  });
});

describe("one rule (changelogReach): the sender and every page agree", () => {
  // Each state, made for one subscriber in a project of its own: what the rule says, what their page says, and
  // whether the sender's audience (the editor's count) has them.
  const states: { reach: ChangelogReach; page: string; emailed: boolean | null; make: (subscriber: { token: string; email: string; userId: string }) => Promise<unknown> }[] = [
    { reach: "gets", page: "You get {name}'s updates by email The changelog entries {name} emails to subscribers go to {email}.", emailed: true, make: async () => {} },
    {
      reach: "paused",
      page: "The changelog entries {name} emails to subscribers go to {email} once {name}'s emails, paused for now, are resumed.",
      emailed: true,
      make: () => prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } }),
    },
    { reach: "unconfirmed", page: "You're unsubscribed", emailed: false, make: ({ token }) => unsubscribe(token) },
    { reach: "private", page: "Updates by email aren't available here", emailed: null, make: () => prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } }) },
    { reach: "opted-out", page: "You've turned off all of {name}'s emails, so its changelog isn't emailed to {email} either.", emailed: false, make: ({ userId }) => optOut(userId) },
  ];
  test.each(states)("$reach", async ({ reach, page: says, emailed, make }) => {
    vi.stubEnv("PLANS", "on");
    const ada = await signUp("Ada");
    const token = await confirmed(ada.email);
    await make({ token, email: ada.email, userId: ada.id });
    const { confirmedAt } = await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: ada.email } });
    expect(await changelogReach(project.id, { email: ada.email, confirmed: confirmedAt !== null })).toBe(reach);
    expect(await page({ token })).toContain(says.replaceAll("{email}", ada.email).replaceAll("{name}", project.name));
    // The editor's count is the sender's audience: null where nothing's emailed at all (a private portal).
    expect(await subscriberCount(project.id)).toBe(emailed === null ? null : emailed ? 1 : 0);
  });
});

describe("no link in an email restarts mail (anyone it was forwarded to has it)", () => {
  test("not the project's unsubscribe token, the subscription's token, nor a confirmation link sent before the opt-out", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const ada = await signUp("Ada");
    const token = await confirmed(ada.email);
    // A confirmation link out (asked for, say, by someone who knows the address), then Ada turns everything off.
    await prisma.changelogSubscriber.updateMany({ where: { projectId: project.id, email: ada.email }, data: { confirmedAt: null } });
    await subscribe(ada.email);
    const before = await confirmationTo(ada.email);
    vi.setSystemTime(Date.now() + 60_000);
    await optOut(ada.id);
    // The project's unsubscribe link only turns things off, again.
    await optOut(ada.id);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(1);
    // The subscription's token only unsubscribes, or has a fresh link emailed.
    await emailsOn(token);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(1);
    // The link from before the opt-out is void.
    expect((await confirm(before, true)).status).toBe(404);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(1);
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toEqual([]);
  });
});

describe("publishing with Email subscribers", () => {
  test("only when asked: not by default, nor quietly published without it", async () => {
    const kim = newAddress();
    await confirmed(kim);
    await publishEntry("Dark mode", {});
    await publishEntry("Exports", { emailSubscribers: false });
    expect(entryEmailsTo(kim)).toEqual([]);
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
    expect(await entryTold(entry.id)).toBeNull();
  });

  test("once per entry and subscriber: not again from a second run, nor when it's unpublished and published again (not even to people who confirmed since)", async () => {
    const kim = newAddress();
    await confirmed(kim);
    const number = await publishEntry("Dark mode");
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } });
    expect(entry.subscribersEmailDueAt).toBeNull();
    await prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailDueAt: new Date() } });
    await handlers.changelogEmailed({ entryId: entry.id }, log);

    const lee = newAddress();
    await confirmed(lee);
    await call(unpublishChangelogEntry, team(), { number });
    await call(publishChangelogEntry, team(), { number, emailSubscribers: true });
    expect(entryEmailsTo(kim)).toHaveLength(1);
    expect(entryEmailsTo(lee)).toEqual([]);
  });

  test("taken off the portal before its emails went, publishing it again sends them (once)", async () => {
    const kim = newAddress();
    await confirmed(kim);
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    // Its job hasn't run (queued on the worker) when the team unpublishes it; then it runs.
    const queued = await import("@tuti/jobs");
    const enqueue = vi.spyOn(queued, "enqueue").mockResolvedValue(undefined);
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    enqueue.mockRestore();
    await call(unpublishChangelogEntry, team(), { number: entry.number });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    await handlers.changelogEmailed({ entryId: id }, log);
    expect(entryEmailsTo(kim)).toEqual([]);

    // Published again (without asking to email: it was asked for before), they go.
    await call(publishChangelogEntry, team(), { number: entry.number });
    expect(entryEmailsTo(kim)).toHaveLength(1);
  });

  test("published again days later with emails still to send, it's due from then: if its job isn't queued, the cron sends them", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const kim = newAddress();
    await confirmed(kim);
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    // Its job is never queued, the first time or the next (the queue is down: it's only logged).
    const jobs = await import("@tuti/jobs");
    const enqueue = vi.spyOn(jobs, "enqueue").mockRejectedValue(new Error("queue down"));
    onTestFinished(() => enqueue.mockRestore());
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    await call(unpublishChangelogEntry, team(), { number: entry.number });
    // Two days on, published again.
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
    await call(publishChangelogEntry, team(), { number: entry.number });
    enqueue.mockRestore();
    expect(entryEmailsTo(kim)).toEqual([]);

    // A quarter of an hour on, the cron finds it (due from the second publish, not the first) and sends it.
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 1, queued: 1 });
    expect(entryEmailsTo(kim)).toHaveLength(1);
  });

  describe("a send that takes more than a minute (its claim renewed meanwhile)", () => {
    /** Kim confirmed and the entry published, its job not run yet: its id, Kim's subscriber id and address. */
    async function waiting() {
      const kim = newAddress();
      await confirmed(kim);
      const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
      const jobs = await import("@tuti/jobs");
      const enqueue = vi.spyOn(jobs, "enqueue").mockResolvedValue(undefined);
      await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
      enqueue.mockRestore();
      const { id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
      const { id: subscriberId } = await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: kim } });
      // While Kim's email is sent, `meanwhile` happens, then a minute passes: the heartbeat renews the claim.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const aMinuteOn = (meanwhile: () => Promise<unknown>) => {
        sending.hook = async (to) => {
          if (to === kim) {
            sending.hook = null;
            await meanwhile();
            vi.advanceTimersByTime(60_000);
            // The renewal's queries, done.
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        };
      };
      return { kim, entryId, subscriberId, aMinuteOn };
    }

    test("a renewal that fails is logged, not left to reject (which would stop the worker): the email is sent and marked sent", async () => {
      const { kim, entryId, aMinuteOn } = await waiting();
      const updateMany = prisma.changelogEmail.updateMany.bind(prisma.changelogEmail);
      const renewals = vi
        .spyOn(prisma.changelogEmail, "updateMany")
        // Renewals (they set claimedAt) fail; marking it sent works.
        .mockImplementation(((args: { data: { claimedAt?: Date } }) =>
          args.data.claimedAt ? Promise.reject(new Error("database away")) : updateMany(args as Parameters<typeof updateMany>[0])) as unknown as typeof updateMany);
      onTestFinished(() => renewals.mockRestore());
      aMinuteOn(async () => {});
      const warned: string[] = [];
      await handlers.changelogEmailed({ entryId }, { info: () => {}, warn: (message) => warned.push(message) });
      expect(renewals).toHaveBeenCalledWith(expect.objectContaining({ data: { claimedAt: expect.any(Date) } }));
      expect(warned).toEqual([expect.stringContaining("couldn't renew the claim")]);
      expect(entryEmailsTo(kim)).toHaveLength(1);
      expect(await prisma.changelogEmail.findFirstOrThrow({ where: { entryId } })).toMatchObject({ sentAt: expect.any(Date) });
    });

    test("a claim another run took over meanwhile is left to it: not marked sent or released by this run, and the entry stays due", async () => {
      const { kim, entryId, subscriberId, aMinuteOn } = await waiting();
      const theirs = new Date(Date.now() + 30_000);
      aMinuteOn(() => prisma.changelogEmail.update({ where: { entryId_subscriberId: { entryId, subscriberId } }, data: { claimedAt: theirs } }));
      const warned: string[] = [];
      expect(await handlers.changelogEmailed({ entryId }, { info: () => {}, warn: (message) => warned.push(message) })).toMatchObject({ emailed: 1, left: 1 });
      expect(warned).toEqual([expect.stringContaining("another run took over")]);
      expect(entryEmailsTo(kim)).toHaveLength(1);
      expect(await prisma.changelogEmail.findFirstOrThrow({ where: { entryId } })).toMatchObject({ claimedAt: theirs, sentAt: null });
      expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId } })).subscribersEmailDueAt).not.toBeNull();
    });
  });

  test("a run clears only the due time it read: one set meanwhile (published again) stays for the cron", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const kim = newAddress();
    await confirmed(kim);
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    // The run has read the entry; as Kim's email goes out, the team unpublishes it and publishes it again a minute on
    // (its new job not run yet), which makes it due from then.
    const jobs = await import("@tuti/jobs");
    sending.hook = async (to) => {
      if (to === kim) {
        sending.hook = null;
        const enqueue = vi.spyOn(jobs, "enqueue").mockResolvedValue(undefined);
        await call(unpublishChangelogEntry, team(), { number: entry.number });
        vi.setSystemTime(Date.now() + 60_000);
        await call(publishChangelogEntry, team(), { number: entry.number });
        enqueue.mockRestore();
      }
    };
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    expect(entryEmailsTo(kim)).toHaveLength(1);
    // The first run, done, didn't clear the second publish's due time.
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).subscribersEmailDueAt).toEqual(new Date());
  });

  test("someone who unsubscribes or turns the project's emails off while it's being sent isn't emailed (consent is read as each one's claimed)", async () => {
    const [kim, lee] = [newAddress(), newAddress()];
    const ada = await signUp("Ada");
    await confirmed(kim);
    const leeToken = await confirmed(lee);
    await confirmed(ada.email);
    // The run read all three; as Kim's email goes out, Lee unsubscribes and Ada turns the project's emails off.
    const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: ada.id } });
    sending.hook = async (to) => {
      if (to === kim) {
        sending.hook = null;
        await unsubscribe(leeToken);
        const url = `http://${project.slug}.localhost:3100/portal/${project.slug}/unsubscribe/confirm?token=${unsubscribeToken}`;
        await optOutRoute(new Request(url, { method: "POST" }), { params: params() });
      }
    };
    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim)).toHaveLength(1);
    expect([...entryEmailsTo(lee), ...entryEmailsTo(ada.email)]).toEqual([]);
    // Nobody left to email: done.
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).subscribersEmailDueAt).toBeNull();
  });

  test("an opt-out counts at the address the project's emails go to: one its SSO gives, or either of two accounts differing in case", async () => {
    const sso = newAddress();
    const sam = await ssoUser(sso);
    await confirmed(sso);
    await optOut(sam.id);
    // Two accounts at one address in different case: one's opt-out (before Kim confirmed, even) counts for both.
    const kim = newAddress();
    const [upper, lower] = [await signUp("Kim"), await signUp("Kim again")];
    await prisma.user.update({ where: { id: upper.id }, data: { email: kim.toUpperCase() } });
    await prisma.user.update({ where: { id: lower.id }, data: { email: kim } });
    await optOut(upper.id);
    await confirmed(kim);
    await publishEntry("Dark mode");
    expect([...entryEmailsTo(sso), ...entryEmailsTo(kim)]).toEqual([]);
  });

  test("the editor's count is who'd be emailed: not people who've turned the project's emails off", async () => {
    const ada = await signUp("Ada");
    await confirmed(ada.email);
    await confirmed();
    expect(await subscriberCount(project.id)).toBe(2);
    await optOut(ada.id);
    expect(await subscriberCount(project.id)).toBe(1);
  });

  test("a claim takes the project's lock before the entry's, as publishing does, so the two can't deadlock", async () => {
    const kim = newAddress();
    await confirmed(kim);
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    const jobs = await import("@tuti/jobs");
    const enqueue = vi.spyOn(jobs, "enqueue").mockResolvedValue(undefined);
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    enqueue.mockRestore();
    const { id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    // As publishing does (lockProject, then the entry), while the job's claim comes in between.
    let run!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${project.id} FOR UPDATE`;
      run = handlers.changelogEmailed({ entryId }, log);
      // Once the claim waits on a lock (the project's row, now: holding nothing the entry's update needs).
      await waitingOnALock();
      await tx.changelogEntry.update({ where: { id: entryId }, data: { title: "Dark mode is here" } });
    });
    // Both went through: the update, and the email (as the run read the entry when it began).
    await run;
    expect(entryEmailsTo(kim)).toHaveLength(1);
  });

  test("unpublished, or its portal made private, while it's being sent: the rest aren't emailed, and published again they are", async () => {
    const [kim, lee, ada] = [newAddress(), newAddress(), newAddress()];
    for (const address of [kim, lee, ada]) {
      await confirmed(address);
    }
    // As Kim's email goes out, the team unpublishes it.
    sending.hook = async (to) => {
      if (to === kim) {
        sending.hook = null;
        await call(unpublishChangelogEntry, team(), { number: 1 });
      }
    };
    await publishEntry("Dark mode");
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length, entryEmailsTo(ada).length]).toEqual([1, 0, 0]);
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(entry.subscribersEmailDueAt).not.toBeNull();

    // Published again: Lee's goes, then the portal's made private as it does.
    sending.hook = async (to) => {
      if (to === lee) {
        sending.hook = null;
        await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
      }
    };
    await call(publishChangelogEntry, team(), { number: 1 });
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length, entryEmailsTo(ada).length]).toEqual([1, 1, 0]);
  });

  test("told counts each address once: someone the project's SSO emails, told both that their post shipped and by the changelog", async () => {
    const sso = newAddress();
    const sam = await ssoUser(sso);
    await confirmed(sso);
    const post = await call(createPost, { actor: { kind: "user", userId: sam.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x", posts: [post.number] });
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    expect(emailsTo(sso).map((email) => email.subject)).toEqual(expect.arrayContaining([`Done: Dark mode`, `${project.name}: Dark mode`]));
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(await entryTold(id)).toBe(1);
  });

  test("turned all of the project's emails off after confirming: no changelog either; the long-lived link (forwarded, say) can't turn them back on, only a fresh one emailed to the address", async () => {
    const ada = await signUp("Ada");
    const token = await confirmed(ada.email);
    await optOut(ada.id);
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toEqual([]);
    expect(await page({ token })).toBe(
      `${project.name}'s changelog isn't emailed to you You've turned off all of ${project.name}'s emails, so its changelog isn't emailed to ${ada.email} either. ` +
        `To turn them back on, we'll email ${ada.email} a link. Email me a link Unsubscribe`,
    );
    // Someone holding the subscription's link (a forwarded changelog email's Unsubscribe) can only have a link emailed.
    const asked = await emailsOn(token);
    expect(asked.headers.get("location")).toBe(`/changelog/subscription?token=${token}&sent=1`);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(1);
    expect(await page({ token, sent: "1" })).toContain(`We sent ${ada.email} a link to turn them back on. Unsubscribe`);
    // The address's owner uses it: their emails are back on, the changelog with them; once.
    const link = await confirmationTo(ada.email);
    expect((await mailbox.latestTo(ada.email)).text).toContain(`you've turned off all of ${project.name}'s emails, so nothing is sent to you until you turn them back on`);
    expect(await page({ confirm: link })).toContain(`Turn ${project.name}'s emails back on`);
    expect((await confirm(link, true)).status).toBe(303);
    expect((await confirm(link, true)).status).toBe(404);
    expect(await prisma.emailOptOut.count({ where: { userId: ada.id } })).toBe(0);
    expect(await page({ token })).toContain(`You get ${project.name}'s updates by email`);
    await publishEntry("Exports");
    expect(entryEmailsTo(ada.email).map((email) => email.subject)).toEqual([`${project.name}: Exports`]);
  });

  test("turned all of the project's emails off, then subscribed: the email and the confirmation page say up front nothing comes until they turn them back on", async () => {
    const ada = await signUp("Ada");
    await optOut(ada.id);
    const unsubscribePage = async () => {
      const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: ada.id } });
      const rendered = await UnsubscribePage({
        params: params(),
        searchParams: Promise.resolve({ token: unsubscribeToken }),
      } as PageProps<"/portal/[project]/unsubscribe">);
      return renderToStaticMarkup(rendered).replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
    };
    expect(await unsubscribePage()).toBe(`You're unsubscribed ${project.name} won't email you anymore.`);

    // The email promises nothing, and the page says so before anything's pressed, with its one button.
    expect(await subscribe(ada.email)).toEqual({ sentTo: ada.email });
    const message = await mailbox.latestTo(ada.email);
    expect(message.subject).toBe(`Turn ${project.name}'s emails back on?`);
    expect(message.text).not.toContain("Confirm to get");
    const link = await confirmationTo(ada.email);
    expect(await page({ confirm: link })).toBe(
      `You've turned off all of ${project.name}'s emails Nothing is emailed to ${ada.email}, the changelog included, until you turn them back on. ` +
        `Then you'll get its new entries, and hear when posts you asked for are done. Turn ${project.name}'s emails back on`,
    );
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toEqual([]);

    // Turned back on: the Unsubscribe page offers to stop them all again, the changelog included.
    expect((await confirm(link, true)).status).toBe(303);
    expect(await unsubscribePage()).toContain(`Stop emails from ${project.name}?`);
    await publishEntry("Exports");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);
  });

  test("not to people who turned the project's emails off", async () => {
    const kim = await signUp("Kim");
    await confirmed(kim.email);
    const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: kim.id } });
    const url = `http://${project.slug}.localhost:3100/portal/${project.slug}/unsubscribe/confirm?token=${unsubscribeToken}`;
    await optOutRoute(new Request(url, { method: "POST" }), { params: params() });
    const lee = newAddress();
    await confirmed(lee);

    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim.email)).toEqual([]);
    expect(entryEmailsTo(lee)).toHaveLength(1);
  });

  test("never from a private portal", async () => {
    const kim = newAddress();
    await confirmed(kim);
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim)).toEqual([]);
    // Not counted as emailed: public again, it can be.
    expect((await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } })).subscribersEmailedAt).toBeNull();
  });
});

describe("the project's email limits", () => {
  beforeEach(() => {
    vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
    vi.stubEnv("PLANS", "on");
  });

  test("past a new project's daily cap the rest wait, still due, and the cron sends them once they may", async () => {
    // One day throughout (the cap is per UTC day).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const [kim, lee] = [newAddress(), newAddress()];
    await confirmed(kim);
    await confirmed(lee);
    // One left today.
    await prisma.projectEmailDay.upsert({
      where: { projectId_day: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)) } },
      create: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 199 },
      update: { claimed: 199 },
    });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim).length + entryEmailsTo(lee).length).toBe(1);
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(entry.subscribersEmailDueAt).not.toBeNull();

    // The cron leaves it while the cap's used up; a week old (no cap), it sends the rest.
    const lateBy = (minutes: number) =>
      prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailDueAt: new Date(Date.now() - minutes * 60_000) } });
    await lateBy(15);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 0, queued: 0 });
    await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
    // Not before it's late (its own run may still be going), nor once it's two days old.
    await lateBy(5);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 0, queued: 0 });
    await lateBy(49 * 60);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 0, queued: 0 });
    await lateBy(15);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 1, queued: 1 });
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length]).toEqual([1, 1]);
    expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).subscribersEmailDueAt).toBeNull();
  });

  test("a subscriber another run held, then let go at the cap, keeps the entry due: the cron sends theirs", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const [kim, lee] = [newAddress(), newAddress()];
    await confirmed(kim);
    await confirmed(lee);
    const kimId = (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: kim } })).id;
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    const { id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    // Another run has Kim (its claim fresh), so this run skips her and emails Lee; meanwhile that run hits the
    // project's daily cap and lets Kim go.
    await prisma.changelogEmail.create({ data: { entryId, subscriberId: kimId } });
    await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 198 } });
    sending.hook = async (to) => {
      if (to === lee) {
        sending.hook = null;
        await prisma.changelogEmail.deleteMany({ where: { entryId, subscriberId: kimId, sentAt: null } });
        await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { claimed: 200 } });
      }
    };
    await call(publishChangelogEntry, team(), { number: entry.number, emailSubscribers: true });
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length]).toEqual([0, 1]);
    // Kim has nothing sent: still due (the editor says one is still to go).
    expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId } })).subscribersEmailDueAt).not.toBeNull();
    expect(await subscribersLeft(entryId)).toBe(1);
    // On a portal gone private, nobody's left to email (the job sends nothing there), so the editor promises none.
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    expect(await subscribersLeft(entryId)).toBe(0);
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });

    // Tomorrow's cap (a week on, none): the cron sends hers.
    await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
    await prisma.changelogEntry.update({ where: { id: entryId }, data: { subscribersEmailDueAt: new Date(Date.now() - 15 * 60_000) } });
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 1, queued: 1 });
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length]).toEqual([1, 1]);
    expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId } })).subscribersEmailDueAt).toBeNull();
    expect(await subscribersLeft(entryId)).toBe(0);
  });

  test("held at the cap just after midnight, the cron still sends the rest a day on, once the cap's day is over", async () => {
    // Just after midnight (UTC).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${new Date().toISOString().slice(0, 10)}T00:05:00Z`) });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date() } });
    const [kim, lee] = [newAddress(), newAddress()];
    await confirmed(kim);
    await confirmed(lee);
    await prisma.projectEmailDay.upsert({
      where: { projectId_day: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)) } },
      create: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 199 },
      update: { claimed: 199 },
    });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim).length + entryEmailsTo(lee).length).toBe(1);
    // The cap's day goes on till midnight: the cron leaves it. Ten minutes into the next day it's 24h05m due.
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await handlers.resubmitChangelogEmails({}, log);
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length]).toEqual([1, 1]);
  });

  test("while the project's email is paused, no confirmation goes either: not from the box, nor \"Email me a link\"", async () => {
    const ada = await signUp("Ada");
    const token = await confirmed(ada.email);
    await optOut(ada.id);
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
    const kim = newAddress();
    // The same answer, nothing sent.
    expect(await subscribe(kim)).toEqual({ sentTo: kim });
    expect(emailsTo(kim)).toEqual([]);
    const before = emailsTo(ada.email).length;
    expect((await emailsOn(token)).status).toBe(503);
    expect(emailsTo(ada.email)).toHaveLength(before);
  });

  test("opted out while the project's email is paused: the page offers no link it couldn't send, and says when it can", async () => {
    const ada = await signUp("Ada");
    const token = await confirmed(ada.email);
    await optOut(ada.id);
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
    const text = await page({ token });
    expect(text).toContain(`${project.name}'s emails are paused for now: come back here once they're resumed, and we'll email ${ada.email} a link to turn them back on.`);
    expect(text).not.toContain("Email me a link");
    expect(text).toContain("Unsubscribe");
  });

  test("while the project's email is paused nothing goes; it's still due", async () => {
    const kim = newAddress();
    await confirmed(kim);
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(kim)).toEqual([]);
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(entry.subscribersEmailDueAt).not.toBeNull();
    // Nor does the cron pick it up meanwhile.
    await prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailDueAt: new Date(Date.now() - 15 * 60_000) } });
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 0, queued: 0 });
  });

  test("resumed after a pause longer than a day, the entries it held are due again: the cron sends them", async () => {
    vi.stubEnv("APP_PORTAL_OWNER", "e2e-operator@example.com");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const kim = newAddress();
    await confirmed(kim);
    const pausedAt = new Date();
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: pausedAt } });
    await publishEntry("Dark mode");
    // Two days on, the operator resumes it.
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
    expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 1, queued: 1 });
    expect(entryEmailsTo(kim)).toHaveLength(1);
  });
});
