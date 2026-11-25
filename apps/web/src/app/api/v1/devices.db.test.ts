import { prisma } from "@tuti/db";
import { checkPushReceipts, enqueue, handlers, RECEIPT_AFTER_MS } from "@tuti/jobs";
import { deviceNotRegistered, type ExpoPushFake, startExpoPushFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/hosts";
import { createConversation, replyToConversation } from "@/server/operations/conversations";
import { registerDevice } from "@/server/operations/devices";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { DELETE, GET, PATCH, POST } from "./[...path]/route";

/**
 * The mobile app's phones and push notifications (packages/jobs push.ts): a teammate registers their phone with their
 * app session, and a user's message notifies the phones of exactly the teammates its email goes to, through a local
 * fake of Expo's push service.
 */

let expo: ExpoPushFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  expo = await startExpoPushFake();
});
afterAll(() => expo.close());

beforeEach(async () => {
  vi.stubEnv("EXPO_PUSH_URL", expo.env.EXPO_PUSH_URL);
  expo.sent = [];
  expo.unregistered.clear();
  expo.rateExceeded.clear();
  expo.errors.clear();
  expo.projects.clear();
  expo.failing.clear();
  expo.failSends.clear();
  expo.sends = 0;
  vi.stubEnv("EXPO_ACCESS_TOKEN", "");
  // Each test's own tickets and phones: the file shares one database.
  await prisma.pushTicket.deleteMany();
  await prisma.device.deleteMany();
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(null);
});

const tokenOf = (user: TestUser) => /session_token=([^;]+)/.exec(user.cookie)![1]!;

