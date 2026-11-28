import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { auth } from "@/server/auth/auth";
import { appUrl } from "@/lib/hosts";
import { createApiKey } from "@/server/api-keys";
import { KEEPALIVE_MS, listening } from "@/server/live";
import { createConversation, replyToConversation, updateConversation } from "@/server/operations/conversations";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request as browser } from "@/test/next-headers";

import { GET } from "./route";

/**
 * The team's live stream (/api/live): the web app's pages with their cookie, the mobile app with its session as
 * /api/v1 takes it (Authorization: Bearer, Tuti-Project), never a cookie on that path.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(null);
  browser.written = [];
  // Already listening, so a stream hears only real changes, not the listener's first "anything may have changed".
  await listening();
});

/** The session's token as its cookie has it: what signing in hands the app. */
const tokenOf = (user: TestUser) => /session_token=([^;]+)/.exec(user.cookie)![1]!;

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** Opens the stream; `next()` is its next event or comment as sent (null once it ended). Closed after the test. */
async function open({ token, slug = project.slug, query = "", cookie }: { token?: string; slug?: string | null; query?: string; cookie?: string }) {
  const client = new AbortController();
  onTestFinished(() => client.abort());
  const response = await GET(
    new Request(`${appUrl().origin}/api/live${query}`, {
      headers: { host: appUrl().host, ...(token && { authorization: token }), ...(slug && { "tuti-project": slug }), ...(cookie && { cookie }) },
      signal: client.signal,
    }),
  );
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
  return { status: response.status, response, next };
}

const ready = "retry: 3000\nevent: ready\ndata: {}";
const changed = (number: number) => `event: change\ndata: {"conversation":${number}}`;

test("the app's session opens its project's stream and hears which conversation changed, with no cookie back", async () => {
  const member = await addMember(project.id, "MEMBER");
  const stream = await open({ token: `Bearer ${tokenOf(member)}` });
  expect(stream.status).toBe(200);
  expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
  expect(stream.response.headers.get("set-cookie")).toBeNull();
  expect(browser.written).toEqual([]);
  expect(await stream.next()).toBe(ready);

  // Started, answered, closed: each names its conversation.
  const { number } = await call(createConversation, asOwner(), { email: "e2e-asker@example.com", body: "The export button does nothing" });
  expect(await stream.next()).toBe(changed(number));
  await call(replyToConversation, asOwner(), { number, body: "On it" });
  expect(await stream.next()).toBe(changed(number));
  await call(updateConversation, asOwner(), { number, status: "closed" });
  expect(await stream.next()).toBe(changed(number));
  // Not another project's.
  const other = await createProject(owner);
  const { number: elsewhere } = await call(createConversation, { actor: { kind: "user", userId: owner.id }, projectId: other.id }, { email: "e2e-elsewhere@example.com", body: "Elsewhere" });
  const second = await call(createConversation, asOwner(), { email: "e2e-second@example.com", body: "Me too" });
  expect(second.number).not.toBe(elsewhere);
  expect(await stream.next()).toBe(changed(second.number));
});

test("the web app's cookie stream names the conversation too, and still answers 404 to anyone else", async () => {
  actAs(owner);
  const stream = await open({ query: `?project=${project.slug}`, slug: null });
  expect(stream.status).toBe(200);
  expect(await stream.next()).toBe(ready);
  const { number } = await call(createConversation, asOwner(), { email: "e2e-asker@example.com", body: "Hello" });
  expect(await stream.next()).toBe(changed(number));

  actAs(await signUp("Otto Outsider"));
  expect((await open({ query: `?project=${project.slug}`, slug: null })).status).toBe(404);
  actAs(null);
  expect((await open({ query: `?project=${project.slug}`, slug: null })).status).toBe(404);
});

test("the web app behind a self-hoster's sign-in proxy keeps its cookie stream: the proxy's Authorization isn't the app's", async () => {
  actAs(owner);
  for (const token of ["Basic b3duZXI6cGFzc3dvcmQ=", "Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl"]) {
    const stream = await open({ token, query: `?project=${project.slug}`, slug: null });
    expect(stream.status).toBe(200);
    expect(await stream.next()).toBe(ready);
  }
});

