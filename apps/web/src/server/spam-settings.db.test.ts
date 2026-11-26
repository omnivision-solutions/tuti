import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { NEW_BY_EMAIL_PER_HOUR } from "@/lib/spam-reasons";
import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";

import { mailSubdomain, supportAddress } from "./inbound";
import { getConversation, updateConversation } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { call } from "./operations/run";
import { getSpamSettings, trySpamFilter, updateSpamSettings } from "./operations/spam";
import { upsertProjectUser } from "./project-users";
import { SPAM_CHECKS } from "./spam";
import { widgetStartConversation } from "./widget-inbox";

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2): the lists through spam.update, the team's phrases (check 5) and
 * trying a message. Emails as the receiver posts them.
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
    mail: async (from: string, message: { subject?: string; body?: string; auth?: string } = {}) => {
      expect(await postEmail(rawEmail({ from, to, subject: message.subject, body: message.body }), { recipient: to, ...(message.auth && { auth: message.auth }) })).toEqual({
        status: 200,
        body: { outcome: "added" },
      });
    },
    /** Where each conversation is, by number: "inbox", or in Spam for the filter's reason. */
    filed: async () =>
      (await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { spam: true, spamReason: true } })).map((c) =>
        c.spam ? (c.spamReason ?? "marked") : "inbox",
      ),
  };
}

test("the team's phrases are check 5, after the flood limit", () => {
  expect(SPAM_CHECKS.map(({ key, whoeverSent }) => (whoeverSent ? `${key}, whoever sent it` : key))).toEqual([
    "decisions",
    "trusted",
    "dmarc",
    "flood, whoever sent it",
    "phrases",
  ]);
});

test("a phrase files a new conversation: whole words, any case, in the subject or the text, and the conversation keeps which", async () => {
  const { projectId, admin, update, mail, filed } = await setup();
  expect(await update({ addPhrases: ["Facebook Admin", "crypto"] })).toMatchObject({ phrases: ["Facebook Admin", "crypto"] });
  await mail("e2e-a@strangers.example", { subject: "FACEBOOK admin notice" }); // #1: the subject, any case
  await mail("e2e-b@strangers.example", { body: "We are the facebook-admin team.\nAct now." }); // #2: the text, whatever is between the words
  await mail("e2e-c@strangers.example", { body: "From the facebook administrators" }); // #3: not whole words
  await mail("e2e-d@strangers.example", { subject: "facebook", body: "admin here" }); // #4: never across the subject and the text
  await mail("e2e-e@strangers.example", { body: "Cryptography homework" }); // #5
  await mail("e2e-f@strangers.example", { body: "Free crypto!" }); // #6
  expect(await filed()).toEqual(["phrase", "phrase", "inbox", "inbox", "inbox", "phrase"]);
  expect(await call(getConversation, admin, { number: 1 })).toMatchObject({ spam: true, spamReason: "phrase" });
  expect((await prisma.conversation.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { spamPhrase: true } })).map((c) => c.spamPhrase)).toEqual([
    "Facebook Admin",
    "Facebook Admin",
    null,
    null,
    null,
    "crypto",
  ]);
  // An earlier check's answer stands: mail that failed DMARC is filed for that.
  await mail("e2e-g@strangers.example", { body: "crypto", auth: FAIL }); // #7
  expect((await filed())[6]).toBe("dmarc_failed");
  // With the phrase gone, the same mail arrives.
  expect(await update({ removePhrases: ["CRYPTO!"] })).toMatchObject({ phrases: ["Facebook Admin"] });
  await mail("e2e-f@strangers.example", { body: "Free crypto!" }); // #8
  expect((await filed())[7]).toBe("inbox");
});