/** Calls the API as the app does: the teammate's session as the bearer token, the project in Tuti-Project. */
async function api(user: TestUser, method: "GET" | "PATCH" | "POST" | "DELETE", path: string, body?: unknown, slug = project.slug) {
  const url = new URL(`${appUrl().origin}/api/v1${path}`);
  const request = new Request(url, {
    method,
    headers: {
      host: appUrl().host,
      authorization: `Bearer ${tokenOf(user)}`,
      "tuti-project": slug,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await { GET, PATCH, POST, DELETE }[method](request, { params: Promise.resolve({ path: url.pathname.split("/").slice(3) }) });
  return { status: response.status, body: await response.json() };
}

const phone = (user: TestUser, name: string) => api(user, "POST", "/devices", { deviceId: `${name}-id`, token: `ExponentPushToken[${name}]`, platform: "ios" });

/** A user writes in: a new conversation, emailed to the team and pushed to their phones. */
const userWrites = (body = "The export button does nothing") =>
  call(createConversation, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { email: "e2e-asker@example.com", body });

/** Who the last push went to, by their token's name. */
const pushedTo = () => expo.sent.map((message) => /\[(.*)\]/.exec(message.to)![1]).sort();

test("a phone registers under its session, registering again replaces it, and it's removed", async () => {
  expect(await phone(owner, "first")).toEqual({ status: 200, body: { deviceId: "first-id" } });
  const session = await prisma.session.findFirstOrThrow({ where: { userId: owner.id } });
  expect(await prisma.device.findMany({ where: { userId: owner.id } })).toEqual([
    expect.objectContaining({ deviceId: "first-id", token: "ExponentPushToken[first]", platform: "ios", sessionId: session.id }),
  ]);

  // A new token for the same install: the same row, refreshed.
  const before = await prisma.device.findFirstOrThrow({ where: { userId: owner.id } });
  await api(owner, "POST", "/devices", { deviceId: "first-id", token: "ExponentPushToken[renewed]", platform: "ios" });
  const after = await prisma.device.findMany({ where: { userId: owner.id } });
  expect(after).toEqual([expect.objectContaining({ id: before.id, token: "ExponentPushToken[renewed]" })]);
  expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());

  // A reinstall that lost its id keeps the token: it replaces the old row rather than notifying twice.
  await api(owner, "POST", "/devices", { deviceId: "reinstalled-id", token: "ExponentPushToken[renewed]", platform: "ios" });
  expect(await prisma.device.findMany({ where: { userId: owner.id }, select: { deviceId: true } })).toEqual([{ deviceId: "reinstalled-id" }]);

  // Not a push token: refused.
  expect(await api(owner, "POST", "/devices", { deviceId: "x", token: "not-a-token", platform: "ios" })).toMatchObject({ status: 400 });

  // Someone else's phone, by its id: not theirs to remove, and left as it is.
  const other = await addMember(project.id, "MEMBER");
  expect(await api(other, "DELETE", "/devices/reinstalled-id")).toEqual({ status: 200, body: { removed: false } });
  expect(await prisma.device.count({ where: { userId: owner.id, deviceId: "reinstalled-id" } })).toBe(1);

  expect(await api(owner, "DELETE", "/devices/reinstalled-id")).toEqual({ status: 200, body: { removed: true } });
  expect(await api(owner, "DELETE", "/devices/reinstalled-id")).toEqual({ status: 200, body: { removed: false } });
  expect(await prisma.device.count({ where: { userId: owner.id } })).toBe(0);
});

test("a phone on two accounts is told once, and only about the one that registered it last", async () => {
  const other = await addMember(project.id, "MEMBER");
  await phone(owner, "shared");
  await phone(other, "shared");
  // The phone is the last account's: the first's row is gone, so nothing of theirs can come back to it.
  expect(await prisma.device.findMany({ where: { token: "ExponentPushToken[shared]" }, select: { userId: true } })).toEqual([{ userId: other.id }]);
  await userWrites();
  expect(pushedTo()).toEqual(["shared"]);

  // Someone signed out offline (their row left), then a teammate from another project signed in on the phone: the
  // first's messages no longer reach it.
  const stranger = await signUp("Sam Stranger");
  const theirs = await createProject(stranger);
  expect(await api(stranger, "POST", "/devices", { deviceId: "stranger-id", token: "ExponentPushToken[shared]", platform: "ios" }, theirs.slug)).toMatchObject({ status: 200 });
  expo.sent = [];
  await userWrites();
  expect(expo.sent).toEqual([]);
  // The stranger signs out: their row goes with their session, and the first account's messages still don't reach the
  // phone, which nobody signed in to them has registered since.
  await auth.api.signOut({ headers: new Headers({ host: appUrl().host, cookie: stranger.cookie }) });
  expect(await prisma.device.count({ where: { token: "ExponentPushToken[shared]" } })).toBe(0);
  await userWrites();
  expect(expo.sent).toEqual([]);
  // Back on the first account, it registers again as the app opens, and it's theirs.
  await phone(owner, "shared");
  await userWrites();
  expect(pushedTo()).toEqual(["shared"]);
});

test("a device is registered with the app's session only", async () => {
  // A teammate's actor without one (the web app's actions): refused, as API keys are (operations matrix).
  await expect(call(registerDevice, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { deviceId: "web", token: "ExponentPushToken[web]", platform: "ios" })).rejects.toMatchObject({
    status: 403,
    code: "app_only",
  });
  expect(await prisma.device.count()).toBe(0);
});

test("phones on different Expo projects' builds are all told: Expo takes one project a request, so each goes on its own", async () => {
  const fork = await addMember(project.id, "MEMBER");
  await phone(owner, "owner");
  await phone(fork, "fork");
  // A fork's own build of the app beside Tuti's: Expo refuses the two in one request.
  expo.projects.set("ExponentPushToken[fork]", "@a-fork/app");
  await userWrites();
  expect(pushedTo()).toEqual(["fork", "owner"]);
  expect(await prisma.pushTicket.count()).toBe(2);
});

test("when one Expo project's send fails, the others' pushes stand: kept, and not sent again", async () => {
  const fork = await addMember(project.id, "MEMBER");
  await phone(owner, "owner");
  await phone(fork, "fork");
  expo.projects.set("ExponentPushToken[fork]", "@a-fork/app");
  expo.failing.add("@a-fork/app");
  // The job doesn't fail (a retry would push Tuti's phones twice): the owner's push and its ticket are kept.
  await userWrites();
  expect(expo.sent.filter((message) => message.ticket).map((message) => message.to)).toEqual(["ExponentPushToken[owner]"]);
  expect(await prisma.pushTicket.findMany({ select: { token: true } })).toEqual([{ token: "ExponentPushToken[owner]" }]);
  // The failed phone is still registered, for the next message.
  expect(await prisma.device.count({ where: { userId: fork.id } })).toBe(1);
});

test("when every Expo project's send fails, the job fails, to be tried again", async () => {
  const fork = await addMember(project.id, "MEMBER");
  await phone(owner, "owner");
  await phone(fork, "fork");
  expo.projects.set("ExponentPushToken[fork]", "@a-fork/app");
  const { number } = await userWrites();
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversation: { projectId: project.id, number } } });
  await prisma.pushTicket.deleteMany();
  expo.failing = new Set(["@tuti/app", "@a-fork/app"]);
  await expect(handlers.conversationPush({ messageId: message.id }, console)).rejects.toThrow("500");
  expect(await prisma.pushTicket.count()).toBe(0);
});

