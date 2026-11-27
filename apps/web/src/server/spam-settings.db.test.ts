import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { NEW_BY_EMAIL_PER_HOUR } from "@/lib/spam-reasons";
import { widgetToken } from "@/lib/widget-session";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";

import { mailSubdomain, supportAddress } from "./inbound";
import { updateConversation } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { call } from "./operations/run";
import { getSpamSettings, trySpamFilter, updateSpamSettings } from "./operations/spam";
import { upsertProjectUser } from "./project-users";
import { arrivalOf, SPAM_CHECKS, spamVerdict } from "./spam";
import type { SpamRuleField, SpamRuleMatcher } from "@/lib/spam-rules";
import { widgetStartConversation } from "./widget-inbox";

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2 and W2b): the block rules and the allowed list through
 * spam.update, and trying a message. Emails as the receiver posts them.
 */

const DOMAIN = "tuti.email";
const FAIL = "spf=fail dkim=fail dmarc=fail";

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  actAs(null);
  const projectId = project.id;
  return {
    project,
    projectId,
    owner,
    admin,
    update: (input: Parameters<typeof updateSpamSettings.run>[1]) => call(updateSpamSettings, admin, input),
    /** An email from `from` to the project's address, DMARC passed unless said. */
    mail: async (from: string, message: { subject?: string; body?: string; auth?: string; headers?: Record<string, string> } = {}) => {
      expect(await postEmail(rawEmail({ from, to, subject: message.subject, body: message.body, headers: message.headers }), { recipient: to, ...(message.auth && { auth: message.auth }) })).toEqual({
        status: 200,
        body: { outcome: "added" },
      });
    },
    /** The rules as the page lists them, in words, newest first. */
    rules: async () => (await call(getSpamSettings, admin, {})).rules.map((rule) => `${rule.field} ${rule.matcher} ${rule.value}${rule.fromReport ? " (from a report)" : ""}`),
    /** Where each conversation is, by number: "inbox", or in Spam for the filter's reason. */
    filed: async () =>
      (await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { spam: true, spamReason: true } })).map((c) =>
        c.spam ? (c.spamReason ?? "marked") : "inbox",
      ),
  };
}

const rule = (field: SpamRuleField, matcher: SpamRuleMatcher, value: string) => ({ field, matcher, value });

test("the rules on what it says are check 5, after the flood limit", () => {
  expect(SPAM_CHECKS.map(({ key, whoeverSent }) => (whoeverSent ? `${key}, whoever sent it` : key))).toEqual([
    "decisions",
    "trusted",
    "dmarc",
    "flood, whoever sent it",
    "rules",
  ]);
});

test("each kind of rule files a new email, and the conversation keeps which rule", async () => {
  const { projectId, update, mail, filed } = await setup();
  await update({
    addRules: [
      rule("sender_domain", "is", "Spam.example"),
      rule("sender_address", "starts_with", "e2e-noreply@"),
      rule("sender_name", "contains", "facebook"),
      rule("subject", "pattern", "*you won*"),
      rule("body", "ends_with", "unsubscribe here"),
      rule("subject_or_body", "contains", "crypto"),
      rule("sent_to", "is", "sales@acme.example"),
    ],
  });
  await mail("e2e-a@m2.spam.example"); // #1: a subdomain
  await mail("e2e-noreply@strangers.example"); // #2
  await mail("Facebook Support <e2e-b@strangers.example>"); // #3: the display name, any case
  await mail("e2e-c@strangers.example", { subject: "Guess what, YOU WON a prize" }); // #4
  await mail("e2e-d@strangers.example", { body: "Great deals.\nUnsubscribe here" }); // #5
  await mail("e2e-e@strangers.example", { body: "Cryptography homework" }); // #6: not whole words
  await mail("e2e-f@strangers.example", { subject: "Free Crypto!" }); // #7
  await mail("e2e-g@strangers.example", { headers: { Cc: "Sales <sales@acme.example>" } }); // #8: To or Cc
  // #9: an address in a display name isn't where it was sent.
  await mail("e2e-h@strangers.example", { subject: "Hello", headers: { Cc: '"sales@acme.example" <e2e-other@acme.example>' } });
  expect(await filed()).toEqual(["blocked_domain", "rule", "rule", "rule", "rule", "inbox", "rule", "rule", "inbox"]);
  expect((await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { spamPhrase: true } })).map((c) => c.spamPhrase)).toEqual([
    "Sender domain is spam.example",
    "Sender address starts with e2e-noreply@",
    "Sender name contains facebook",
    "Subject matches pattern *you won*",
    "Body ends with unsubscribe here",
    null,
    "Subject or body contains crypto",
    "Sent to is sales@acme.example",
    null,
  ]);
  // An earlier check's answer stands: mail that failed DMARC is filed for that.
  await mail("e2e-i@strangers.example", { body: "crypto", auth: FAIL }); // #10
  expect((await filed())[9]).toBe("dmarc_failed");
});