test("an allow or trust spares the phrases, in the widget too; a stranger there isn't spared, and Not spam says what it leaves", async () => {
  const { project, projectId, admin, update, mail, filed } = await setup();
  await update({ addPhrases: ["crypto"], allow: ["friends.example"] });
  await mail("e2e-kim@friends.example", { body: "About crypto" }); // #1: an allowed domain
  const sam = await upsertProjectUser(projectId, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  expect(await widgetStartConversation(project.slug, { token: widgetToken(projectId, sam) }, "Do you take crypto?")).toEqual({ number: 2 }); // one of the project's users
  expect(await widgetStartConversation(project.slug, {}, "Buy crypto now", "e2e-typed@strangers.example")).toMatchObject({ number: 3 }); // a signed-out visitor
  await mail("e2e-lee@strangers.example", { body: "Buy crypto now" }); // #4
  expect(await filed()).toEqual(["inbox", "inbox", "phrase", "phrase"]);

  // Not spam on a sender whose address is proven lets them through from now on.
  expect((await call(updateConversation, admin, { number: 4, spam: false })).notice).toBeUndefined();
  await mail("e2e-lee@strangers.example", { body: "More crypto" }); // #5
  // On a visitor's typed address nothing is kept, and it says so: their next one with the phrase is filed again.
  expect((await call(updateConversation, admin, { number: 3, spam: false })).notice).toBe(
    "Nothing is remembered about its sender: a message with one of your phrases still goes to Spam.",
  );
  expect(await widgetStartConversation(project.slug, {}, "Crypto again", "e2e-typed@strangers.example")).toMatchObject({ number: 6 });
  expect((await filed()).slice(4)).toEqual(["inbox", "phrase"]);
});

test("the lists through spam.update: added in lowercase, a domain for its subdomains, moved between lists, and a removed address's next mail arrives", async () => {
  const { admin, update, mail, filed } = await setup();
  expect(await update({ block: [" E2E-Kim@Spam.example ", "@junk.example"], allow: ["e2e-forms@relay.example"] })).toEqual({
    blocked: ["e2e-kim@spam.example", "junk.example"],
    allowed: ["e2e-forms@relay.example"],
    phrases: [],
    guidance: "",
  });
  expect(await call(getSpamSettings, admin, {})).toMatchObject({ blocked: ["e2e-kim@spam.example", "junk.example"] });
  await mail("e2e-kim@spam.example"); // #1
  await mail("e2e-lee@m2.junk.example"); // #2
  await mail("e2e-lee@spam.example"); // #3: the address was blocked, not its domain
  expect(await filed()).toEqual(["blocked_address", "blocked_domain", "inbox"]);

  // Taken off the list: the next mail arrives. One that isn't on a list is no error.
  expect(await update({ remove: ["e2e-kim@spam.example", "nobody.example"] })).toMatchObject({ blocked: ["junk.example"] });
  await mail("e2e-kim@spam.example"); // #4
  // One entry per address or domain: allowing a blocked one moves it.
  expect(await update({ allow: ["junk.example"] })).toMatchObject({ blocked: [], allowed: ["e2e-forms@relay.example", "junk.example"] });
  await mail("e2e-lee@m2.junk.example"); // #5
  expect((await filed()).slice(3)).toEqual(["inbox", "inbox"]);
  // A domain spelled with its "@", as block and allow take it, is taken off too.
  expect(await update({ remove: ["@junk.example"] })).toMatchObject({ allowed: ["e2e-forms@relay.example"] });
});

test("spam.update refuses what isn't an address or a domain, a suffix, a free-mail domain on the blocked list, an entry sent twice, and a phrase without a word", async () => {
  const { admin, update } = await setup();
  const entry = "Enter an address or a domain, like kim@acme.example or acme.example";
  for (const bad of ["not an address", "kim@", "com", "co.uk", "https://acme.example/pricing"]) {
    await expect(update({ block: [bad] }), bad).rejects.toThrow(new OperationError(400, "invalid_input", entry));
  }
  await expect(update({ block: ["mail.gmail.com"] })).rejects.toThrow("Anyone can get an address at mail.gmail.com, so it isn't blocked: block its addresses");
  await expect(update({ block: ["acme.example"], allow: ["Acme.example"] })).rejects.toThrow("acme.example is there twice: block it, allow it or remove it");
  await expect(update({ addPhrases: ["!!!"] })).rejects.toThrow("Each phrase needs a word in it");
  // An address there is one sender, and allowing the domain blocks nobody: both are taken.
  await update({ block: ["e2e-kim@gmail.com"], allow: ["gmail.com"] });
  // Phrases that match the same text are one, sent together or added later.
  expect(await update({ addPhrases: ["Facebook admin", "facebook  ADMIN", "crypto"] })).toEqual({ blocked: ["e2e-kim@gmail.com"], allowed: ["gmail.com"], phrases: ["Facebook admin", "crypto"], guidance: "" });
  expect(await update({ addPhrases: ["facebook-admin"] })).toMatchObject({ phrases: ["Facebook admin", "crypto"] });
  expect(await call(getSpamSettings, admin, {})).toMatchObject({ phrases: ["Facebook admin", "crypto"] });
  // The list holds 50: adding past it is refused, and taking one out still works.
  await update({ addPhrases: Array.from({ length: 48 }, (_, i) => `phrase ${i}`) });
  await expect(update({ addPhrases: ["one too many"] })).rejects.toThrow(new OperationError(409, "too_many", "The list holds up to 50 phrases: remove some first"));
  expect((await update({ removePhrases: ["crypto"], addPhrases: ["one too many"] })).phrases).toHaveLength(50);
});

test("two admins adding a phrase at the same moment both keep theirs", async () => {
  const { admin, update } = await setup();
  await update({ addPhrases: ["crypto"] });
  await Promise.all(["facebook admin", "free followers", "seo services", "guest post"].map((phrase) => update({ addPhrases: [phrase] })));
  expect((await call(getSpamSettings, admin, {})).phrases.sort()).toEqual(["crypto", "facebook admin", "free followers", "guest post", "seo services"]);
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

test("trying a message says what the free checks would do with it and why, and changes nothing", async () => {
  const { projectId, owner, admin, update } = await setup();
  await update({ block: ["e2e-kim@spam.example", "junk.example"], addPhrases: ["Facebook Admin"] });
  const rows = () => Promise.all([prisma.conversation.count(), prisma.inboundEmail.count(), prisma.spamSender.count({ where: { projectId } })]);
  const before = await rows();
  const attempt = (sender: string, subject = "", text = "") => call(trySpamFilter, admin, { sender, subject, text });
  expect(await attempt("E2E-Kim@spam.example")).toEqual({ spam: true, reason: "blocked_address", why: "you blocked this address" });
  expect(await attempt("e2e-lee@m2.junk.example", "Hi")).toEqual({ spam: true, reason: "blocked_domain", why: "you blocked this address's domain" });
  expect(await attempt("e2e-lee@strangers.example", "Hi", "This is the facebook admin.")).toEqual({ spam: true, reason: "phrase", why: "it has your phrase “Facebook Admin”" });
  expect(await attempt("e2e-lee@strangers.example", "Hi", "Can I export to CSV?")).toEqual({ spam: false, reason: null, why: "no check filed it" });
  // A teammate is trusted, so the phrase is spared.
  expect(await attempt(owner.email, "facebook admin")).toEqual({
    spam: false,
    reason: null,
    why: "this sender is trusted: one of your users, a teammate, or someone your team has replied to",
  });
  await update({ allow: ["e2e-lee@strangers.example"] });
  expect(await attempt("e2e-lee@strangers.example", "facebook admin")).toEqual({ spam: false, reason: null, why: "your lists and marks let this sender through" });
  expect(await rows()).toEqual([before[0], before[1], before[2] + 1]);
});