test("two accounts registering one phone at the same moment leave it registered once", async () => {
  const other = await addMember(project.id, "MEMBER");
  const token = "ExponentPushToken[raced]";
  // Another registration of the token, held open: it has its row in and the token's lock, and hasn't committed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const otherRegistration = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(13, hashtext(${token}))`;
      const session = await tx.session.findFirstOrThrow({ where: { userId: other.id } });
      await tx.device.create({ data: { userId: other.id, deviceId: "other-id", token, platform: "ios", sessionId: session.id } });
      locked();
      await held;
    },
    { timeout: 30_000 },
  );
  await lockTaken;
  // The owner registers the same phone meanwhile: it waits for the other's to finish rather than miss its row.
  let done = false;
  const ownerRegistration = api(owner, "POST", "/devices", { deviceId: "owner-id", token, platform: "ios" }).then((response) => ((done = true), response));
  // This database's waiters on the device-token lock (class 13) only: other test files share the Postgres server.
  let waiting = 0;
  // Until one of the two happens, with no clock: its registration waits on the lock, or (without the lock) it finishes.
  while (waiting === 0 && !done) {
    [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = 13
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (waiting === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  expect(waiting).toBe(1);
  expect(done).toBe(false);
  release();
  await otherRegistration;
  expect(await ownerRegistration).toMatchObject({ status: 200 });
  // The owner's came last: it's the only row for the token.
  expect(await prisma.device.findMany({ where: { token }, select: { userId: true } })).toEqual([{ userId: owner.id }]);
});

test("a token on two accounts' rows at once (two registrations racing) is told once, about the newer", async () => {
  const other = await addMember(project.id, "MEMBER");
  await phone(owner, "owner");
  await phone(other, "other");
  // Both rows end up with one token, as two registrations committing together could leave them.
  const now = Date.now();
  await prisma.device.update({ where: { userId_deviceId: { userId: owner.id, deviceId: "owner-id" } }, data: { token: "ExponentPushToken[shared]", lastSeenAt: new Date(now - 60_000) } });
  await prisma.device.update({ where: { userId_deviceId: { userId: other.id, deviceId: "other-id" } }, data: { token: "ExponentPushToken[shared]", lastSeenAt: new Date(now) } });
  await userWrites();
  expect(pushedTo()).toEqual(["shared"]);
  expect(expo.sent).toHaveLength(1);
});

test("a user's message notifies the phones of exactly those its email goes to", async () => {
  const quiet = await addMember(project.id, "MEMBER");
  await prisma.teamMember.update({ where: { id: quiet.memberId }, data: { emailNewConversations: false } });
  const listening = await addMember(project.id, "ADMIN");
  await phone(owner, "owner");
  await phone(quiet, "quiet");
  await phone(listening, "listening");
  const outsider = await signUp("Otto Outsider");
  const theirs = await createProject(outsider);
  expect(await api(outsider, "POST", "/devices", { deviceId: "outsider-id", token: "ExponentPushToken[outsider]", platform: "android" }, theirs.slug)).toMatchObject({ status: 200 });

  mailbox.emails.length = 0;
  const { number } = await userWrites("The export button\n\ndoes nothing");
  // Unassigned: everyone with new conversations' emails on, as the email.
  expect(pushedTo()).toEqual(["listening", "owner"]);
  await mailbox.latestTo(owner.email);
  await mailbox.latestTo(listening.email);
  expect(mailbox.emails.flatMap((email) => email.to).sort()).toEqual([listening.email, owner.email].sort());
  expect(expo.sent[0]).toMatchObject({
    title: "e2e-asker@example.com · " + project.name,
    body: "The export button does nothing",
    sound: "default",
    priority: "high",
    channelId: "default",
    data: { project: project.slug, conversation: number },
  });
  // No access token unless one is set.
  expect(expo.sent[0]!.headers.authorization).toBeUndefined();

  // Assigned to the one who turned new conversations off: only they hear of the user's next message.
  const conversation = await prisma.conversation.update({ where: { projectId_number: { projectId: project.id, number } }, data: { assigneeId: quiet.id } });
  expo.sent = [];
  vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
  const message = await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: conversation.id, author: "USER", channel: "WIDGET", body: "Still broken" } });
  await enqueue("conversationPush", { messageId: message.id });
  expect(pushedTo()).toEqual(["quiet"]);
  expect(expo.sent[0]!.headers.authorization).toBe("Bearer expo-secret");

  // The team's own reply notifies nobody: its author is never told about it.
  expo.sent = [];
  await call(replyToConversation, { actor: { kind: "user", userId: quiet.id }, projectId: project.id }, { number, body: "Looking into it" });
  expect(expo.sent).toEqual([]);

  // Spam tells nobody.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { spam: true } });
  await enqueue("conversationPush", { messageId: message.id });
  expect(expo.sent).toEqual([]);
});