test("trust and Not spam spare the rules on what it says, never those on who sent it; a stranger in the widget isn't spared", async () => {
  const { project, projectId, admin, update, mail, filed } = await setup();
  await update({ addRules: [rule("subject_or_body", "contains", "crypto"), rule("sender_domain", "ends_with", ".example.org")], allow: ["friends.example"] });
  await mail("e2e-kim@friends.example", { body: "About crypto" }); // #1: an allowed domain
  const sam = await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, sam) }, "Do you take crypto?")).toEqual({ number: 2 }); // one of the project's users
  expect(await widgetStartConversation(project.slug, {}, "Buy crypto now", "e2e-typed@strangers.example")).toMatchObject({ number: 3 }); // a signed-out visitor
  await mail("e2e-lee@strangers.example", { body: "Buy crypto now" }); // #4
  expect(await filed()).toEqual(["inbox", "inbox", "rule", "rule"]);

  // One of the project's users at a blocked domain: a rule on who sent it applies to them, trusted or not.
  const ola = await upsertProjectUser(projectId, "user-43", { name: "Ola", email: "e2e-ola@acme.example.org" });
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, ola) }, "Hello")).toEqual({ number: 5 });
  expect((await filed())[4]).toBe("rule");

  // Not spam on a sender whose address is proven lets them through from now on.
  expect((await call(updateConversation, admin, { number: 4, spam: false })).notice).toBeUndefined();
  await mail("e2e-lee@strangers.example", { body: "More crypto" }); // #6
  // On a visitor's typed address nothing is kept, and it says so: their next one is filed again.
  expect((await call(updateConversation, admin, { number: 3, spam: false })).notice).toBe("Nothing is remembered about its sender: a message your rules match still goes to Spam.");
  expect(await widgetStartConversation(project.slug, {}, "Crypto again", "e2e-typed@strangers.example")).toMatchObject({ number: 7 });
  expect((await filed()).slice(5)).toEqual(["inbox", "rule"]);
});

test("a rule on the sender's name reads a signed-in account's name, skipping one of the project's users", async () => {
  const { projectId, update } = await setup();
  await update({ addRules: [rule("sender_name", "contains", "giveaway")] });
  // A Tuti account nobody vouched for isn't trusted: its name is checked.
  const stranger = await signUp("Big Giveaway");
  actAs(null);
  expect(await spamVerdict(prisma, await arrivalOf(prisma, projectId, stranger.id))).toMatchObject({ spam: true, reason: "rule", phrase: "Sender name contains giveaway" });
  // One of the project's own users with such a name is trusted, so spared.
  const fan = await upsertProjectUser(projectId, "user-77", { name: "Giveaway Fan", email: "e2e-fan@example.com" });
  expect(await spamVerdict(prisma, await arrivalOf(prisma, projectId, fan))).toMatchObject({ spam: false, check: "trusted" });
});

