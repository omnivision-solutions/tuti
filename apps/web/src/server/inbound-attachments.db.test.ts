import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail } from "@/test/inbound";

import { attachmentLinks } from "./attachments";
import { mailSubdomain, supportAddress } from "./inbound";
import { getConversation } from "./operations/conversations";
import { call } from "./operations/run";

/** Attachments of received email (docs/plan.md, Support inbox, item 9): kept in the media storage, linked to the message. */

const DOMAIN = "tuti.email";
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

const PDF = Buffer.from("%PDF-1.4 the invoice");
const PNG = Buffer.from("\x89PNG screenshot");
const LOGO = Buffer.from("\x89PNG logo");

/** An HTML email with its signature's logo inline (cid:), a PDF and a screenshot attached. */
function withAttachments(from: string, to: string) {
  const part = (headers: string[], body: Buffer) => [...headers, "Content-Transfer-Encoding: base64", "", body.toString("base64")].join("\r\n");
  return [
    `From: ${from}`,
    `To: ${to}`,
    "Subject: Invoice missing",
    `Message-ID: <${crypto.randomUUID()}@mail.example.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    'Content-Type: multipart/related; boundary="related"',
    "",
    "--related",
    'Content-Type: multipart/alternative; boundary="alternative"',
    "",
    "--alternative",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The October one is missing, see attached.",
    "--alternative",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>The October one is missing, see attached.</p><img src="cid:logo@example.com">',
    "--alternative--",
    "--related",
    part(["Content-Type: image/png", "Content-ID: <logo@example.com>", 'Content-Disposition: inline; filename="logo.png"'], LOGO),
    "--related--",
    "--mixed",
    part(['Content-Type: application/pdf; name="Invoice Oct.pdf"', 'Content-Disposition: attachment; filename="Invoice Oct.pdf"'], PDF),
    "--mixed",
    part(['Content-Type: image/png; name="../screenshot.png"', 'Content-Disposition: attachment; filename="../screenshot.png"'], PNG),
    "--mixed--",
    "",
  ].join("\r\n");
}

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  return { project, owner, address };
}

test("an email's attachments are kept whole in the media storage and linked to its message; its inline logo isn't", async () => {
  const { project, owner, address } = await setup();
  expect(await postEmail(withAttachments("Kim <e2e-kim@example.com>", address), { recipient: address })).toMatchObject({ status: 200 });

  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id }, include: { attachments: { orderBy: { createdAt: "asc" } } } });
  expect(message.body).toContain("The October one is missing");
  expect(message.attachmentsDropped).toBe(0);
  expect(message.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size }))).toEqual([
    { filename: "Invoice Oct.pdf", contentType: "application/pdf", size: PDF.length },
    // A name is never a path.
    { filename: "screenshot.png", contentType: "image/png", size: PNG.length },
  ]);
  for (const [attachment, bytes] of [
    [message.attachments[0]!, PDF],
    [message.attachments[1]!, PNG],
  ] as const) {
    expect(attachment.key).toMatch(new RegExp(`^attachments/${project.id}/`));
    expect(s3.objects.get(attachment.key)?.body.equals(bytes)).toBe(true);
  }
  expect([...s3.objects.values()].some((object) => object.body.equals(LOGO))).toBe(false);

  // The team's page shows the image and offers the PDF as a download, under its name.
  const [pdf, png] = await attachmentLinks(message.attachments);
  expect(pdf).toMatchObject({ image: false });
  expect(new URL(pdf!.url!).searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Invoice%20Oct.pdf");
  expect(png).toMatchObject({ image: true });
  expect(new URL(png!.url!).searchParams.get("response-content-disposition")).toBeNull();

  // The API says what came with it.
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  expect((await call(getConversation, team, { number: 1 })).messages[0]).toMatchObject({
    attachments: [
      { filename: "Invoice Oct.pdf", contentType: "application/pdf", size: PDF.length },
      { filename: "screenshot.png", contentType: "image/png", size: PNG.length },
    ],
    attachmentsDropped: 0,
  });
});

test("without media storage the attachments are dropped, and the message says how many", async () => {
  vi.stubEnv("MEDIA_S3_ENDPOINT", "");
  const { project, address } = await setup();
  const before = s3.objects.size;
  await postEmail(withAttachments("Kim <e2e-kim@example.com>", address), { recipient: address });
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id }, include: { attachments: true } });
  expect(message.attachments).toEqual([]);
  expect(message.attachmentsDropped).toBe(2);
  expect(s3.objects.size).toBe(before);
});

test("an email that's already been read keeps no second copy of its attachments", async () => {
  const { project, address } = await setup();
  const raw = withAttachments("Kim <e2e-kim@example.com>", address);
  await postEmail(raw, { recipient: address });
  const kept = [...s3.objects.keys()].filter((key) => key.startsWith(`attachments/${project.id}/`));
  expect(kept).toHaveLength(2);
  // Delivered again: found, not read again.
  await postEmail(raw, { recipient: address });
  expect([...s3.objects.keys()].filter((key) => key.startsWith(`attachments/${project.id}/`))).toEqual(kept);
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(2);
});
