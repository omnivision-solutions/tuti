import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { handlers, resumeToken, subscribersLeft } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import SubscriptionPage from "@/app/portal/[project]/(site)/changelog/subscription/page";
import { POST as confirmRoute } from "@/app/portal/[project]/(site)/changelog/subscription/confirm/route";
import { POST as unsubscribeRoute } from "@/app/portal/[project]/(site)/changelog/subscription/unsubscribe/route";
import { POST as optOutRoute } from "@/app/portal/[project]/(site)/unsubscribe/confirm/route";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR } from "@/lib/sign-in-link";
import { entryTold } from "@/server/changelog-queries";
import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { subscribeToChangelog } from "./changelog-subscribe";
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

/** The token in the latest confirmation email to `email`. */
async function confirmationTo(email: string) {
  const message = await mailbox.latestTo(email);
  expect(message.subject).toBe(`Confirm ${project.name}'s updates by email`);
  const link = new URL(message.text.split(/\s+/).find((word) => word.includes("/changelog/subscription?"))!);
  return link.searchParams.get("token")!;
}

const routeUrl = (action: string, token: string) =>
  `http://${project.slug}.localhost:3100/portal/${project.slug}/changelog/subscription/${action}?token=${encodeURIComponent(token)}`;
const params = () => Promise.resolve({ project: project.slug });
const confirm = (token: string) => confirmRoute(new Request(routeUrl("confirm", token), { method: "POST" }), { params: params() });
const unsubscribe = (token: string, oneClick = false) =>
  unsubscribeRoute(
    new Request(routeUrl("unsubscribe", token), { method: "POST", ...(oneClick && { body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }) }),
    { params: params() },
  );

/** Subscribes `email` and confirms it from the email: their token. */
async function confirmed(email = newAddress()) {
  expect(await subscribe(email)).toEqual({ sentTo: email });
  const token = await confirmationTo(email);
  expect((await confirm(token)).status).toBe(303);
  return token;
}

/** The subscription page's text for `token`. */
async function page(token: string, unsubscribed = false) {
  const rendered = await SubscriptionPage({
    params: params(),
    searchParams: Promise.resolve({ token, ...(unsubscribed && { unsubscribed: "1" }) }),
  } as PageProps<"/portal/[project]/changelog/subscription">);
  return renderToStaticMarkup(rendered).replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
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
    const token = await confirmationTo(kim);
    expect(await page(token)).toContain(`Get ${project.name}'s updates by email? New entries in the changelog go to ${kim}`);

    // Lee never confirms.
    expect((await confirm(token)).headers.get("location")).toBe(`/changelog/subscription?token=${token}`);
    expect(await page(token)).toContain(`You get ${project.name}'s updates by email`);
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
    expect(fromPage.headers.get("location")).toBe(`/changelog/subscription?token=${kimToken}&unsubscribed=1`);
    expect(await page(kimToken, true)).toContain(`You're unsubscribed ${project.name}'s changelog won't be emailed to ${kim} anymore.`);
    const oneClick = await unsubscribe(leeToken, true);
    expect(oneClick.status).toBe(200);
    // A portal under a path of the team's site goes back to the page there.
    request.headers = { "x-tuti-base": "/updates" };
    expect((await unsubscribe(kimToken)).headers.get("location")).toBe(`/updates/changelog/subscription?token=${kimToken}&unsubscribed=1`);
    expect((await confirm(kimToken)).headers.get("location")).toBe(`/updates/changelog/subscription?token=${kimToken}`);
    await unsubscribe(kimToken);
    request.headers = {};
    await publishEntry("Dark mode");
    expect([...entryEmailsTo(kim), ...entryEmailsTo(lee)]).toEqual([]);

    // Back on the portal: confirmed again before anything is sent.
    expect(await subscribe(kim)).toEqual({ sentTo: kim });
    const again = await confirmationTo(kim);
    await publishEntry("Exports");
    expect(entryEmailsTo(kim)).toEqual([]);
    await confirm(again);
    await publishEntry("Search");
    expect(entryEmailsTo(kim).map((email) => email.subject)).toEqual([`${project.name}: Search`]);
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
    const token = await confirmed();
    const other = await createProject(owner);
    const elsewhere = await confirmRoute(new Request(routeUrl("confirm", token).replaceAll(project.slug, other.slug), { method: "POST" }), {
      params: Promise.resolve({ project: other.slug }),
    });
    expect(elsewhere.status).toBe(404);

    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    const kim = newAddress();
    expect(await subscribe(kim)).toEqual({ error: "Updates by email aren't available here." });
    expect(emailsTo(kim)).toEqual([]);
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

  test("someone who turned the project's emails off, then subscribed and confirmed, gets the changelog: the newer word counts", async () => {
    const ada = await signUp("Ada");
    const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: ada.id } });
    const url = `http://${project.slug}.localhost:3100/portal/${project.slug}/unsubscribe/confirm?token=${unsubscribeToken}`;
    await optOutRoute(new Request(url, { method: "POST" }), { params: params() });
    await confirmed(ada.email);
    await publishEntry("Dark mode");
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
    // Not before it's late (its own run may still be going), nor once it's a day old.
    await lateBy(5);
    expect(await handlers.resubmitChangelogEmails({}, log)).toEqual({ found: 0, queued: 0 });
    await lateBy(25 * 60);
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