test("a user's message sent again with its requestId is pushed, and emailed, once", async () => {
  await phone(owner, "owner");
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  const { number } = await call(createConversation, key, { user: { id: "user-42", email: "e2e-sam@example.com" }, body: "Help" });
  expo.sent = [];
  mailbox.emails.length = 0;
  // Past the team's ten minutes between emails about a conversation, so another message would be emailed too.
  const pastTenMinutes = () => prisma.conversation.update({ where: { projectId_number: { projectId: project.id, number } }, data: { notifiedAt: null } });
  await pastTenMinutes();

  const write = () => call(replyToConversation, key, { number, body: "Still broken", author: { id: "user-42" }, requestId: "user-retry" });
  const first = await write();
  expect(pushedTo()).toEqual(["owner"]);
  await mailbox.latestTo(owner.email);
  await pastTenMinutes();
  expect((await write()).id).toBe(first.id);
  expect(pushedTo()).toEqual(["owner"]);
  expect(mailbox.emails).toHaveLength(1);
});

test("with \"Show message text\" off, a notification says who wrote, not what", async () => {
  await phone(owner, "owner");
  expect(await api(owner, "GET", "/notifications")).toEqual({ status: 200, body: { showMessageText: true } });

  // Long text on one line, cut.
  await userWrites(`Line one\n\n${"word ".repeat(100)}`);
  expect(expo.sent[0]!.body).toMatch(/^Line one word word .*…$/);
  expect(expo.sent[0]!.body!.length).toBeLessThanOrEqual(200);

  expect(await api(owner, "PATCH", "/notifications", { showMessageText: false })).toEqual({ status: 200, body: { showMessageText: false } });
  expect(await api(owner, "PATCH", "/notifications", {})).toEqual({ status: 200, body: { showMessageText: false } });
  expo.sent = [];
  await userWrites("A private matter");
  expect(expo.sent).toHaveLength(1);
  expect(expo.sent[0]!.title).toContain("e2e-asker@example.com");
  expect(expo.sent[0]!.body).toBeUndefined();
  expect(JSON.stringify(expo.sent[0])).not.toContain("private");
});

