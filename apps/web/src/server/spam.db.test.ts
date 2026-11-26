import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { NEW_BY_EMAIL_PER_HOUR } from "@/lib/spam-reasons";
import { widgetToken } from "@/lib/widget-session";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { createConversation, getConversation, replyToConversation, updateConversation } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { call } from "./operations/run";
import { deleteUser } from "./operations/users";
import { upsertProjectUser } from "./project-users";
import { arrivalOf, blockableDomain, spamChoices, spamVerdict } from "./spam";
import { widgetStartConversation } from "./widget-inbox";

/**
 * The spam filter's first four checks and what marking teaches it (docs/plan.md, Inbox automation, W1): emails as the
 * receiver posts them, the widget, and the team's Mark as spam and Not spam.
 */

const DOMAIN = "tuti.email";
const NONE = "spf=none dkim=none dmarc=none";
const FAIL = "spf=fail dkim=fail dmarc=fail";

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});
afterEach(() => vi.unstubAllEnvs());

/** `hook`: with a webhook for new conversations, for the tests that count who was told (`told`). */
async function setup({ hook = false } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const member = await addMember(project.id, "MEMBER");
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const as = (user: { id: string }) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
  if (hook) {
    await prisma.webhook.create({
      data: { projectId: project.id, url: "https://hooks.example.com/tuti", secret: "secret", events: ["conversation.created"], createdById: owner.id },
    });
  }
  actAs(null);
  const projectId = project.id;
  return {
    project,
    projectId,
    owner,
    member,
    admin: as(owner),
    asMember: as(member),
    /** An email from `from` to the project's address, as the receiver authenticated it (DMARC passed unless said). */
    mail: async (from: string, auth?: string) => {
      expect(await postEmail(rawEmail({ from, to }), { recipient: to, ...(auth && { auth }) })).toEqual({ status: 200, body: { outcome: "added" } });
    },
    /** Where each conversation is, by number: "inbox", or in Spam for the filter's reason ("marked": a teammate's, with none). */
    filed: async () =>
      (await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { spam: true, spamReason: true } })).map((c) =>
        c.spam ? (c.spamReason ?? "marked") : "inbox",
      ),
    /** What's kept about senders: each address or domain, blocked or allowed, on a list or as a conversation's mark, and whose. */
    senders: async () =>
      (await prisma.spamSender.findMany({ where: { projectId }, orderBy: [{ decidedAt: "asc" }, { id: "asc" }] })).map(
        (row) => `${row.sender} ${row.blocked ? "blocked" : "allowed"} by ${row.byAdmin ? "an admin" : "a member"}${row.conversationId ? "'s mark" : ", listed"}`,
      ),
    /** An entry on the team's blocked or allowed list (Settings' lists, which fill it later). */
    list: (sender: string, blocked: boolean) => prisma.spamSender.create({ data: { projectId, sender, blocked, byAdmin: true } }),
    /** How many new conversations the project's webhooks were told of. */
    told: () => prisma.webhookDelivery.count({ where: { webhook: { projectId }, event: "conversation.created" } }),
  };
}

/** The team's emails about new conversations. */
const emailed = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && /^New conversation/.test(email.subject)).length;

test("the team's decisions come first, the most exact winning: a listed address, then the sender's newest mark, then a listed domain", async () => {
  const { mail, filed, list, admin, asMember, senders } = await setup();
  await list("spam.example", true);
  await mail("e2e-kim@spam.example"); // #1
  expect(await filed()).toEqual(["blocked_domain"]);
  // An admin's Not spam is an exception to the domain's block: a mark on the address beats a domain on a list.
  await call(updateConversation, admin, { number: 1, spam: false });
  await mail("e2e-kim@spam.example"); // #2
  expect((await filed())[1]).toBe("inbox");
  // The newest mark wins, whoever made it.
  await call(updateConversation, asMember, { number: 2, spam: true });
  await mail("e2e-kim@spam.example"); // #3
  expect((await filed())[2]).toBe("marked_sender");
  await call(updateConversation, admin, { number: 3, spam: false });
  await mail("e2e-kim@spam.example"); // #4
  expect((await filed())[3]).toBe("inbox");
  expect(await senders()).toEqual([
    "spam.example blocked by an admin, listed",
    "e2e-kim@spam.example allowed by an admin's mark",
    "e2e-kim@spam.example blocked by a member's mark",
    "e2e-kim@spam.example allowed by an admin's mark",
  ]);
  // The address on a list beats every mark.
  await list("e2e-kim@spam.example", true);
  await mail("e2e-kim@spam.example"); // #5
  expect((await filed())[4]).toBe("blocked_address");
  // The API says why.
  expect(await call(getConversation, admin, { number: 5 })).toMatchObject({ spam: true, spamReason: "blocked_address" });
  expect(await call(getConversation, admin, { number: 4 })).toMatchObject({ spam: false, spamReason: null });
});

