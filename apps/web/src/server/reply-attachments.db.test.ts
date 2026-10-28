import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { replyInConversation, uploadReplyAttachment } from "./inbox";
import { mailSubdomain, supportAddress } from "./inbound";
import { getConversation, replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { widgetConversation, widgetStartConversation } from "./widget-inbox";

/** The team's attachments in replies (docs/plan.md, Support inbox, item 9): uploaded, sent with the reply, emailed as attachments. */

const DOMAIN = "tuti.email";
const MB = 1024 * 1024;
let s3: S3Fake;
beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
});

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const kim = `e2e-kim-${project.slug}@example.com`;
  await postEmail(rawEmail({ from: `Kim Lee <${kim}>`, to: address, subject: "Invoice missing" }), { recipient: address });
  actAs(owner);
  return { owner, project, kim };
}

/** Uploads a file as the browser does: asks for the URL, then PUTs it there. */
async function upload(slug: string, filename: string, content: Buffer, contentType = "application/pdf", { put = true } = {}) {
  const started = await uploadReplyAttachment(slug, { filename, contentType, size: content.length });
  if ("error" in started) {
    throw new Error(started.error);
  }
  if (put) {
    const response = await fetch(started.uploadUrl, { method: "PUT", body: new Uint8Array(content), headers: { "content-type": started.contentType } });
    expect(response.ok).toBe(true);
  }
  return started.id;
}

test("a teammate's files go with their reply: listed with links, in the widget, and emailed as attachments", async () => {
  const { owner, project, kim } = await setup();
  const pdf = Buffer.from("%PDF-1.4 the October invoice");
  const id = await upload(project.slug, "Invoice Oct.pdf", pdf);
  expect(await replyInConversation(project.slug, 1, "Here it is.", false, [id])).toEqual({});

  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const reply = (await call(getConversation, team, { number: 1 })).messages[1]!;
  expect(reply).toMatchObject({ body: "Here it is.", attachments: [{ id, filename: "Invoice Oct.pdf", contentType: "application/pdf", size: pdf.length }] });
  expect(new URL(reply.attachments[0]!.url!).searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Invoice%20Oct.pdf");

  // Emailed a minute on, with the file attached.
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
  await handlers.sendConversationReplies({}, { info: () => {}, warn: () => {} });
  const email = mailbox.emails.filter((e) => e.to.includes(kim)).at(-1)!;
  expect(email.attachments).toEqual([{ filename: "Invoice Oct.pdf", contentType: "application/pdf", content: pdf }]);
});

test("someone in the widget sees the team's files with the reply", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const auth = { token: widgetToken(project.id, await upsertProjectUser(project.id, "user-42", { name: "Sam" })) };
  actAs(null);
  await widgetStartConversation(project.slug, auth, "Can I see the error?");
  actAs(owner);
  const id = await upload(project.slug, "error.png", Buffer.from("\x89PNG the error"), "image/png");
  await replyInConversation(project.slug, 1, "This one?", false, [id]);
  actAs(null);
  const opened = await widgetConversation(project.slug, auth, 1);
  expect(opened).toMatchObject({ messages: [{ attachments: [] }, { attachments: [{ filename: "error.png", image: true }] }] });
});

test("only finished uploads of their own, within the limits, can be sent, each once", async () => {
  const { project, owner } = await setup();
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };

  // Never PUT: nothing to send yet.
  const unfinished = await upload(project.slug, "a.pdf", Buffer.from("x"), "application/pdf", { put: false });
  expect(await replyInConversation(project.slug, 1, "Here", false, [unfinished])).toEqual({ error: "An attachment hasn't finished uploading" });

  // Another teammate's upload.
  const member = await addMember(project.id, "MEMBER");
  actAs(member);
  const theirs = await upload(project.slug, "b.pdf", Buffer.from("y"));
  actAs(owner);
  expect(await replyInConversation(project.slug, 1, "Here", false, [theirs])).toEqual({ error: "An attachment isn't there any more: add it again" });

  // Too large: one over 10 MB isn't even started, and two that are over 25 MB together aren't sent.
  expect(await uploadReplyAttachment(project.slug, { filename: "big.zip", contentType: "application/zip", size: 10 * MB + 1 })).toEqual({
    error: "Attachments can be up to 10 MB each",
  });
  const big = await Promise.all([1, 2, 3].map((n) => upload(project.slug, `${n}.bin`, Buffer.alloc(9 * MB), "application/octet-stream")));
  expect(await replyInConversation(project.slug, 1, "Here", false, big)).toEqual({ error: "A message's attachments can be up to 25 MB together" });

  // Sent once: a second reply can't take it again.
  const once = await upload(project.slug, "c.pdf", Buffer.from("z"));
  expect(await replyInConversation(project.slug, 1, "First", false, [once])).toEqual({});
  expect(await replyInConversation(project.slug, 1, "Again", false, [once])).toEqual({ error: "An attachment isn't there any more: add it again" });

  // An API key sends none.
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  await expect(call(replyToConversation, key, { number: 1, body: "Hi", attachments: [once] })).rejects.toMatchObject({ status: 400 });
  expect((await call(getConversation, team, { number: 1 })).messages.filter((m) => m.attachments.length > 0)).toHaveLength(1);
});

test("uploads never sent are removed after a day, files and all; sent ones stay", async () => {
  const { project } = await setup();
  const unsent = await upload(project.slug, "draft.pdf", Buffer.from("draft"));
  const sent = await upload(project.slug, "sent.pdf", Buffer.from("sent"));
  await replyInConversation(project.slug, 1, "Here", false, [sent]);
  const keys = Object.fromEntries((await prisma.conversationAttachment.findMany({ where: { projectId: project.id } })).map((a) => [a.id, a.key]));
  await prisma.conversationAttachment.updateMany({ where: { projectId: project.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) } });

  await handlers.cleanupMedia({}, { info: () => {}, warn: () => {} });
  expect(await prisma.conversationAttachment.findMany({ where: { projectId: project.id }, select: { id: true } })).toEqual([{ id: sent }]);
  expect(s3.objects.has(keys[unsent]!)).toBe(false);
  expect(s3.objects.has(keys[sent]!)).toBe(true);
});
