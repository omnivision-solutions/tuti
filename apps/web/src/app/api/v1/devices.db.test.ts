import { prisma } from "@tuti/db";
import { checkPushReceipts, enqueue, RECEIPT_AFTER_MS } from "@tuti/jobs";
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

  expect(await api(owner, "DELETE", "/devices/reinstalled-id")).toEqual({ status: 200, body: { removed: true } });
  expect(await api(owner, "DELETE", "/devices/reinstalled-id")).toEqual({ status: 200, body: { removed: false } });
  expect(await prisma.device.count({ where: { userId: owner.id } })).toBe(0);
});

test("a device is registered with the app's session only", async () => {
  // A teammate's actor without one (the web app's actions): refused, as API keys are (operations matrix).
  await expect(call(registerDevice, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { deviceId: "web", token: "ExponentPushToken[web]", platform: "ios" })).rejects.toMatchObject({
    status: 403,
    code: "app_only",
  });
  expect(await prisma.device.count()).toBe(0);
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

  // Said at once, in the send's ticket.
  expo.unregistered.add("ExponentPushToken[other]");
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

  // Its receipt says the token is gone: the device goes, and the ticket.
  expo.receipts[ticket!.id] = deviceNotRegistered("ExponentPushToken[owner]");
  expect(await checkPushReceipts({}, console, later)).toEqual({ read: 1, unregistered: 1 });
  expect(await prisma.device.count()).toBe(0);
  expect(await prisma.pushTicket.count()).toBe(0);
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