test("the checks answer in order: a decision before trust, trust before the rest, and DMARC's failure whatever the lists say", async () => {
  const { projectId, owner, list } = await setup();
  const sam = await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  const byEmail = (sender: string, dmarc: string, userId: string | null = null) =>
    spamVerdict(prisma, { projectId, address: dmarc === "fail" ? null : sender, userId, proven: dmarc === "pass", email: { sender, dmarc } });

  // Nobody the project knows: no check answers.
  expect(await byEmail("e2e-stranger@example.com", "pass")).toEqual({ spam: false, reason: null, check: null });
  expect(await byEmail("e2e-stranger@example.com", "fail")).toEqual({ spam: true, reason: "dmarc_failed", check: "dmarc" });
  // The project's own user, where DMARC passed or they're signed in; a teammate.
  expect(await byEmail("e2e-sam@example.com", "pass", sam)).toMatchObject({ spam: false, check: "trusted" });
  expect(await spamVerdict(prisma, await arrivalOf(prisma, projectId, sam))).toMatchObject({ spam: false, check: "trusted" });
  expect(await byEmail("e2e-sam@example.com", "none")).toMatchObject({ spam: false, check: null });
  expect(await byEmail(owner.email, "pass")).toMatchObject({ spam: false, check: "trusted" });
  // Blocking a known user works: the team's decision is asked first.
  await list("e2e-sam@example.com", true);
  expect(await byEmail("e2e-sam@example.com", "pass", sam)).toEqual({ spam: true, reason: "blocked_address", check: "decisions" });
  expect(await spamVerdict(prisma, await arrivalOf(prisma, projectId, sam))).toEqual({ spam: true, reason: "blocked_address", check: "decisions" });
  // Allowed: decided there too.
  await list("e2e-friend@example.com", false);
  expect(await byEmail("e2e-friend@example.com", "none")).toEqual({ spam: false, reason: null, check: "decisions" });
});

test("a known user the team marked as spam is filed in the widget and by email, and nobody is told", async () => {
  const { project, projectId, mail, filed, admin, senders, told, owner } = await setup({ hook: true });
  const sam = await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  const auth = { token: widgetToken(projectId, sam) };
  expect(await widgetStartConversation(project.slug, auth, "Hello")).toEqual({ number: 1 });
  expect([await filed(), await told(), emailed(owner.email)]).toEqual([["inbox"], 1, 1]);

  await call(updateConversation, admin, { number: 1, spam: true });
  expect(await senders()).toEqual(["e2e-sam@example.com blocked by an admin's mark"]);
  // The widget takes it as any other (it never says so): theirs to see, in Spam for the team.
  expect(await widgetStartConversation(project.slug, auth, "Hello again")).toEqual({ number: 2 });
  await mail("e2e-sam@example.com"); // #3
  expect(await filed()).toEqual(["marked", "marked_sender", "marked_sender"]);
  expect([await told(), emailed(owner.email)]).toEqual([1, 1]);
});

test("a conversation the team creates over the API skips the filter", async () => {
  const { admin, list, filed } = await setup();
  await list("e2e-kim@example.com", true);
  await call(createConversation, admin, { email: "e2e-kim@example.com", body: "They phoned: the export fails." });
  expect(await filed()).toEqual(["inbox"]);
});

