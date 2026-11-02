import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { changelogReach, type ChangelogReach, handlers, reached, resumeToken, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import AccountPage from "@/app/portal/[project]/(site)/account/page";
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
import { emailPreferences, updateEmailPreferences } from "@/server/operations/email-preferences";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { subscribeToChangelog } from "./changelog-subscribe";
import { setEmailPreference } from "./email-preferences";
import { addSampleContent } from "./sample-content";
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
// The Account page's forms' router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/account",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

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

/**
 * Until a claim (in another connection) waits on its lock of the project's row, by asking Postgres: in this file's own
 * database only (other test files share the server), and only the claim's statement (it reads "portalAccess" FOR SHARE).
 */
async function waitingOnALock() {
  for (let tries = 0; tries < 300; tries++) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND query ILIKE '%"portalAccess"%FOR SHARE%'`;
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
    // It promises only the entries the team emails (publishing asks each time).
    expect((await mailbox.latestTo(kim)).text).toContain(`Confirm to get the changelog entries ${project.name} emails to subscribers`);
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
    const elsewhere = (route: (request: Request, context: { params: Promise<{ project: string }> }) => Promise<Response>, action: string, query: string) =>
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

  test("the editor's counts are the sender's audience, counted in the database: paused, private, unconfirmed, opted out, already sent", async () => {
    vi.stubEnv("PLANS", "on");
    // Every query the counts make returns a row at most: no subscriber's row leaves the database to be counted.
    const queries = vi.spyOn(prisma, "$queryRaw");
    const count = async <T,>(counting: Promise<T>) => {
      queries.mockClear();
      const result = await counting;
      for (const { value } of queries.mock.results) {
        expect(((await value) as unknown[]).length).toBeLessThanOrEqual(1);
      }
      return result;
    };
    const ada = await signUp("Ada");
    await confirmed(ada.email);
    await optOut(ada.id);
    await unsubscribe(await confirmed());
    const [kim, lee] = [newAddress(), newAddress()];
    await confirmed(kim);
    await confirmed(lee);
    expect(await count(subscriberCount(project.id))).toBe(2);

    // Paused: still who it's for; the job waits.
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
    expect(await count(subscriberCount(project.id))).toBe(2);
    await publishEntry("Dark mode");
    const { id: entryId } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    expect(await count(subscribersLeft(entryId))).toBe(2);
    // Already sent to Kim (a run before the pause): Lee is left.
    const kimId = (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: kim } })).id;
    await prisma.changelogEmail.create({ data: { entryId, subscriberId: kimId, sentAt: new Date() } });
    expect(await count(subscribersLeft(entryId))).toBe(1);
    // Private: nobody.
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    expect(await count(subscriberCount(project.id))).toBeNull();
    expect(await count(subscribersLeft(entryId))).toBe(0);

    // Public and resumed, the sender emails exactly who was left.
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC", emailPausedAt: null } });
    expect(await handlers.changelogEmailed({ entryId }, log)).toMatchObject({ emailed: 1 });
    expect([entryEmailsTo(kim).length, entryEmailsTo(lee).length]).toEqual([0, 1]);
    expect(await count(subscribersLeft(entryId))).toBe(0);
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

  test("a big list (past what one query's parameters could hold as addresses): counted, opt-outs and all, in the database", async () => {
    const ada = await signUp("Ada");
    await confirmed(ada.email);
    await optOut(ada.id);
    // 16,500 more: as two lists of addresses (account and SSO), 33,000 parameters, past Postgres's 32,767. Confirmed as
    // of this process's clock (not the database's now()), which the counts below compare against.
    const confirmedAt = new Date();
    await prisma.$executeRaw`
      INSERT INTO "changelog_subscriber" ("id", "projectId", "email", "confirmedAt")
      SELECT 'bulk-' || ${project.id} || '-' || g, ${project.id}, 'e2e-bulk-' || g || '-' || ${project.slug} || '@example.com', ${confirmedAt}
      FROM generate_series(1, 16500) g`;
    expect(await subscriberCount(project.id)).toBe(16_500);
    // What an entry still has to go to, as the editor and the job read it.
    const entry = await call(createChangelogEntry, team(), { title: "Dark mode", body: "x" });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
    // Due, but not published: the cron (which other tests here run) leaves it, rather than emailing 16,500 people.
    await prisma.changelogEntry.update({ where: { id }, data: { subscribersEmailedAt: new Date(Date.now() + 1000), subscribersEmailDueAt: new Date() } });
    expect(await subscribersLeft(id)).toBe(16_500);
    await prisma.changelogEntry.update({ where: { id }, data: { subscribersEmailDueAt: null } });
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
        `Then the changelog entries ${project.name} emails to subscribers come to you, and you'll hear when posts you asked for are done. Turn ${project.name}'s emails back on`,
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

  test("never a sample entry (Home's sample content): not when published with Email subscribers, nor if it were ever due", async () => {
    const kim = newAddress();
    await confirmed(kim);
    await addSampleContent(project.id, owner.id);
    const sample = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, sample: true } });
    await call(unpublishChangelogEntry, team(), { number: sample.number });
    await call(publishChangelogEntry, team(), { number: sample.number, emailSubscribers: true });
    expect(entryEmailsTo(kim)).toEqual([]);
    expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: sample.id } })).subscribersEmailedAt).toBeNull();
    // The job refuses one too, however it came to be due.
    await prisma.changelogEntry.update({ where: { id: sample.id }, data: { subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });
    expect(await handlers.changelogEmailed({ entryId: sample.id }, log)).toEqual({ skipped: true });
    expect(entryEmailsTo(kim)).toEqual([]);
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

describe("the Account's opt-out", () => {
  test("someone who hasn't proven an address can't stop its changelog emails: signed up as a subscriber's address and never confirmed, Stop emails is refused and the entry still arrives", async () => {
    const victim = newAddress();
    await confirmed(victim);
    // Signed up with the subscriber's address, never confirmed.
    const impostor = await signUp("Impostor", victim);
    actAs(impostor);
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ error: "Confirm your email address to stop these emails" });
    expect(await prisma.emailOptOut.count({ where: { userId: impostor.id } })).toBe(0);
    expect(await changelogReach(project.id, { email: victim, confirmed: true })).toBe("gets");
    // Their own switches only touch their own account: allowed.
    expect(await setEmailPreference(project.slug, "followedPosts", false)).toEqual({});
    await publishEntry("Dark mode");
    expect(entryEmailsTo(victim)).toHaveLength(1);

    // Confirmed, the address is theirs: they may stop the project's emails to it, the changelog's included.
    await prisma.user.update({ where: { id: impostor.id }, data: { emailVerified: true } });
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    expect(await changelogReach(project.id, { email: victim, confirmed: true })).toBe("opted-out");
  });
});

describe("the Account's changelog switch", () => {
  const verified = async (name: string) => {
    const user = await signUp(name);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    return user;
  };
  /** The signed-in person's changelog switch on their Account: whether it's there, on, and may be clicked. */
  const changelogSwitch = async () => {
    const html = renderToStaticMarkup(await AccountPage({ params: params() } as never));
    const input = html.match(/<input [^>]*id="email-changelog"[^>]*>/)?.[0];
    return input === undefined ? undefined : { on: input.includes('checked=""'), disabled: input.includes('disabled=""') };
  };

  test("a confirmed reader turns it on (confirmed at once, no email asks) and an entry arrives; off is the unsubscribe link's way, and the next doesn't", async () => {
    const ada = await verified("Ada");
    actAs(ada);
    expect(await changelogSwitch()).toEqual({ on: false, disabled: false });
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    expect(await changelogSwitch()).toEqual({ on: true, disabled: false });
    expect(await emailPreferences(project.id, ada.id)).toMatchObject({ changelog: true });
    expect(emailsTo(ada.email).filter((email) => !email.subject.startsWith("Verify your email"))).toEqual([]);
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);

    expect(await setEmailPreference(project.slug, "changelog", false)).toEqual({});
    expect(await changelogSwitch()).toEqual({ on: false, disabled: false });
    // Unsubscribed as by the email's link: its page says so.
    expect(await page({ token: await tokenOf(ada.email) })).toContain("You're unsubscribed");
    await publishEntry("Exports");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);
  });

  test("an address not yet confirmed: the switch is disabled, and turning it on or off is refused (someone signed up as a subscriber's address can't stop theirs)", async () => {
    const victim = newAddress();
    await confirmed(victim);
    actAs(await signUp("Impostor", victim));
    // Their address's subscription isn't shown them: it would tell anyone who signs up as an address whether it's subscribed.
    expect(await changelogSwitch()).toEqual({ on: false, disabled: true });
    for (const on of [false, true]) {
      expect(await setEmailPreference(project.slug, "changelog", on)).toEqual({ error: "Confirm your email address first" });
    }
    await publishEntry("Dark mode");
    expect(entryEmailsTo(victim)).toHaveLength(1);

    actAs(await signUp("Cy"));
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({ error: "Confirm your email address first" });
    expect(await prisma.changelogSubscriber.count({ where: { projectId: project.id } })).toBe(1);
  });

  test("Stop emails about posts wins: the switch is off and disabled, and nothing's sent, until they turn them back on", async () => {
    const ada = await verified("Ada");
    actAs(ada);
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    // The save says the switch is off now, so the page shows it so at once.
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    expect(await changelogSwitch()).toEqual({ on: false, disabled: true });
    expect(await emailPreferences(project.id, ada.id)).toMatchObject({ changelog: false });
    // Turning it on would send nothing: refused (the page has it disabled).
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({ error: "Emails to your address are turned off, so the changelog can't be sent to it." });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toEqual([]);

    expect(await setEmailPreference(project.slug, "unsubscribed", false)).toEqual({ changelog: true });
    expect(await changelogSwitch()).toEqual({ on: true, disabled: false });
    await publishEntry("Exports");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);
  });

  test("where no email is sent (no email settings), there's no switch, and turning it on is refused", async () => {
    vi.stubEnv("SMTP_HOST", "");
    actAs(await verified("Ada"));
    expect(await changelogSwitch()).toBeUndefined();
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({ error: "Updates by email aren't available here." });
  });

  test("an API key can turn the changelog off for someone from its app, the unsubscribe link's way, never on", async () => {
    const email = newAddress();
    const user = await ssoUser(email);
    actAs(user);
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
    const { externalId } = await prisma.ssoIdentity.findFirstOrThrow({ where: { userId: user.id } });
    await expect(call(updateEmailPreferences, key, { changelog: true, author: { id: externalId } })).rejects.toThrow("Only the person themselves can turn their emails back on");
    expect(await call(updateEmailPreferences, key, { changelog: false, author: { id: externalId } })).toMatchObject({ changelog: false });
    expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).confirmedAt).toBeNull();
    expect(await page({ token: await tokenOf(email) })).toContain("You're unsubscribed");
  });

  test("an opt-out by another account at the same address wins too: the switch shows off, and turning it on is refused", async () => {
    vi.stubEnv("PLANS", "on");
    const email = newAddress();
    // Someone the project's SSO emails at an address, and an account of their own there, which turned the emails off.
    const sso = await ssoUser(email);
    const own = await signUp("Sam", email);
    await prisma.user.update({ where: { id: own.id }, data: { emailVerified: true } });
    actAs(sso);
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    expect(await changelogSwitch()).toEqual({ on: true, disabled: false });
    actAs(own);
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });

    actAs(sso);
    expect(await changelogReach(project.id, { email, confirmed: true })).toBe("opted-out");
    expect(await emailPreferences(project.id, sso.id)).toEqual({ ownPosts: true, followedPosts: true, unsubscribed: false, changelog: false });
    expect((await changelogSwitch())?.on).toBe(false);
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({ error: "Emails to your address are turned off, so the changelog can't be sent to it." });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(email)).toEqual([]);
  });

  test("the team gets the changelog like anyone: its switch and Stop emails (which, for them, only stops it), without the post ones, under why it isn't emailed about posts", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
    actAs(owner);
    const html = renderToStaticMarkup(await AccountPage({ params: params() } as never)).replaceAll("&#x27;", "'");
    expect(html).toContain(`${project.name} doesn't email its team about posts.`);
    expect(html).not.toContain('id="email-followedPosts"');
    expect(html).toContain(`Stop emails from ${project.name}`);
    expect(html).toContain("No changelog emails, whatever's subscribed at your address. Your team's emails and sign-in emails still arrive.");
    expect(html).not.toContain("Stop emails about posts");
    expect(await changelogSwitch()).toEqual({ on: false, disabled: false });
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    expect(await changelogSwitch()).toEqual({ on: true, disabled: false });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(owner.email)).toHaveLength(1);
  });

  test("a team member who'd stopped the project's emails (as a reader, say) turns them back on from the Account, then gets the changelog", async () => {
    const ada = await verified("Ada");
    actAs(ada);
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    await prisma.teamMember.create({ data: { projectId: project.id, userId: ada.id, role: "MEMBER" } });
    const stopped = renderToStaticMarkup(await AccountPage({ params: params() } as never));
    expect(stopped).not.toContain('id="email-followedPosts"');
    expect(stopped.match(/<input [^>]*id="email-unsubscribed"[^>]*>/)![0]).not.toContain('disabled=""');
    expect(await changelogSwitch()).toEqual({ on: false, disabled: true });

    expect(await setEmailPreference(project.slug, "unsubscribed", false)).toEqual({ changelog: false });
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    expect(await changelogSwitch()).toEqual({ on: true, disabled: false });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);
  });

  test("turning their own opt-out off and the changelog on in one update works; another account's opt-out at the address refuses it, and the refused update changes nothing", async () => {
    const ada = await verified("Ada");
    const as = { actor: { kind: "user" as const, userId: ada.id }, projectId: project.id };
    actAs(ada);
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    expect(await call(updateEmailPreferences, as, { unsubscribed: false, changelog: true })).toMatchObject({ unsubscribed: false, changelog: true });
    await publishEntry("Dark mode");
    expect(entryEmailsTo(ada.email)).toHaveLength(1);

    // Another account at her address (the project's sign-on gives it) turns the emails off: her own going back on isn't enough.
    const sso = await ssoUser(ada.email);
    actAs(sso);
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    actAs(ada);
    expect(await setEmailPreference(project.slug, "changelog", false)).toEqual({});
    expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({ changelog: false });
    await expect(call(updateEmailPreferences, as, { unsubscribed: false, ownPosts: false, changelog: true })).rejects.toThrow(
      "Emails to your address are turned off, so the changelog can't be sent to it.",
    );
    // Refused, it changed nothing: her opt-out and her post switches are as they were.
    expect(await emailPreferences(project.id, ada.id)).toEqual({ ownPosts: true, followedPosts: true, unsubscribed: true, changelog: false });
  });

  test("a private portal emails nobody its changelog: no switch, and turning it on is refused", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    // One of its readers, who gets its emails about posts.
    const ada = await verified("Ada");
    await prisma.portalReader.create({ data: { projectId: project.id, email: ada.email } });
    actAs(ada);
    const html = renderToStaticMarkup(await AccountPage({ params: params() } as never));
    expect(html).toContain('id="email-followedPosts"');
    expect(await changelogSwitch()).toBeUndefined();
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({ error: "Updates by email aren't available here." });
    expect(await prisma.changelogSubscriber.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("the switch says what the sender does (changelogReach), at the address the project's emails go to (its SSO's)", async () => {
    vi.stubEnv("PLANS", "on");
    const email = newAddress();
    const sso = await ssoUser(email);
    actAs(sso);
    const check = async (expected: ChangelogReach) => {
      const subscriber = await prisma.changelogSubscriber.findFirst({ where: { projectId: project.id, email } });
      const reach = await changelogReach(project.id, { email, confirmed: subscriber?.confirmedAt != null });
      expect(reach).toBe(expected);
      expect((await changelogSwitch())?.on).toBe(reached(reach));
      expect(await subscriberCount(project.id)).toBe(reached(reach) ? 1 : 0);
    };
    await check("unconfirmed");
    expect(await setEmailPreference(project.slug, "changelog", true)).toEqual({});
    await check("gets");
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
    await check("paused");
    await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: null } });
    await optOut(sso.id);
    await check("opted-out");
    expect(await setEmailPreference(project.slug, "unsubscribed", false)).toEqual({ changelog: true });
    expect(await setEmailPreference(project.slug, "changelog", false)).toEqual({});
    await check("unconfirmed");
  });
});