test("check 1 with other rules on the sender: an allowed address beats them, they beat an allowed domain, an owner's Not spam beats them and a member's doesn't", async () => {
  const { projectId, admin, update, mail, filed } = await setup();
  const member = await addMember(projectId, "MEMBER");
  actAs(null);
  const asMember = { actor: { kind: "user" as const, userId: member.id }, projectId };
  await update({ addRules: [rule("sender_address", "starts_with", "e2e-noreply@")], allow: ["e2e-noreply-forms@relay.example", "corp.example"] });
  await mail("e2e-noreply-forms@relay.example"); // #1: the allowed address
  await mail("e2e-noreply@corp.example"); // #2: the rule, over the allowed domain
  await mail("e2e-noreply@a.example"); // #3
  await mail("e2e-noreply@b.example"); // #4
  expect(await filed()).toEqual(["inbox", "rule", "rule", "rule"]);
  // An owner's Not spam lets that sender through from now on, and says the rule still applies.
  expect((await call(updateConversation, admin, { number: 3, spam: false })).notice).toBe(
    "Your rule “Sender address starts with e2e-noreply@” still applies. e2e-noreply@a.example is let through from now on.",
  );
  // A member's isn't kept: the next one is filed again.
  expect((await call(updateConversation, asMember, { number: 4, spam: false })).notice).toBe(
    "Your rule “Sender address starts with e2e-noreply@” still applies: an owner or admin can let e2e-noreply@b.example through.",
  );
  await mail("e2e-noreply@a.example"); // #5
  await mail("e2e-noreply@b.example"); // #6
  expect((await filed()).slice(4)).toEqual(["inbox", "rule"]);
});

test("rules through spam.update: added and removed by ID, the same rule once, block and allow as rules and the allowed list, and a removed rule's next mail arrives", async () => {
  const { admin, update, mail, filed, rules } = await setup();
  const added = await update({ addRules: [rule("sender_domain", "is", "@Junk.example"), rule("subject", "contains", "Facebook Admin")], block: [" E2E-Kim@Spam.example "], allow: ["e2e-forms@relay.example"] });
  expect(added).toMatchObject({ allowed: ["e2e-forms@relay.example"] });
  expect(await rules()).toEqual(expect.arrayContaining(["sender_domain is junk.example", "subject contains Facebook Admin", "sender_address is e2e-kim@spam.example"]));
  expect(await rules()).toHaveLength(3);
  // The same rule however it's written is one.
  await update({ addRules: [rule("subject", "contains", "facebook-ADMIN"), rule("sender_domain", "is", "JUNK.example")], block: ["junk.example"] });
  expect(await rules()).toHaveLength(3);
  await mail("e2e-kim@spam.example"); // #1
  await mail("e2e-lee@m2.junk.example"); // #2
  expect(await filed()).toEqual(["blocked_address", "blocked_domain"]);

  // Removed by ID: the next mail arrives. One that isn't there, or another project's, is refused and nothing is removed.
  const id = (await call(getSpamSettings, admin, {})).rules.find((r) => r.value === "e2e-kim@spam.example")!.id;
  await expect(update({ removeRules: [id, "cm1norule"] })).rejects.toThrow(new OperationError(404, "not_found", "That rule was already removed"));
  expect(await rules()).toHaveLength(3);
  await update({ removeRules: [id] });
  await mail("e2e-kim@spam.example"); // #3
  // Allowing a blocked domain removes its rule; `remove` takes it off the allowed list again.
  expect(await update({ allow: ["junk.example"] })).toMatchObject({ allowed: ["e2e-forms@relay.example", "junk.example"] });
  expect(await rules()).toEqual(["subject contains Facebook Admin"]);
  await mail("e2e-lee@m2.junk.example"); // #4
  expect((await filed()).slice(2)).toEqual(["inbox", "inbox"]);
  // Blocking it again takes it off the allowed list: on one at a time.
  expect(await update({ block: ["junk.example"] })).toMatchObject({ allowed: ["e2e-forms@relay.example"] });
  expect(await update({ remove: ["@junk.example", "e2e-forms@relay.example"] })).toMatchObject({ allowed: [] });
  expect(await rules()).toEqual(["subject contains Facebook Admin"]);
});