test("Also block offers the organisational domain to owners and admins, never a free-mail one, and blocks its subdomains with it", async () => {
  const { projectId, mail, filed, admin, asMember, senders } = await setup();
  expect(blockableDomain("e2e-kim@gmail.com")).toBeNull();
  expect(blockableDomain("e2e-kim@mail.yahoo.co.uk")).toBeNull();
  expect(blockableDomain("e2e-kim@m2.spam.example")).toBe("spam.example");
  expect(blockableDomain("e2e-kim@mail.spam.co.uk")).toBe("spam.co.uk");
  // A host's customers each have a suffix of their own: one is blocked, never the host.
  expect(blockableDomain("e2e-kim@mail.spammer.github.io")).toBe("spammer.github.io");
  expect(blockableDomain("e2e-kim@github.io")).toBeNull();

  await mail("e2e-kim@gmail.com"); // #1
  await mail("e2e-kim@m2.spam.example"); // #2
  const choices = async (number: number, isAdmin: boolean) =>
    spamChoices(prisma, await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } }), isAdmin);
  expect(await choices(1, true)).toEqual({ blockDomain: null, unblocks: null });
  expect(await choices(2, true)).toEqual({ blockDomain: "spam.example", unblocks: null });
  // The lists are the owners' and admins': a member is never offered it, nor can ask for it.
  expect(await choices(2, false)).toEqual({ blockDomain: null, unblocks: null });
  await expect(call(updateConversation, asMember, { number: 2, spam: true, blockDomain: true })).rejects.toMatchObject({ status: 403 });
  await expect(call(updateConversation, admin, { number: 1, spam: true, blockDomain: true })).rejects.toThrow(
    new OperationError(409, "no_domain", "Anyone can get an address at this domain, so it isn't blocked: marking as spam blocks this address"),
  );
  await expect(call(updateConversation, admin, { number: 2, blockDomain: true, status: "closed" })).rejects.toMatchObject({ status: 400 });
  // Refused whole: nothing was marked or kept.
  expect([await filed(), await senders()]).toEqual([["inbox", "inbox"], []]);

  await call(updateConversation, admin, { number: 2, spam: true, blockDomain: true });
  expect(await senders()).toEqual(["e2e-kim@m2.spam.example blocked by an admin's mark", "spam.example blocked by an admin, listed"]);
  // Blocked now: not offered again.
  expect(await choices(2, true)).toEqual({ blockDomain: null, unblocks: null });
  await mail("e2e-lee@m2.spam.example"); // #3
  await mail("e2e-lee@spam.example"); // #4
  await mail("e2e-lee@notspam.example"); // #5
  expect((await filed()).slice(2)).toEqual(["blocked_domain", "blocked_domain", "inbox"]);
});

test("a domain's entry is for its subdomains, never for the domain above it", async () => {
  const { mail, filed, list } = await setup();
  await list("m1.spam.example", true);
  await mail("e2e-kim@spam.example");
  await mail("e2e-kim@m1.spam.example");
  await mail("e2e-kim@deep.m1.spam.example");
  await mail("e2e-kim@xm1.spam.example");
  expect(await filed()).toEqual(["inbox", "blocked_domain", "blocked_domain", "inbox"]);
});

