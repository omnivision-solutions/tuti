import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";

import { getConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { type WidgetAuth } from "./widget-person";
import { widgetSendMessage, widgetStartConversation, widgetUploadAttachment } from "./widget-inbox";

/** Files the user attaches in the widget (docs/plan.md, Support inbox, item 9). */

let s3: S3Fake;
beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
});

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  actAs(null);
  return { project, team };
}

/** Uploads as the panel does: asks where, then PUTs it there. */
async function upload(slug: string, auth: WidgetAuth, filename: string, content: Buffer, contentType = "image/png") {
  const started = await widgetUploadAttachment(slug, auth, { filename, contentType, size: content.length });
  if ("error" in started) {
    throw new Error(started.error);
  }
  expect((await fetch(started.uploadUrl, { method: "PUT", body: new Uint8Array(content), headers: { "content-type": started.contentType } })).ok).toBe(true);
  return started.id;
}

test("someone the page signs in attaches files to a new conversation and to a reply, and the team gets them", async () => {
  const { project, team } = await setup();
  const auth = { token: widgetToken(project.id, await upsertProjectUser(project.id, "user-42", { name: "Sam" })) };

  const shot = await upload(project.slug, auth, "error.png", Buffer.from("\x89PNG the error"));
  expect(await widgetStartConversation(project.slug, auth, "Export fails", undefined, [shot])).toEqual({ number: 1 });
  const log = await upload(project.slug, auth, "export.log", Buffer.from("stack trace"), "text/plain");
  expect(await widgetSendMessage(project.slug, auth, 1, "And the log", [log])).toEqual({});

  const messages = (await call(getConversation, team, { number: 1 })).messages;
  expect(messages.map((m) => m.attachments.map((a) => a.filename))).toEqual([["error.png"], ["export.log"]]);
  expect(messages[1]!.attachments[0]!.url).toBeTruthy();
});

test("a signed-out visitor attaches with their visitor token; nobody else can send their uploads, nor send one twice", async () => {
  const { project, team } = await setup();
  const started = await widgetStartConversation(project.slug, {}, "Hello", "e2e-visitor@example.com");
  if ("error" in started) {
    throw new Error(started.error);
  }
  const visitor = { visitor: started.visitor! };

  const mine = await upload(project.slug, visitor, "receipt.pdf", Buffer.from("%PDF"), "application/pdf");
  // Another visitor, and someone signed in, can't send it.
  const other = await widgetStartConversation(project.slug, {}, "Hi", "e2e-other@example.com");
  if ("error" in other) {
    throw new Error(other.error);
  }
  expect(await widgetSendMessage(project.slug, { visitor: other.visitor! }, 2, "Mine now", [mine])).toEqual({
    error: "An attachment isn't there any more: add it again",
  });
  const sam = { token: widgetToken(project.id, await upsertProjectUser(project.id, "user-42", { name: "Sam" })) };
  expect(await widgetStartConversation(project.slug, sam, "Mine now", undefined, [mine])).toEqual({ error: "An attachment isn't there any more: add it again" });

  expect(await widgetSendMessage(project.slug, visitor, 1, "My receipt", [mine])).toEqual({});
  expect(await widgetSendMessage(project.slug, visitor, 1, "Again", [mine])).toEqual({ error: "An attachment isn't there any more: add it again" });
  expect((await call(getConversation, team, { number: 1 })).messages.flatMap((m) => m.attachments.map((a) => a.filename))).toEqual(["receipt.pdf"]);
});