test("spam.update refuses a rule whose value can't match as asked, a free-mail domain, an entry sent twice, and more than the filter holds", { timeout: 60_000 }, async () => {
  const { update } = await setup();
  const refused = async (input: Parameters<typeof update>[0], message: string) => expect(update(input), message).rejects.toThrow(new OperationError(400, "invalid_input", message));
  await refused({ addRules: [rule("sender_domain", "is", "com")] }, "Enter a domain, like acme.example");
  await refused({ addRules: [rule("sender_domain", "is", "mail.gmail.com")] }, "Anyone can get an address at mail.gmail.com, so it isn't blocked: block its addresses");
  await refused({ addRules: [rule("sender_address", "is", "kim@")] }, "Enter an address, like kim@acme.example");
  await refused({ addRules: [rule("subject", "contains", "!!!")] }, "Add a word");
  await refused({ addRules: [rule("body", "pattern", "*?*")] }, "Add something besides * and ?");
  await refused({ addRules: [rule("subject", "is", "   ")] }, "Enter a value");
  // "@" alone is nothing once a domain's "@" goes, and would match every sender.
  await refused({ addRules: [rule("sender_domain", "contains", "@")] }, "Enter a value");
  await refused({ block: ["co.uk"] }, "Enter an address or a domain, like kim@acme.example or acme.example");
  await refused({ block: ["acme.example"], allow: ["Acme.example"] }, "acme.example is there twice: block it, allow it or remove it");
  // An address there is one sender, and a domain anyone uses can still be matched another way, or allowed.
  await update({ addRules: [rule("sender_address", "is", "e2e-kim@gmail.com"), rule("sender_domain", "ends_with", "gmail.com")], allow: ["gmail.com"] });
  // The filter holds 500: adding past it is refused, and removing still works.
  await update({ addRules: Array.from({ length: 100 }, (_, i) => rule("subject", "is", `pitch ${i}`)) });
  for (let batch = 1; batch < 4; batch++) {
    await update({ addRules: Array.from({ length: 100 }, (_, i) => rule("subject", "is", `pitch ${batch * 100 + i}`)) });
  }
  await update({ addRules: Array.from({ length: 98 }, (_, i) => rule("body", "is", `pitch ${i}`)) });
  await expect(update({ addRules: [rule("body", "is", "one too many")] })).rejects.toThrow(new OperationError(409, "too_many", "The filter holds up to 500 rules: remove some first"));
});

test("two admins adding a rule at the same moment both keep theirs, and the same rule sent at once is one", async () => {
  const { update, rules } = await setup();
  await Promise.all(["facebook admin", "free followers", "seo services", "seo services"].map((value) => update({ addRules: [rule("subject_or_body", "contains", value)] })));
  expect((await rules()).sort()).toEqual(["subject_or_body contains facebook admin", "subject_or_body contains free followers", "subject_or_body contains seo services"]);
});

test("an address on the allowed list is spared the hourly limit too; a domain on it isn't", { timeout: 60_000 }, async () => {
  const { update, mail, filed } = await setup();
  await update({ allow: ["e2e-forms@relay.example", "relay2.example"] });
  for (let i = 0; i <= NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-forms@relay.example");
  }
  expect(await filed()).toEqual(Array(NEW_BY_EMAIL_PER_HOUR + 1).fill("inbox"));
  for (let i = 0; i <= NEW_BY_EMAIL_PER_HOUR; i++) {
    await mail("e2e-forms@relay2.example");
  }
  expect((await filed()).slice(-2)).toEqual(["inbox", "flood"]);
});