test("mail that failed DMARC is filed whatever its address is allowed or trusted for, and nothing is kept about its sender, nor about an address a visitor typed", async () => {
  const { project, projectId, mail, filed, list, admin, senders } = await setup();
  await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  await list("e2e-kim@example.com", false);
  await mail("e2e-kim@example.com", FAIL); // #1: forged as an allowed address
  await mail("e2e-sam@example.com", FAIL); // #2: forged as the project's own user
  expect(await filed()).toEqual(["dmarc_failed", "dmarc_failed"]);

  // Unmarking a forgery doesn't allow the next, and says so; marking it again doesn't block the real sender.
  expect(await call(updateConversation, admin, { number: 2, spam: false })).toMatchObject({
    spam: false,
    notice: "Nothing is remembered about its sender: mail that fails DMARC still goes to Spam.",
  });
  await call(updateConversation, admin, { number: 2, spam: true });
  await expect(call(updateConversation, admin, { number: 2, spam: true, blockDomain: true })).rejects.toThrow(
    new OperationError(409, "no_domain", "This conversation's sender isn't proven, so there's no domain to block"),
  );
  expect(await senders()).toEqual(["e2e-kim@example.com allowed by an admin, listed"]);
  await mail("e2e-sam@example.com", FAIL); // #3
  await mail("e2e-sam@example.com"); // #4: the real one
  expect((await filed()).slice(2)).toEqual(["dmarc_failed", "inbox"]);

  // A signed-out visitor types an address: marking theirs keeps nothing, and the address's own mail still arrives.
  expect(await widgetStartConversation(project.slug, {}, "Buy followers", "e2e-typed@corp.example")).toMatchObject({ number: 5 });
  await call(updateConversation, admin, { number: 5, spam: true });
  await expect(call(updateConversation, admin, { number: 5, spam: true, blockDomain: true })).rejects.toMatchObject({ status: 409 });
  expect(await senders()).toEqual(["e2e-kim@example.com allowed by an admin, listed"]);
  await mail("e2e-typed@corp.example"); // #6
  // Nor do the lists go by a typed address: the visitor proved nothing, either way.
  await list("e2e-typed@corp.example", true);
  expect(await widgetStartConversation(project.slug, {}, "Buy more followers", "e2e-typed@corp.example")).toMatchObject({ number: 7 });
  expect((await filed()).slice(4)).toEqual(["marked", "inbox", "inbox"]);
});

test("a sender at a domain with no DMARC record counts: marked as spam they're filed, and Not spam sticks", async () => {
  const { mail, filed, admin, asMember, senders } = await setup();
  await mail("e2e-kim@nodmarc.example", NONE); // #1
  await call(updateConversation, asMember, { number: 1, spam: true });
  await mail("e2e-kim@nodmarc.example", NONE); // #2
  expect(await filed()).toEqual(["marked", "marked_sender"]);
  // Nothing stays in the way: nothing to say.
  expect(await call(updateConversation, admin, { number: 2, spam: false })).not.toHaveProperty("notice");
  await mail("e2e-kim@nodmarc.example", NONE); // #3
  await mail("e2e-kim@nodmarc.example", NONE); // #4
  expect((await filed()).slice(1)).toEqual(["inbox", "inbox", "inbox"]);
  expect(await senders()).toEqual(["e2e-kim@nodmarc.example blocked by a member's mark", "e2e-kim@nodmarc.example allowed by an admin's mark"]);
});

test("the flood limit files what's past it from one address in an hour, allowed or trusted or not, and Not spam says it still applies", { timeout: 60_000 }, async () => {
  const { projectId, mail, filed, admin, told } = await setup({ hook: true });
  // Allowed by a teammate's Not spam, at a domain with no DMARC record: counted all the same.
  await mail("e2e-kim@nodmarc.example", NONE); // #1
  await call(updateConversation, admin, { number: 1, spam: true });
  await call(updateConversation, admin, { number: 1, spam: false });
  for (let i = 1; i < NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-kim@nodmarc.example", NONE);
  }
  expect(await filed()).toEqual(Array(NEW_BY_EMAIL_PER_HOUR).fill("inbox"));
  await mail("e2e-kim@nodmarc.example", NONE);
  expect((await filed()).at(-1)).toBe("flood");
  // Someone else's mail isn't held up by it.
  await mail("e2e-lee@nodmarc.example", NONE);
  expect((await filed()).at(-1)).toBe("inbox");

  const before = await told();
  expect(await call(updateConversation, admin, { number: NEW_BY_EMAIL_PER_HOUR + 1, spam: false })).toMatchObject({
    spam: false,
    notice: `The hourly limit still applies: past ${NEW_BY_EMAIL_PER_HOUR} new conversations by email from one address in an hour, more go to Spam.`,
  });
  expect(await told()).toBe(before + 1);
  await mail("e2e-kim@nodmarc.example", NONE);
  expect((await filed()).at(-1)).toBe("flood");

  // The project's own user, DMARC passed: trusted, and counted.
  await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  for (let i = 0; i < NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-sam@example.com");
  }
  expect((await filed()).at(-1)).toBe("inbox");
  await mail("e2e-sam@example.com");
  expect((await filed()).at(-1)).toBe("flood");
});