test("a phone whose session ended, or whose teammate left, gets nothing", async () => {
  const signedOut = await addMember(project.id, "MEMBER");
  const expired = await addMember(project.id, "MEMBER");
  const left = await addMember(project.id, "MEMBER");
  for (const [user, name] of [[signedOut, "signed-out"], [expired, "expired"], [left, "left"]] as const) {
    await phone(user, name);
  }

  await auth.api.signOut({ headers: new Headers({ host: appUrl().host, cookie: signedOut.cookie }) });
  // Gone with its session.
  expect(await prisma.device.count({ where: { userId: signedOut.id } })).toBe(0);
  await prisma.session.updateMany({ where: { userId: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await prisma.teamMember.delete({ where: { id: left.memberId } });

  await userWrites();
  expect(pushedTo()).toEqual([]);
});

test("a token Expo no longer has loses its device, when sending and from a receipt", async () => {
  const other = await addMember(project.id, "MEMBER");
  await phone(owner, "owner");
  await phone(other, "other");

  // Said at once, in the send's ticket; but a phone that registered again after the send started (its app opened while
  // the request was out) keeps its registration: the answer was about the one before.
  expo.unregistered.add("ExponentPushToken[other]");
  await prisma.device.updateMany({ where: { userId: other.id }, data: { lastSeenAt: new Date(Date.now() + 60_000) } });
  await userWrites();
  expect(await prisma.device.count({ where: { userId: other.id } })).toBe(1);
  await prisma.pushTicket.deleteMany();
  await prisma.device.updateMany({ where: { userId: other.id }, data: { lastSeenAt: new Date(Date.now() - 60_000) } });
  await userWrites();
  expect(await prisma.device.findMany({ select: { token: true } })).toEqual([{ token: "ExponentPushToken[owner]" }]);
  const [ticket] = await prisma.pushTicket.findMany();
  expect(ticket).toMatchObject({ token: "ExponentPushToken[owner]" });

  // Too soon for its receipt: not asked about.
  expo.asked = [];
  expect(await checkPushReceipts({}, console)).toEqual({ read: 0, unregistered: 0 });
  expect(expo.asked).toEqual([]);

  // No receipt yet 15 minutes on: kept, to ask again.
  const later = new Date(Date.now() + RECEIPT_AFTER_MS + 1000);
  expect(await checkPushReceipts({}, console, later)).toEqual({ read: 0, unregistered: 0 });
  expect(expo.asked).toEqual([[ticket!.id]]);
  expect(await prisma.pushTicket.count()).toBe(1);

  // Its receipt says the token is gone, but the phone registered again since: kept.
  expo.receipts[ticket!.id] = deviceNotRegistered("ExponentPushToken[owner]");
  await prisma.device.updateMany({ where: { userId: owner.id }, data: { lastSeenAt: new Date(ticket!.createdAt.getTime() + 1000) } });
  const ticketCopy = await prisma.pushTicket.create({ data: { id: "ticket-again", token: ticket!.token, createdAt: ticket!.createdAt } });
  expo.receipts[ticketCopy.id] = deviceNotRegistered("ExponentPushToken[owner]");
  await checkPushReceipts({}, console, later);
  expect(await prisma.device.count()).toBe(1);

  // Not registered again: the device goes, and the ticket.
  await prisma.device.updateMany({ where: { userId: owner.id }, data: { lastSeenAt: ticket!.createdAt } });
  await prisma.pushTicket.create({ data: { id: ticket!.id, token: ticket!.token, createdAt: ticket!.createdAt } });
  expect(await checkPushReceipts({}, console, later)).toEqual({ read: 1, unregistered: 1 });
  expect(await prisma.device.count()).toBe(0);
  expect(await prisma.pushTicket.count()).toBe(0);
});

test("a push prunes tickets past a day too: with jobs inline the receipts' cron never runs", async () => {
  await phone(owner, "owner");
  await prisma.pushTicket.create({ data: { id: "old", token: "ExponentPushToken[owner]", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
  await userWrites();
  expect(await prisma.pushTicket.findMany({ select: { token: true } })).toEqual([{ token: "ExponentPushToken[owner]" }]);
  expect(await prisma.pushTicket.count({ where: { id: "old" } })).toBe(0);
});

test("a receipt that's fine keeps the device, and a ticket past a day is let go", async () => {
  await phone(owner, "owner");
  await userWrites();
  await userWrites("Again");
  const [first, second] = await prisma.pushTicket.findMany({ orderBy: { id: "asc" } });
  expo.receipts[first!.id] = { status: "ok" };
  expect(await checkPushReceipts({}, console, new Date(Date.now() + RECEIPT_AFTER_MS + 1000))).toEqual({ read: 1, unregistered: 0 });
  expect(await prisma.device.count()).toBe(1);
  expect(await prisma.pushTicket.findMany({ select: { id: true } })).toEqual([{ id: second!.id }]);

  // A day on, Expo has no receipts left to read.
  expo.asked = [];
  await checkPushReceipts({}, console, new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(await prisma.pushTicket.count()).toBe(0);
  expect(expo.asked).toEqual([]);
});

test("a request that fails after another went through doesn't fail the job, and the rest still go", async () => {
  await phone(owner, "owner");
  const session = await prisma.session.findFirstOrThrow({ where: { userId: owner.id } });
  await prisma.device.createMany({
    data: Array.from({ length: 200 }, (_, i) => ({ userId: owner.id, deviceId: `many-${i}`, token: `ExponentPushToken[many-${i}]`, platform: "android", sessionId: session.id })),
  });
  // The message's own push runs as it's written (jobs inline); this test runs that job again, with a request failing.
  const { number } = await userWrites();
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversation: { projectId: project.id, number } } });
  await prisma.pushTicket.deleteMany();
  // Three requests of up to 100; the second fails.
  expo.sends = 0;
  expo.failSends.add(2);
  await expect(handlers.conversationPush({ messageId: message.id }, console)).resolves.toMatchObject({ pushed: 101 });
  expect(await prisma.pushTicket.count()).toBe(101);
  // Only when nothing went through does it fail, for the job to try again.
  await prisma.pushTicket.deleteMany();
  expo.sends = 0;
  expo.failSends = new Set([1, 2, 3]);
  await expect(handlers.conversationPush({ messageId: message.id }, console)).rejects.toThrow("500");
});

test("when Expo turns every push away for now (MessageRateExceeded), the job fails, to be tried again", async () => {
  await phone(owner, "owner");
  const { number } = await userWrites();
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversation: { projectId: project.id, number } } });
  expo.rateExceeded.add("ExponentPushToken[owner]");
  await expect(handlers.conversationPush({ messageId: message.id }, console)).rejects.toThrow("refused every push");
  // Nor does a gone phone beside it make that a push told: the other is still owed one.
  await prisma.device.create({ data: { userId: owner.id, deviceId: "gone-id", token: "ExponentPushToken[gone]", platform: "ios", sessionId: (await prisma.session.findFirstOrThrow({ where: { userId: owner.id } })).id } });
  expo.unregistered.add("ExponentPushToken[gone]");
  await expect(handlers.conversationPush({ messageId: message.id }, console)).rejects.toThrow("refused every push");
  // An error that would come back the same on every try (MessageTooBig) isn't retried.
  expo.rateExceeded.clear();
  expo.errors.set("ExponentPushToken[owner]", "MessageTooBig");
  await expect(handlers.conversationPush({ messageId: message.id }, console)).resolves.toMatchObject({ pushed: 0 });
  expo.errors.clear();
  expo.rateExceeded.add("ExponentPushToken[owner]");
  // One that went through is enough not to: the rest aren't pushed twice by a retry.
  const other = await addMember(project.id, "MEMBER");
  await phone(other, "other");
  await expect(handlers.conversationPush({ messageId: message.id }, console)).resolves.toMatchObject({ pushed: 1 });
});

test("pushes go 100 a request, and receipts are read 1,000 at a time", async () => {
  await phone(owner, "owner");
  const session = await prisma.session.findFirstOrThrow({ where: { userId: owner.id } });
  await prisma.device.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({ userId: owner.id, deviceId: `many-${i}`, token: `ExponentPushToken[many-${i}]`, platform: "android", sessionId: session.id })),
  });
  // The fake refuses more than 100 in one request, as Expo does.
  await userWrites();
  expect(expo.sent).toHaveLength(101);
  expect(await prisma.pushTicket.count()).toBe(101);

  await prisma.pushTicket.createMany({ data: Array.from({ length: 900 }, (_, i) => ({ id: `extra-${i}`, token: "ExponentPushToken[owner]" })) });
  expo.asked = [];
  await checkPushReceipts({}, console, new Date(Date.now() + RECEIPT_AFTER_MS + 1000));
  expect(expo.asked.map((ids) => ids.length)).toEqual([1000, 1]);
});

test("a send isn't failed by saving its tickets, so a retry doesn't push again", async () => {
  await phone(owner, "owner");
  const { number } = await userWrites();
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversation: { projectId: project.id, number } } });
  expo.sent = [];
  await prisma.pushTicket.deleteMany();
  vi.spyOn(prisma.pushTicket, "createMany").mockRejectedValueOnce(new Error("The database went away"));
  // Inline jobs aren't retried: a job that failed here would be, on the worker, and push again.
  expect(await enqueue("conversationPush", { messageId: message.id })).toEqual({ pushed: 1 });
  expect(expo.sent).toHaveLength(1);
  expect(await prisma.pushTicket.count()).toBe(0);
});
