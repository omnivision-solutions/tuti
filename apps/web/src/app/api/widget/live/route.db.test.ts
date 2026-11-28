import { prisma } from "@tuti/db";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { newVisitor } from "@/server/auth/visitor-session";
import { widgetToken } from "@/server/auth/widget-session";
import { KEEPALIVE_MS, listening, notifyInboxNow } from "@/server/live";
import { createProject, onPortal, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./route";

/**
 * The widget's live stream for Messages (/api/widget/live): who hears comes from the context as /api/trpc reads it (the
 * widget's token, a visitor's token, or the portal's own cookie) and the router decides (live.widget). Each hears only
 * their own conversations.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  // Already listening, so a stream hears only real changes, not the listener's first "anything may have changed".
  await listening();
});

const host = () => `${project.slug}.localhost:3100`;

/** Opens the stream; `next()` is its next event or comment as sent (null once it ended). Closed after the test. */
async function open(headers: Record<string, string> = {}, slug = project.slug) {
  const client = new AbortController();
  onTestFinished(() => client.abort());
  const response = await GET(new Request(`http://${host()}/api/widget/live?project=${slug}`, { headers: { host: host(), ...headers }, signal: client.signal }));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let buffered = "";
  const next = async (): Promise<string | null> => {
    while (!buffered.includes("\n\n")) {
      reader ??= response.body!.getReader();
      const { done, value } = await reader.read();
      if (done) {
        return null;
      }
      buffered += decoder.decode(value, { stream: true });
    }
    const end = buffered.indexOf("\n\n");
    const event = buffered.slice(0, end);
    buffered = buffered.slice(end + 2);
    return event;
  };
  return { status: response.status, next };
}

const ready = "retry: 3000\nevent: ready\ndata: {}";
const changed = (number: number) => `event: change\ndata: {"conversation":${number}}`;
const change = (number: number, who: { userId?: string; visitorHash?: string }, projectId = project.id) =>
  notifyInboxNow({ projectId, conversationId: `c${number}`, number, userId: who.userId ?? null, visitorHash: who.visitorHash ?? null });

test("the widget's person, a visitor and the portal's own reader each hear only their own conversations", async () => {
  const [ada, bo] = [await signUp("Ada"), await signUp("Bo")];
  const visitor = newVisitor(project.id);
  const asAda = await open({ authorization: `Widget ${widgetToken(project.id, ada.id)}` });
  const asVisitor = await open({ authorization: `Visitor ${visitor.token}` });
  await onPortal(bo, project);
  const asBo = await open({ cookie: bo.cookie });
  for (const stream of [asAda, asVisitor, asBo]) {
    expect(stream.status).toBe(200);
    expect(await stream.next()).toBe(ready);
  }

  // Each change reaches only whose conversation it is; another project's reaches nobody.
  const elsewhere = await createProject(owner);
  await change(9, { userId: ada.id }, elsewhere.id);
  await change(1, { userId: ada.id });
  await change(2, { visitorHash: visitor.hash });
  await change(3, { userId: bo.id });
  expect(await asAda.next()).toBe(changed(1));
  expect(await asVisitor.next()).toBe(changed(2));
  expect(await asBo.next()).toBe(changed(3));
});

test("a proxy's Authorization on the portal's request isn't the widget's person: the cookie session still hears", async () => {
  const bo = await signUp("Bo");
  await onPortal(bo, project);
  for (const authorization of ["Basic Ym86cGFzc3dvcmQ=", "Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl"]) {
    const stream = await open({ cookie: bo.cookie, authorization });
    expect(stream.status).toBe(200);
    expect(await stream.next()).toBe(ready);
  }
});

test("refused: nobody, a token that isn't one of ours or is another project's, and Messages off", async () => {
  const ada = await signUp("Ada");
  const elsewhere = await createProject(owner);
  expect((await open()).status).toBe(401);
  expect((await open({ authorization: "Widget made.up.token" })).status).toBe(401);
  expect((await open({ authorization: `Widget ${widgetToken(elsewhere.id, ada.id)}` })).status).toBe(401);
  expect((await open({ authorization: `Visitor ${newVisitor(elsewhere.id).token}` })).status).toBe(401);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: false } });
  expect((await open({ authorization: `Widget ${widgetToken(project.id, ada.id)}` })).status).toBe(401);
});

test("the stream ends at the next keepalive once its person is gone (their project's app deleted them)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const ada = await signUp("Ada");
  const stream = await open({ authorization: `Widget ${widgetToken(project.id, ada.id)}` });
  expect(await stream.next()).toBe(ready);
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBe(": ping");
  await prisma.user.update({ where: { id: ada.id }, data: { deletedAt: new Date() } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBeNull();
});

test("on a private portal, as the panel itself: its readers hear, someone else the site signs in doesn't", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const [reader, stranger] = [await signUp("Rae Reader"), await signUp("Sam Stranger")];
  await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  expect((await open({ authorization: `Widget ${widgetToken(project.id, reader.id)}` })).status).toBe(200);
  expect((await open({ authorization: `Widget ${widgetToken(project.id, stranger.id)}` })).status).toBe(401);
  expect((await open({ authorization: `Visitor ${newVisitor(project.id).token}` })).status).toBe(401);
});

test("the portal reader's stream checks their session at each keepalive without extending it, and ends once it expires", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const bo = await signUp("Bo");
  await onPortal(bo, project);
  const stream = await open({ cookie: bo.cookie });
  expect(await stream.next()).toBe(ready);
  // A day-old session, due for Better Auth's refresh: the keepalive reads it and leaves its expiry as it was.
  const sessionOf = () => prisma.session.findFirstOrThrow({ where: { userId: bo.id }, select: { id: true, expiresAt: true } });
  const dayOld = { expiresAt: new Date(Date.now() + 6 * 86_400_000), updatedAt: new Date(Date.now() - 2 * 86_400_000) };
  await prisma.session.updateMany({ where: { userId: bo.id }, data: dayOld });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBe(": ping");
  expect((await sessionOf()).expiresAt).toEqual(dayOld.expiresAt);
  // Expired: the stream ends.
  await prisma.session.updateMany({ where: { userId: bo.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBeNull();
});

test("the stream ends at the next keepalive once they may no longer hear: Messages off, or their access to a private portal gone", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const ada = await signUp("Ada");
  const asAda = await open({ authorization: `Widget ${widgetToken(project.id, ada.id)}` });
  expect(await asAda.next()).toBe(ready);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: false } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await asAda.next()).toBeNull();

  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, portalAccess: "PRIVATE" } });
  const reader = await signUp("Rae Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  const access = await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
  const asReader = await open({ authorization: `Widget ${widgetToken(project.id, reader.id)}` });
  expect(await asReader.next()).toBe(ready);
  await prisma.portalReader.delete({ where: { id: access.id } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await asReader.next()).toBeNull();
});