test("the flood limit counts the emails that started conversations: never a typed address, forged mail or replies; and an address on the allowed list is spared it", { timeout: 60_000 }, async () => {
  const { project, projectId, mail, filed, list, senders } = await setup();
  // Conversations where signed-out visitors typed the address (they have their own limits), and mail forged as it.
  await prisma.conversation.createMany({
    data: Array.from({ length: NEW_BY_EMAIL_PER_HOUR }, (_, i) => ({ projectId, number: i + 1, subject: "Hi", origin: "WIDGET" as const, email: "e2e-kim@example.com", visitorHash: `visitor-${i}` })),
  });
  await prisma.project.update({ where: { id: projectId }, data: { conversationCount: NEW_BY_EMAIL_PER_HOUR } });
  for (let i = 0; i < NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-kim@example.com", FAIL);
  }
  // Their own first email, and replies to it by its reply address: one conversation started.
  await mail("e2e-kim@example.com");
  const own = await prisma.conversation.findFirstOrThrow({ where: { projectId, origin: "EMAIL", spam: false } });
  const reply = supportAddress(project.slug, DOMAIN, own.replyToken);
  for (let i = 0; i < NEW_BY_EMAIL_PER_HOUR; i++) {
    await postEmail(rawEmail({ from: "e2e-kim@example.com", to: reply, body: `More ${i}` }), { recipient: reply });
  }
  expect(await prisma.conversationMessage.count({ where: { conversationId: own.id } })).toBe(NEW_BY_EMAIL_PER_HOUR + 1);
  await mail("e2e-kim@example.com");
  expect((await filed()).at(-1)).toBe("inbox");

  // An exact address an owner or admin put on the allowed list (a form that relays everyone's messages from one address).
  await list("e2e-forms@relay.example", false);
  for (let i = 0; i <= NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-forms@relay.example");
  }
  expect((await filed()).slice(-NEW_BY_EMAIL_PER_HOUR - 1)).toEqual(Array(NEW_BY_EMAIL_PER_HOUR + 1).fill("inbox"));
  // Its domain allowed isn't the address allowed: counted.
  await list("relay2.example", false);
  for (let i = 0; i <= NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-forms@relay2.example");
  }
  expect((await filed()).slice(-2)).toEqual(["inbox", "flood"]);
  expect(await senders()).toEqual(["e2e-forms@relay.example allowed by an admin, listed", "relay2.example allowed by an admin, listed"]);
});

test("a member's Not spam leaves an admin's blocked address and blocked domain in place, and says who can change it", async () => {
  const { mail, filed, list, asMember, senders, told } = await setup({ hook: true });
  await list("e2e-kim@corp.example", true);
  await list("spam.example", true);
  await mail("e2e-kim@corp.example"); // #1
  await mail("e2e-lee@mail.spam.example"); // #2
  expect(await filed()).toEqual(["blocked_address", "blocked_domain"]);

  expect(await call(updateConversation, asMember, { number: 1, spam: false })).toMatchObject({
    spam: false,
    spamReason: null,
    notice: "e2e-kim@corp.example stays blocked: an owner or admin can unblock it.",
  });
  expect(await call(updateConversation, asMember, { number: 2, spam: false })).toMatchObject({
    spam: false,
    notice: "spam.example stays blocked: an owner or admin can let e2e-lee@mail.spam.example through.",
  });
  // Both are back in the inbox, told as new; a member's Not spam against a blocked domain isn't kept at all.
  expect(await told()).toBe(2);
  expect(await senders()).toEqual([
    "e2e-kim@corp.example blocked by an admin, listed",
    "spam.example blocked by an admin, listed",
    "e2e-kim@corp.example allowed by a member's mark",
  ]);
  await mail("e2e-kim@corp.example"); // #3
  await mail("e2e-lee@mail.spam.example"); // #4
  expect(await filed()).toEqual(["inbox", "inbox", "blocked_address", "blocked_domain"]);

  // A spam mark the conversation had goes when a member unmarks it under a blocked domain: it's unmarked, no more.
  await call(updateConversation, asMember, { number: 2, spam: true });
  expect((await senders()).at(-1)).toBe("e2e-lee@mail.spam.example blocked by a member's mark");
  await call(updateConversation, asMember, { number: 2, spam: false });
  expect(await senders()).toHaveLength(3);
});