test("the blocked list and the phrases from before become rules, and file as they did", async () => {
  const { projectId, rules, mail, filed } = await setup();
  // As the release before kept them: list rows (an allowed one stays where it is, a mark isn't a rule) and phrases.
  await prisma.spamSender.createMany({
    data: [
      { projectId, sender: "e2e-kim@spam.example", blocked: true, byAdmin: true },
      { projectId, sender: "junk.example", blocked: true, byAdmin: true },
      { projectId, sender: "friends.example", blocked: false, byAdmin: true },
    ],
  });
  await prisma.project.update({ where: { id: projectId }, data: { spamPhrases: ["Facebook Admin", "crypto"] } });
  // The migration's copy, run again (the database was made with its table, and nothing to copy then).
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261127100000_spam_rules/migration.sql", import.meta.url), "utf8");
  for (const statement of sql.split(";").filter((part) => part.includes("INSERT INTO"))) {
    await prisma.$executeRawUnsafe(statement);
  }
  expect((await rules()).sort()).toEqual([
    "sender_address is e2e-kim@spam.example",
    "sender_domain is junk.example",
    "subject_or_body contains Facebook Admin",
    "subject_or_body contains crypto",
  ]);
  await mail("e2e-kim@spam.example"); // #1
  await mail("e2e-lee@m2.junk.example"); // #2
  await mail("e2e-lee@strangers.example", { subject: "The FACEBOOK admin" }); // #3
  await mail("e2e-ann@friends.example", { subject: "About crypto" }); // #4: still allowed
  expect(await filed()).toEqual(["blocked_address", "blocked_domain", "rule", "inbox"]);
});

test("trying a message says what the free checks would do with it and which rule matched, and changes nothing", async () => {
  const { projectId, owner, admin, update } = await setup();
  await update({ block: ["e2e-kim@spam.example"], addRules: [rule("sender_domain", "is", "junk.example"), rule("subject_or_body", "contains", "Facebook Admin")] });
  const rows = () => Promise.all([prisma.conversation.count(), prisma.inboundEmail.count(), prisma.spamSender.count({ where: { projectId } }), prisma.spamRule.count({ where: { projectId } })]);
  const before = await rows();
  const attempt = (sender: string, subject = "", text = "") => call(trySpamFilter, admin, { sender, subject, text });
  expect(await attempt("E2E-Kim@spam.example")).toEqual({ spam: true, reason: "blocked_address", why: "it matches your rule “Sender address is e2e-kim@spam.example”" });
  expect(await attempt("e2e-lee@m2.junk.example", "Hi")).toEqual({ spam: true, reason: "blocked_domain", why: "it matches your rule “Sender domain is junk.example”" });
  expect(await attempt("e2e-lee@strangers.example", "Hi", "This is the facebook admin.")).toEqual({
    spam: true,
    reason: "rule",
    why: "it matches your rule “Subject or body contains Facebook Admin”",
  });
  expect(await attempt("e2e-lee@strangers.example", "Hi", "Can I export to CSV?")).toEqual({ spam: false, reason: null, why: "no check filed it" });
  // A teammate is trusted, so the rule on what it says is spared.
  expect(await attempt(owner.email, "facebook admin")).toEqual({
    spam: false,
    reason: null,
    why: "this sender is trusted: one of your users, a teammate, or someone your team has replied to",
  });
  // The sender's name and where it was sent, for the rules on them.
  await update({ addRules: [rule("sender_name", "contains", "giveaway"), rule("sent_to", "is", "sales@acme.example")] });
  expect(await call(trySpamFilter, admin, { sender: "e2e-win@prizes.example", name: "Big Giveaway" })).toMatchObject({ spam: true, why: "it matches your rule “Sender name contains giveaway”" });
  expect(await call(trySpamFilter, admin, { sender: "e2e-win@prizes.example", to: ["Sales@acme.example"] })).toMatchObject({ spam: true, why: "it matches your rule “Sent to is sales@acme.example”" });
  await update({ allow: ["e2e-lee@strangers.example"] });
  expect(await attempt("e2e-lee@strangers.example", "facebook admin")).toEqual({ spam: false, reason: null, why: "your lists and marks let this sender through" });
  expect(await rows()).toEqual([before[0], before[1], before[2] + 1, before[3] + 2]);
});
