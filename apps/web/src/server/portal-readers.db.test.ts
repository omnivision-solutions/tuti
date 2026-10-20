import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { hashSecret } from "@/lib/portal-handoff";

import {
  addPortalReaders,
  listPortalReaders,
  MAX_READERS,
  READER_EMAILS_PER_ADDRESS_PER_DAY,
  READER_EMAILS_PER_PROJECT_PER_DAY,
  removePortalReader,
  updatePortal,
} from "./operations/portal";
import { call } from "./operations/run";
import { canReadPortal } from "./portal-access";
import { confirmSignInLink, emailSignInLink } from "./sign-in-link";

/**
 * A private portal's readers by email: anyone with the address reads it once it's verified (an
 * emailed sign-in link verifies it, and makes the account if there's none). New readers of a
 * private portal are emailed a link to it.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  await call(updatePortal, as(), { access: "private" });
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const address = () => `e2e-${randomUUID()}@example.com`;
const sentTo = (email: string) => mailbox.emails.filter((e) => e.to.includes(email));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

test("readers are added by email (lowercase, once each) and emailed a link to the private portal", async () => {
  const [ada, grace] = [address(), address()];
  expect(await call(addPortalReaders, as(), { emails: [ada.toUpperCase(), grace, ada] })).toEqual({ added: [ada, grace], emailed: 2 });
  const email = await mailbox.latestTo(ada);
  expect(email.subject).toBe(`Olive Owner gave you access to ${project.name}`);
  expect(email.replyTo).toContain(owner.email);
  expect(email.text).toContain(`http://${project.slug}.localhost:3100/sign-in`);
  expect(email.text).toContain(`Sign in as ${ada}`);

  // Again: already there, nobody emailed twice.
  expect(await call(addPortalReaders, as(), { emails: [grace] })).toEqual({ added: [], emailed: 0 });
  expect(sentTo(grace)).toHaveLength(1);
  // Added together: the same time, then by address.
  expect((await call(listPortalReaders, as(), {})).readers).toMatchObject(
    [ada, grace].sort().map((email) => ({ email, addedBy: "Olive Owner" })),
  );

  // Not when asked not to, nor while the portal is public (there's nothing to give access to).
  const quiet = address();
  expect(await call(addPortalReaders, as(), { emails: [quiet], notify: false })).toEqual({ added: [quiet], emailed: 0 });
  await call(updatePortal, as(), { access: "public" });
  const early = address();
  expect(await call(addPortalReaders, as(), { emails: [early] })).toEqual({ added: [early], emailed: 0 });
  expect([...sentTo(quiet), ...sentTo(early)]).toEqual([]);
});

test("limits: an address each, up to 20 at once and 2,000 in all", async () => {
  await expect(call(addPortalReaders, as(), { emails: ["not an address"] })).rejects.toMatchObject({ status: 400 });
  await expect(call(addPortalReaders, as(), { emails: [] })).rejects.toMatchObject({ status: 400 });
  await expect(call(addPortalReaders, as(), { emails: Array.from({ length: 21 }, address) })).rejects.toMatchObject({ status: 400 });

  await prisma.portalReader.createMany({ data: Array.from({ length: MAX_READERS - 1 }, () => ({ projectId: project.id, email: address() })) });
  await expect(call(addPortalReaders, as(), { emails: [address(), address()], notify: false })).rejects.toMatchObject({
    status: 400,
    message: `A portal can have up to ${MAX_READERS} readers`,
  });
  // Exactly up to it is fine.
  expect((await call(addPortalReaders, as(), { emails: [address()], notify: false })).added).toHaveLength(1);
});

test("emails to new readers are limited per day: per address across projects (removing and adding again counts), and per portal", async () => {
  const email = address();
  const other = await createProject(owner);
  await prisma.project.update({ where: { id: other.id }, data: { portalAccess: "PRIVATE" } });
  const inOther = { actor: as().actor, projectId: other.id };
  for (let i = 0; i < READER_EMAILS_PER_ADDRESS_PER_DAY; i++) {
    const context = i % 2 === 0 ? as() : inOther;
    expect(await call(addPortalReaders, context, { emails: [email] })).toEqual({ added: [email], emailed: 1 });
    await call(removePortalReader, context, { email });
  }
  // Past it they're still added, without an email.
  expect(await call(addPortalReaders, as(), { emails: [email] })).toEqual({ added: [email], emailed: 0 });
  expect(sentTo(email)).toHaveLength(READER_EMAILS_PER_ADDRESS_PER_DAY);
  // Only addresses are kept for it, as hashes.
  expect(await prisma.portalReaderEmail.count({ where: { emailHash: hashSecret(email) } })).toBe(READER_EMAILS_PER_ADDRESS_PER_DAY);

  // The portal's own limit: one left today.
  await prisma.portalReaderEmail.createMany({
    data: Array.from({ length: READER_EMAILS_PER_PROJECT_PER_DAY - 1 - (await prisma.portalReaderEmail.count({ where: { projectId: project.id } })) }, () => ({
      projectId: project.id,
      emailHash: hashSecret(address()),
    })),
  });
  const [first, second] = [address(), address()];
  expect(await call(addPortalReaders, as(), { emails: [first, second] })).toMatchObject({ added: [first, second], emailed: 1 });
  expect(sentTo(first).length + sentTo(second).length).toBe(1);
  // A day later, it's counted again from zero.
  await prisma.portalReaderEmail.updateMany({ data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
  const later = address();
  expect(await call(addPortalReaders, as(), { emails: [later] })).toEqual({ added: [later], emailed: 1 });
});

test("a reader without an account signs in with an emailed link and reads the portal; removed, they can't", async () => {
  const email = address();
  await call(addPortalReaders, as(), { emails: [email] });
  expect(await emailSignInLink(project.slug, "/", form({ email }))).toEqual({ sentTo: email });
  const link = new URL((await mailbox.latestTo(email)).text.split(/\s+/).find((word) => word.includes("/sign-in/link?"))!);
  request.host = link.host;
  try {
    await confirmSignInLink(form({ token: link.searchParams.get("token")!, next: "/" }));
  } finally {
    request.host = "";
  }
  const reader = await prisma.user.findFirstOrThrow({ where: { email } });
  expect(reader.emailVerified).toBe(true);
  expect(await canReadPortal({ id: project.id }, reader.id)).toBe(true);

  expect(await call(removePortalReader, as(), { email: email.toUpperCase() })).toEqual({ removed: email });
  expect(await canReadPortal({ id: project.id }, reader.id)).toBe(false);
  await expect(call(removePortalReader, as(), { email })).rejects.toMatchObject({ status: 404 });
});

test("an account with a reader's address that isn't verified doesn't get in until it is; other projects' readers never do", async () => {
  const someone = await signUp("Not verified");
  await call(addPortalReaders, as(), { emails: [someone.email], notify: false });
  expect(await canReadPortal({ id: project.id }, someone.id)).toBe(false);
  await prisma.user.update({ where: { id: someone.id }, data: { emailVerified: true } });
  expect(await canReadPortal({ id: project.id }, someone.id)).toBe(true);

  const other = await createProject(owner);
  await prisma.project.update({ where: { id: other.id }, data: { portalAccess: "PRIVATE" } });
  expect(await canReadPortal({ id: other.id }, someone.id)).toBe(false);
});

test("a domain lets in everyone with a verified address there; nobody's emailed for it, and free email providers are refused", async () => {
  expect(await call(addPortalReaders, as(), { emails: ["@Example.com"] })).toEqual({ added: ["@example.com"], emailed: 0 });
  const [colleague, unverified, elsewhere] = [await signUp("Colleague"), await signUp("Not verified"), await signUp("Elsewhere", `e2e-${randomUUID()}@example.org`)];
  await prisma.user.updateMany({ where: { id: { in: [colleague.id, elsewhere.id] } }, data: { emailVerified: true } });
  expect(await canReadPortal({ id: project.id }, colleague.id)).toBe(true);
  expect(await canReadPortal({ id: project.id }, unverified.id)).toBe(false);
  expect(await canReadPortal({ id: project.id }, elsewhere.id)).toBe(false);

  for (const [entry, message] of [
    ["@gmail.com", "Anyone can get an @gmail.com address: add people from it one by one"],
    ["@myyahoo.com", "Anyone can get an @myyahoo.com address"],
    ["@nodot", "Enter an email address, or a domain like @acme.com"],
    ["@-bad.com", "Enter an email address, or a domain like @acme.com"],
  ]) {
    await expect(call(addPortalReaders, as(), { emails: [entry] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
  }

  expect(await call(removePortalReader, as(), { email: "@example.com" })).toEqual({ removed: "@example.com" });
  expect(await canReadPortal({ id: project.id }, colleague.id)).toBe(false);
});