test("a sender at an allowed domain who's marked as spam is filed next time; the domain's other senders aren't", async () => {
  const { mail, filed, list, asMember } = await setup();
  await list("partner.example", false);
  await mail("e2e-kim@partner.example"); // #1
  await call(updateConversation, asMember, { number: 1, spam: true });
  await mail("e2e-kim@partner.example"); // #2
  await mail("e2e-lee@partner.example"); // #3
  expect(await filed()).toEqual(["marked", "marked_sender", "inbox"]);
});

test("once a domain is blocked, a member's earlier Not spam no longer counts, while an admin's still does", async () => {
  const { mail, filed, admin, asMember } = await setup();
  await mail("e2e-kim@late.example"); // #1
  await mail("e2e-lee@late.example"); // #2
  await mail("e2e-max@late.example"); // #3
  for (const [context, number] of [[asMember, 1], [admin, 2]] as const) {
    await call(updateConversation, context, { number, spam: true });
    await call(updateConversation, context, { number, spam: false });
  }
  await call(updateConversation, admin, { number: 3, spam: true, blockDomain: true });
  await mail("e2e-kim@late.example"); // #4
  await mail("e2e-lee@late.example"); // #5
  expect((await filed()).slice(3)).toEqual(["blocked_domain", "inbox"]);
  // An admin's Not spam after the block is an exception too, and says the block stays.
  expect(await call(updateConversation, admin, { number: 4, spam: false })).toMatchObject({
    notice: "late.example stays blocked. e2e-kim@late.example is let through from now on.",
  });
  await mail("e2e-kim@late.example"); // #6
  expect((await filed())[5]).toBe("inbox");
});

test("an owner's or admin's Not spam takes a blocked address off the list", async () => {
  const { projectId, mail, filed, list, admin, senders } = await setup();
  await list("e2e-kim@corp.example", true);
  await mail("e2e-kim@corp.example"); // #1
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId } });
  // Its button says so first: "Not spam, and unblock <address>".
  expect(await spamChoices(prisma, conversation, true)).toMatchObject({ unblocks: "e2e-kim@corp.example" });
  expect(await spamChoices(prisma, conversation, false)).toMatchObject({ unblocks: null });
  expect(await call(updateConversation, admin, { number: 1, spam: false })).toMatchObject({ notice: "e2e-kim@corp.example is unblocked." });
  expect(await senders()).toEqual(["e2e-kim@corp.example allowed by an admin's mark"]);
  await mail("e2e-kim@corp.example"); // #2
  expect(await filed()).toEqual(["inbox", "inbox"]);
});

test("trusted: the project's own users, teammates and people the team has replied to; never an account nobody vouched for", async () => {
  const { project, projectId, member, admin, mail } = await setup();
  const byEmail = async (sender: string, dmarc = "pass") =>
    (await spamVerdict(prisma, { projectId, address: sender, userId: null, proven: dmarc === "pass", email: { sender, dmarc } })).check;
  // A Tuti account with a verified address: anyone can make one. Signed in on the portal or writing by email, not trusted.
  const account = await signUp("Portal Pat");
  expect(await arrivalOf(prisma, projectId, account.id)).toMatchObject({ address: account.email, proven: true });
  expect((await spamVerdict(prisma, await arrivalOf(prisma, projectId, account.id))).check).toBeNull();
  expect(await byEmail(account.email)).toBeNull();
  // One whose address nobody checked has none the team's decisions could go by.
  const unverified = await signUp("Una", undefined, { verified: false });
  expect(await arrivalOf(prisma, projectId, unverified.id)).toMatchObject({ address: null });
  // Another project's user isn't this one's.
  const other = await createProject(await signUp("Other Owner"));
  const theirs = await upsertProjectUser(other.id, "user-1", { name: "Theirs", email: "e2e-theirs@example.com" });
  expect((await spamVerdict(prisma, await arrivalOf(prisma, projectId, theirs))).check).toBeNull();
  expect(await byEmail("e2e-theirs@example.com")).toBeNull();

  // A teammate, signed in or by email.
  expect((await spamVerdict(prisma, await arrivalOf(prisma, projectId, member.id))).check).toBe("trusted");
  expect(await byEmail(member.email)).toBe("trusted");
  // Someone the team has replied to (a note isn't a reply), even from a domain with no DMARC record.
  await mail("e2e-kim@nodmarc.example", NONE);
  await call(replyToConversation, admin, { number: 1, body: "Checking", note: true });
  expect(await byEmail("e2e-kim@nodmarc.example", "none")).toBeNull();
  await call(replyToConversation, admin, { number: 1, body: "Fixed!" });
  expect(await byEmail("e2e-kim@nodmarc.example", "none")).toBe("trusted");
  // Not through a conversation where a signed-out visitor typed the address.
  expect(await widgetStartConversation(project.slug, {}, "Hi", "e2e-typed@example.com")).toMatchObject({ number: 2 });
  await call(replyToConversation, admin, { number: 2, body: "Hello" });
  expect(await byEmail("e2e-typed@example.com")).toBeNull();
});