test("refused as /api/v1 refuses: another team's project, no project, no valid session", async () => {
  const outsider = await signUp("Otto Outsider");
  const refusal = async (sent: Parameters<typeof open>[0]) => {
    const { status, response } = await open(sent);
    return { status, body: await response.json() };
  };
  const forbidden = { status: 403, body: { error: { code: "forbidden", message: "You're not on the team of a project with that slug" } } };
  expect(await refusal({ token: `Bearer ${tokenOf(outsider)}` })).toEqual(forbidden);
  expect(await refusal({ token: `Bearer ${tokenOf(outsider)}`, slug: "no-such-project" })).toEqual(forbidden);
  expect(await refusal({ token: `Bearer ${tokenOf(owner)}`, slug: null })).toMatchObject({ status: 400, body: { error: { code: "project_required" } } });
  expect(await refusal({ token: "Bearer nonsense" })).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
  // A project API key isn't a teammate's session.
  actAs(owner);
  const key = (await createApiKey(project.slug, "Tests", "READ")).key!;
  actAs(null);
  expect(await refusal({ token: `Bearer ${key}` })).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
});

test("a cookie is never a session on the app's path: a page can't use its visitor's", async () => {
  // The owner's cookie, on the request and as next/headers reads it: with a token that isn't a session, with the project
  // header and no token, with neither the header nor the web's query.
  actAs(owner);
  for (const sent of [{ token: "Bearer nonsense" }, {}, { slug: null, query: "" }]) {
    const stream = await open({ cookie: owner.cookie, query: `?project=${project.slug}`, ...sent });
    expect(stream.status).toBe(401);
    expect(stream.response.headers.get("set-cookie")).toBeNull();
  }
  // Beside an outsider's token, the token alone says who.
  const outsider = await signUp("Otto Outsider");
  expect((await open({ token: `Bearer ${tokenOf(outsider)}`, cookie: owner.cookie, query: `?project=${project.slug}` })).status).toBe(403);
});

test("the app's stream ends once its session ends or its teammate leaves the team, and doesn't open again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const member = await addMember(project.id, "MEMBER");
  const token = `Bearer ${tokenOf(member)}`;

  const removed = await open({ token });
  expect(await removed.next()).toBe(ready);
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await removed.next()).toBe(": ping");
  await prisma.teamMember.delete({ where: { id: member.memberId } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await removed.next()).toBeNull();
  expect((await open({ token })).status).toBe(403);

  const signedOut = await open({ token: `Bearer ${tokenOf(owner)}` });
  expect(await signedOut.next()).toBe(ready);
  await auth.api.signOut({ headers: new Headers({ host: appUrl().host, cookie: owner.cookie }) });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await signedOut.next()).toBeNull();
  expect((await open({ token: `Bearer ${tokenOf(owner)}` })).status).toBe(401);
});

test("the web app's cookie stream: another project's refused, and it ends once its teammate leaves the team", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const member = await addMember(project.id, "MEMBER");
  const elsewhere = await createProject(owner);
  actAs(member);
  expect((await open({ query: `?project=${elsewhere.slug}`, slug: null })).status).toBe(404);

  const stream = await open({ query: `?project=${project.slug}`, slug: null });
  expect(await stream.next()).toBe(ready);
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBe(": ping");
  await prisma.teamMember.delete({ where: { id: member.memberId } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBeNull();
  expect((await open({ query: `?project=${project.slug}`, slug: null })).status).toBe(404);
});

test("a new slug doesn't end an open stream: its keepalive checks the project it opened on", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  const member = await addMember(project.id, "MEMBER");
  const app = await open({ token: `Bearer ${tokenOf(member)}` });
  actAs(owner);
  const web = await open({ query: `?project=${project.slug}`, slug: null });
  expect(await app.next()).toBe(ready);
  expect(await web.next()).toBe(ready);
  await prisma.project.update({ where: { id: project.id }, data: { slug: `${project.slug}-renamed` } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await app.next()).toBe(": ping");
  expect(await web.next()).toBe(": ping");
});

test("a keepalive's check that fails (the database unreachable) keeps the stream open; a refusal ends it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => void vi.useRealTimers());
  onTestFinished(() => void vi.restoreAllMocks());
  vi.spyOn(log, "error").mockImplementation(() => {});
  const member = await addMember(project.id, "MEMBER");
  const stream = await open({ token: `Bearer ${tokenOf(member)}` });
  expect(await stream.next()).toBe(ready);

  // Reading their membership fails inside the router: not a refusal, so the stream stays.
  vi.spyOn(prisma.teamMember, "findUnique").mockRejectedValueOnce(new Error("connection reset"));
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBe(": ping");

  // The router refuses them (off the team): it ends.
  await prisma.teamMember.delete({ where: { id: member.memberId } });
  await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(await stream.next()).toBeNull();
});
