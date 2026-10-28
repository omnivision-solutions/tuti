import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { beforeEach, expect, test, vi } from "vitest";

import { approvalProject } from "@/lib/email-approval";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { approveEmailSending, requestEmailSending } from "./email-approval";
import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";

/** On a server selling plans, a project's replies are emailed to users only once the operator approves it. */

const OPERATOR = "e2e-operator@example.com";

beforeEach(() => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("APP_PORTAL_OWNER", OPERATOR);
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});

test("replies wait until the operator approves the project from the link they're emailed", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const address = supportAddress(await mailSubdomain(project.id), "tuti.email");
  const kim = `e2e-kim-${project.slug}@example.com`;
  await postEmail(rawEmail({ from: kim, to: address, subject: "Refund" }), { recipient: address });
  await call(replyToConversation, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { number: 1, body: "On it" });
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
  const run = () => handlers.sendConversationReplies({}, { info: () => {}, warn: () => {} });
  const toKim = () => mailbox.emails.filter((email) => email.to.includes(kim));

  await run();
  expect(toKim()).toEqual([]);

  actAs(owner);
  expect(await requestEmailSending(project.slug)).toEqual({});
  const request = await mailbox.latestTo(OPERATOR);
  expect(request.subject).toBe(`${project.name} asks to email its users`);
  const link = new URL(request.text.split(/\s+/).find((word) => word.includes("/approve-email?"))!.replace(/[[\]]/g, ""));
  const token = link.searchParams.get("token")!;
  expect(approvalProject(token)).toBe(project.id);
  // Asking again the same day doesn't email the operator again.
  expect(await requestEmailSending(project.slug)).toEqual({ error: expect.stringContaining("asked already") });

  expect(await approveEmailSending("not-a-token")).toEqual({ error: "This link doesn't work any more" });
  expect(await approveEmailSending(token)).toEqual({});
  await run();
  expect(toKim()).toHaveLength(1);
});

test("asks at once email the operator once; a failed send can be asked again at once, and a day on, they may ask again", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const toOperator = () => mailbox.emails.filter((email) => email.to.includes(OPERATOR) && email.subject.startsWith(project.name)).length;

  const results = await Promise.all([requestEmailSending(project.slug), requestEmailSending(project.slug), requestEmailSending(project.slug)]);
  expect(results.filter((result) => !result.error)).toHaveLength(1);
  expect(toOperator()).toBe(1);

  // A day on, without an answer: they may ask again (the settings page offers it again too).
  await prisma.project.update({ where: { id: project.id }, data: { emailRequestedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
  mailbox.refuseNext(OPERATOR);
  expect(await requestEmailSending(project.slug)).toEqual({ error: expect.stringContaining("Couldn't send") });
  expect(toOperator()).toBe(1);
  expect(await requestEmailSending(project.slug)).toEqual({});
  expect(toOperator()).toBe(2);
});

test("a server without plans approves nothing: replies go from the start", async () => {
  vi.stubEnv("PLANS", "");
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  expect(await requestEmailSending(project.slug)).toEqual({ error: "This server doesn't need its projects approved" });
});