test("Not spam on what the filter filed tells the team and webhooks as a new conversation, once; on a teammate's mark it only unmarks", async () => {
  const { projectId, mail, list, admin, told, owner, member } = await setup({ hook: true });
  await list("spam.example", true);
  await mail("e2e-kim@spam.example"); // #1, filed: nobody told
  await call(createConversation, admin, { email: "e2e-lee@example.com", body: "Hello" }); // #2, told as it's created
  await call(updateConversation, admin, { number: 2, spam: true });
  const tellings = async () => [await told(), emailed(owner.email), emailed(member.email)];
  expect(await tellings()).toEqual([1, 1, 1]);

  const released = await call(updateConversation, admin, { number: 1, spam: false });
  expect(released).toMatchObject({ spam: false, spamReason: null });
  expect(await tellings()).toEqual([2, 2, 2]);
  const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhook: { projectId } }, orderBy: { createdAt: "desc" } });
  expect(delivery.payload).toMatchObject({ data: { number: 1, spam: false, messages: [{ author: "user", body: "Hello" }] } });
  const marked = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number: 1 } } });
  expect(marked).toMatchObject({ spam: false, spamReason: null, spamMarkedAt: expect.any(Date) });

  // Marked again and unmarked: it has no reason now, so nothing more is told. Nor for the one a teammate marked.
  await call(updateConversation, admin, { number: 1, spam: true });
  await call(updateConversation, admin, { number: 1, spam: false });
  await call(updateConversation, admin, { number: 2, spam: false });
  // Said again without a change: nothing is decided.
  await call(updateConversation, admin, { number: 2, spam: false });
  expect(await tellings()).toEqual([2, 2, 2]);
});

test("a mark goes with its conversation, and users.delete takes the marks on the address it erases; the lists' entries stay", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { project, projectId, mail, list, admin, senders } = await setup();
  const sam = await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  await mail("e2e-kim@example.com"); // #1
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, sam) }, "Hello")).toEqual({ number: 2 });
  await mail("e2e-sam@example.com"); // #3
  for (const number of [1, 2, 3]) {
    await call(updateConversation, admin, { number, spam: true });
  }
  await list("e2e-sam@example.com", true);
  await list("example.com", false);
  expect(await senders()).toHaveLength(5);

  // Past every plan's history, the daily job deletes the conversation: the example it was goes with it.
  await prisma.conversation.update({ where: { projectId_number: { projectId, number: 1 } }, data: { activeAt: new Date(Date.now() - 400 * 86_400_000) } });
  await handlers.deleteOldHistory({}, { info: () => {}, warn: () => {} });
  expect(await prisma.conversation.count({ where: { projectId } })).toBe(2);
  expect(await senders()).toEqual([
    "e2e-sam@example.com blocked by an admin's mark",
    "e2e-sam@example.com blocked by an admin's mark",
    "e2e-sam@example.com blocked by an admin, listed",
    "example.com allowed by an admin, listed",
  ]);

  await call(deleteUser, admin, { user: "user-42" });
  expect(await prisma.conversation.count({ where: { projectId } })).toBe(2);
  expect(await senders()).toEqual(["e2e-sam@example.com blocked by an admin, listed", "example.com allowed by an admin, listed"]);
});
