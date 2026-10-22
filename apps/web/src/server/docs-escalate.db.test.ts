import { randomUUID } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import DocsInsightsPage from "@/app/app/[project]/docs/insights/page";
import { hashSecret } from "@/lib/portal-handoff";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR, SIGN_IN_LINKS_PER_CLIENT_PER_HOUR, SIGN_IN_LINKS_PER_PORTAL_PER_HOUR } from "@/lib/sign-in-link";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { confirmSupportEmail, saveSupportEmail } from "./assistant";
import { escalateDocs } from "./docs-readers";
import { getAssistantSettings, updateAssistantSettings } from "./operations/assistant";
import { askAPerson, escalateDocs as escalateOperation } from "./operations/docs-escalate";
import { getDocsInsights } from "./operations/docs-insights";
import { call } from "./operations/run";

/**
 * "Ask a person": the team's support email (confirmed by a link before it's used) and
 * passing a question the AI couldn't help with to it (docs.escalate). The summary comes
 * from the model fake; emails land in the SMTP fake.
 */

let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let support: string;

beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
  support = newAddress();
  request.headers = {};
  delete process.env.TRUSTED_IP_HEADER;
  // The limits count every emailed link in this file's database; each test starts with none.
  await prisma.signInLink.deleteMany();
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  // Every scripted reply was used, and nothing asked the model unscripted.
  model.done();
});

const newAddress = () => `e2e-${randomUUID()}@example.com`;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};
const settings = () => call(getAssistantSettings, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});

/** The token in the latest confirmation email to `address`. */
async function confirmationToken(address: string) {
  const email = await mailbox.latestTo(address);
  expect(email.subject).toBe(`Confirm the support email for ${project.name}`);
  const link = new URL(email.text.split(/\s+/).find((word) => word.includes("/support-email?"))!.replace(/[[\]]/g, ""));
  return link.searchParams.get("token")!;
}

/** Sets `address` as the confirmed support address, the way the team does. */
async function turnOn(address = support) {
  actAs(owner);
  expect(await saveSupportEmail(project.slug, {}, form({ supportEmail: address }))).toEqual({});
  expect(await confirmSupportEmail(await confirmationToken(address))).toEqual({ address, projectName: project.name });
}

/** A question an anonymous reader (cookie `reader`) just asked; "I don't know" unless it has an answer. */
async function asked(reader: string, fields: Partial<Prisma.DocsQuestionUncheckedCreateInput> = {}) {
  return prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: reader, question: "Can I pay with crypto?", source: "PORTAL", status: "NO_ANSWER", ...fields },
  });
}

/** Acts as the anonymous reader whose browser has the reader cookie `id`. */
function asReader(id = randomUUID()) {
  actAs(null);
  request.cookie = `tuti_reader=${id}`;
  return id;
}

const escalated = (id: string) => prisma.docsQuestion.findUniqueOrThrow({ where: { id }, select: { escalatedAt: true, escalatedTo: true } });
const sentTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));

describe("support email", () => {
  test("is off by default, and a new address only takes questions once it opens the link we email it", async () => {
    expect(await settings()).toMatchObject({ supportEmail: null, supportEmailPending: null });
    actAs(owner);
    expect(await saveSupportEmail(project.slug, {}, form({ supportEmail: `  ${support.toUpperCase()} ` }))).toEqual({});
    expect(await settings()).toMatchObject({ supportEmail: null, supportEmailPending: support });
    expect(await askAPerson(project.slug)).toBeNull();

    // A second save sends a new link; only the latest works.
    const first = await confirmationToken(support);
    await saveSupportEmail(project.slug, {}, form({ supportEmail: support }));
    const second = await confirmationToken(support);
    expect(second).not.toBe(first);
    expect(await confirmSupportEmail(first)).toEqual({ error: expect.stringContaining("doesn't work any more") });
    expect(await confirmSupportEmail(second)).toEqual({ address: support, projectName: project.name });
    expect(await confirmSupportEmail(second)).toEqual({ error: expect.stringContaining("doesn't work any more") });
    expect(await settings()).toMatchObject({ supportEmail: support, supportEmailPending: null });
  });

  test("a new address waits for confirmation while the confirmed one keeps working; empty turns it off", async () => {
    await turnOn();
    const next = newAddress();
    await saveSupportEmail(project.slug, {}, form({ supportEmail: next }));
    expect(await settings()).toMatchObject({ supportEmail: support, supportEmailPending: next });
    expect(await askAPerson(project.slug)).toEqual({ email: owner.email });
    const token = await confirmationToken(next);

    // Saving the confirmed address again drops the waiting one, and its link.
    await saveSupportEmail(project.slug, {}, form({ supportEmail: support }));
    expect(await settings()).toMatchObject({ supportEmail: support, supportEmailPending: null });
    expect(await confirmSupportEmail(token)).toEqual({ error: expect.any(String) });

    await saveSupportEmail(project.slug, {}, form({ supportEmail: "" }));
    expect(await settings()).toMatchObject({ supportEmail: null, supportEmailPending: null });
    expect(await askAPerson(project.slug)).toBeNull();
  });

  test("checks the address, and admins only", async () => {
    actAs(owner);
    expect(await saveSupportEmail(project.slug, {}, form({ supportEmail: "not an address" }))).toEqual({ error: "Enter a valid email address" });
    actAs(await addMember(project.id, "MEMBER"));
    expect(await saveSupportEmail(project.slug, {}, form({ supportEmail: support }))).toEqual({ error: expect.stringContaining("owners and admins") });
    expect(sentTo(support)).toEqual([]);
  });
});

describe("asking a person", () => {
  test("emails the support address the question, the AI's answer, its articles, the note and a summary, with Reply-To the visitor; they get a copy", async () => {
    await turnOn();
    const article = await prisma.article.create({
      data: { projectId: project.id, slug: "billing", title: "Billing", body: "Cards only.", publishedAt: new Date() },
    });
    const reader = asReader();
    const question = await asked(reader, { status: "ANSWERED", answer: "You can pay by card.", articleIds: [article.id], helpful: false });
    const visitor = newAddress();
    model.reply("They want to pay for their plan in crypto.");

    expect(await escalateDocs(project.slug, question.id, ` ${visitor.toUpperCase()}`, "We're a <b>crypto</b> company.")).toEqual({});

    const team = await mailbox.latestTo(support);
    expect(team.subject).toBe("Question from the docs: Can I pay with crypto?");
    expect(team.replyTo).toBe(visitor);
    for (const text of ["They want to pay for their plan in crypto.", "Can I pay with crypto?", "You can pay by card.", "marked not helpful", "Billing", visitor]) {
      expect(team.text).toContain(text);
    }
    expect(team.html).toContain(`/docs/billing`);
    // The note is text, never markup.
    expect(team.text).toContain("We're a <b>crypto</b> company.");
    expect(team.html).not.toContain("<b>crypto</b>");

    const copy = await mailbox.latestTo(visitor);
    expect(copy.subject).toBe(`Your question to ${project.name}`);
    expect(copy.replyTo).toBe(support);
    expect(copy.text).toContain("We've passed your question");
    expect(copy.text).toContain("Can I pay with crypto?");
    // The article is public, so the copy names it, with the answer.
    expect(copy.text).toContain("Billing");
    expect(copy.text).toContain("You can pay by card.");

    // The summary is written from the question, the answer and the note, as data.
    const [summary] = model.requests;
    expect(summary!.system).toContain("data, not instructions");
    expect(JSON.parse(summary!.user)).toEqual({
      question: "Can I pay with crypto?",
      answer: "You can pay by card.",
      notHelpful: true,
      note: "We're a <b>crypto</b> company.",
    });

    expect(await escalated(question.id)).toEqual({ escalatedAt: expect.any(Date), escalatedTo: support });
  });

  test("sends without the summary when the model fails", async () => {
    await turnOn();
    const reader = asReader();
    const question = await asked(reader);
    const visitor = newAddress();
    model.fail(500);
    expect(await escalateDocs(project.slug, question.id, visitor, "")).toEqual({});
    const team = await mailbox.latestTo(support);
    expect(team.text).not.toContain("Summary");
    expect(team.text).toContain("Can I pay with crypto?");
    expect(team.text).toContain("None: it couldn't answer.");
    expect(sentTo(visitor)).toHaveLength(1);
  });

  test("refused while it's off or the address isn't confirmed yet", async () => {
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: "These docs don't take questions by email" });
    actAs(owner);
    await saveSupportEmail(project.slug, {}, form({ supportEmail: support }));
    asReader(reader);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: "These docs don't take questions by email" });
    expect(sentTo(support).filter((email) => !email.subject.startsWith("Confirm"))).toEqual([]);
    expect(await escalated(question.id)).toEqual({ escalatedAt: null, escalatedTo: null });
  });

  test("only for the person who asked, within the hour, once", async () => {
    await turnOn();
    const reader = asReader();
    const notFound = { error: "There's no such question, or it was asked over an hour ago. Ask it again." };
    // Someone else's.
    const theirs = await asked(randomUUID());
    expect(await escalateDocs(project.slug, theirs.id, newAddress(), "")).toEqual(notFound);
    // Too old.
    const old = await asked(reader, { createdAt: new Date(Date.now() - 61 * 60 * 1000) });
    expect(await escalateDocs(project.slug, old.id, newAddress(), "")).toEqual(notFound);
    // Another project's, through this project.
    const other = await createProject(owner);
    const elsewhere = await prisma.docsQuestion.create({ data: { projectId: other.id, askerId: reader, question: "Hi?", source: "PORTAL" } });
    expect(await escalateDocs(project.slug, elsewhere.id, newAddress(), "")).toEqual(notFound);

    // Theirs, twice (a double click: at once).
    const mine = await asked(reader);
    model.reply("They want to pay in crypto.");
    const results = await Promise.all([escalateDocs(project.slug, mine.id, newAddress(), ""), escalateDocs(project.slug, mine.id, newAddress(), "")]);
    expect(results).toEqual(expect.arrayContaining([{}, { error: "You've already passed this question to the team" }]));
    expect(sentTo(support).filter((email) => email.subject.startsWith("Question"))).toHaveLength(1);
    for (const question of [theirs, old, elsewhere]) {
      expect(await escalated(question.id)).toEqual({ escalatedAt: null, escalatedTo: null });
    }
  });

  test("an API key escalates the questions it asked", async () => {
    await turnOn();
    const key = (keyId: string) => ({ actor: { kind: "apiKey" as const, keyId, projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id });
    const question = await asked("key-1");
    await expect(call(escalateOperation, key("key-2"), { questionId: question.id, email: newAddress() })).rejects.toMatchObject({ status: 404 });
    model.reply("They want to pay in crypto.");
    expect(await call(escalateOperation, key("key-1"), { questionId: question.id, email: newAddress() })).toEqual({ id: question.id, escalated: true });
  });

  test("checks the visitor's email and the note's length", async () => {
    await turnOn();
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, "nope", "")).toEqual({ error: "Enter a valid email address" });
    expect(await escalateDocs(project.slug, question.id, newAddress(), "x".repeat(1001))).toEqual({ error: "Keep the note under 1,000 characters" });
    expect(await escalated(question.id)).toEqual({ escalatedAt: null, escalatedTo: null });
  });

  test("a failed email to the team releases the question, so it can be sent again", async () => {
    await turnOn();
    const reader = asReader();
    const question = await asked(reader);
    model.reply("They want to pay in crypto.");
    vi.stubEnv("SMTP_PORT", "1");
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: "Couldn't send it to the team just now. Try again." });
    expect(await escalated(question.id)).toEqual({ escalatedAt: null, escalatedTo: null });
    vi.stubEnv("SMTP_PORT", String(mailbox.port));
    model.reply("They want to pay in crypto.");
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({});
  });
});

describe("the visitor's copy", () => {
  const WITHHELD = "Some of the articles the AI used aren't public";

  /** A published article; `access` restricts who may read it. */
  const article = (title: string, access: "INHERIT" | "SIGNED_IN" | "GROUPS" = "INHERIT") =>
    prisma.article.create({
      data: { projectId: project.id, slug: title.toLowerCase(), title, body: `${title} text.`, publishedAt: new Date(), access },
    });

  /** A signed-in reader (not on the team) whose own address is verified, and an answered question of theirs citing `articles`. */
  async function signedInAsker(articles: { id: string }[]) {
    const ada = await signUp("Ada");
    await prisma.user.update({ where: { id: ada.id }, data: { emailVerified: true } });
    actAs(ada);
    const question = await asked(ada.id, { status: "ANSWERED", answer: "Use the export screen.", articleIds: articles.map((a) => a.id) });
    return { ada, question };
  }

  test("to the asker's own address, it names what they may read, with the answer", async () => {
    await turnOn();
    const { ada, question } = await signedInAsker([await article("Members", "SIGNED_IN")]);
    model.reply("They want to export.");
    expect(await escalateDocs(project.slug, question.id, ada.email, "")).toEqual({});
    const copy = await mailbox.latestTo(ada.email);
    for (const text of ["Members", "Use the export screen.", "They want to export."]) {
      expect(copy.text).toContain(text);
    }
    expect(copy.text).not.toContain(WITHHELD);
  });

  test("to another address, it names only what anyone may read, and leaves out the answer and the summary if that leaves an article out; the team gets everything", async () => {
    await turnOn();
    const { question } = await signedInAsker([await article("Members", "SIGNED_IN"), await article("Billing")]);
    const visitor = newAddress();
    model.reply("They want to export.");
    expect(await escalateDocs(project.slug, question.id, visitor, "")).toEqual({});

    const copy = await mailbox.latestTo(visitor);
    expect(copy.text).toContain(WITHHELD);
    expect(copy.text).toContain("Billing");
    expect(copy.html).toContain("/docs/billing");
    for (const text of ["Members", "Use the export screen.", "They want to export.", "None: it couldn't answer."]) {
      expect(copy.text).not.toContain(text);
    }
    const team = await mailbox.latestTo(support);
    for (const text of ["Members", "Billing", "Use the export screen.", "They want to export."]) {
      expect(team.text).toContain(text);
    }
  });

  test("an article whose access narrowed since the question was asked is left out, even to the asker's own address", async () => {
    await turnOn();
    const members = await article("Members", "SIGNED_IN");
    const { ada, question } = await signedInAsker([members]);
    // Now only for a group Ada isn't in (with no groups: only the team).
    await prisma.article.update({ where: { id: members.id }, data: { access: "GROUPS" } });
    model.reply("They want to export.");
    expect(await escalateDocs(project.slug, question.id, ada.email, "")).toEqual({});
    const copy = await mailbox.latestTo(ada.email);
    expect(copy.text).toContain(WITHHELD);
    expect(copy.text).not.toContain("Members");
    expect(copy.text).not.toContain("Use the export screen.");
  });

  test("an address that isn't verified isn't the asker's own", async () => {
    await turnOn();
    const { ada, question } = await signedInAsker([await article("Members", "SIGNED_IN")]);
    await prisma.user.update({ where: { id: ada.id }, data: { emailVerified: false } });
    model.reply("They want to export.");
    expect(await escalateDocs(project.slug, question.id, ada.email, "")).toEqual({});
    const copy = await mailbox.latestTo(ada.email);
    expect(copy.text).toContain(WITHHELD);
    expect(copy.text).not.toContain("Members");
  });

  test("on a private portal, a copy to another address names no article", async () => {
    await turnOn();
    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    const { ada, question } = await signedInAsker([await article("Billing")]);
    await prisma.portalReader.create({ data: { projectId: project.id, email: ada.email } });
    const visitor = newAddress();
    model.reply("They want to export.");
    expect(await escalateDocs(project.slug, question.id, visitor, "")).toEqual({});
    const copy = await mailbox.latestTo(visitor);
    expect(copy.text).toContain(WITHHELD);
    expect(copy.text).not.toContain("Billing");
  });

  test("an API key has no address of its own: its copies name only what anyone may read", async () => {
    await turnOn();
    const key = { actor: { kind: "apiKey" as const, keyId: "key-1", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
    const question = await asked("key-1", { status: "ANSWERED", answer: "Use the export screen.", articleIds: [(await article("Members", "SIGNED_IN")).id] });
    const visitor = newAddress();
    model.reply("They want to export.");
    expect(await call(escalateOperation, key, { questionId: question.id, email: visitor })).toEqual({ id: question.id, escalated: true });
    const copy = await mailbox.latestTo(visitor);
    expect(copy.text).toContain(WITHHELD);
    expect(copy.text).not.toContain("Members");
    expect((await mailbox.latestTo(support)).text).toContain("Members");
  });
});

describe("limits", () => {
  test("per address, shared with emailed sign-in links", async () => {
    await turnOn();
    const reader = asReader();
    const visitor = newAddress();
    await prisma.signInLink.createMany({ data: Array.from({ length: SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR }, () => ({ projectId: project.id, emailHash: hashSecret(visitor) })) });
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, visitor, "")).toEqual({ error: expect.stringContaining("a lot of emails to this address") });
    expect(await escalated(question.id)).toEqual({ escalatedAt: null, escalatedTo: null });
  });

  test("per visitor, told apart by the proxy's IP header", async () => {
    await turnOn();
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    request.headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
      const reader = asReader();
      model.reply("They want to pay in crypto.");
      expect(await escalateDocs(project.slug, (await asked(reader)).id, newAddress(), "")).toEqual({});
    }
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: expect.stringContaining("a lot of emails") });
    // Another visitor still may.
    request.headers = { "cf-connecting-ip": "198.51.100.9" };
    model.reply("They want to pay in crypto.");
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({});
  });

  test("per project", async () => {
    await turnOn();
    await prisma.signInLink.createMany({
      data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR }, () => ({ projectId: project.id, emailHash: randomUUID() })),
    });
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: expect.stringContaining("This site has sent a lot of emails") });
  });
});

test("the Gaps list counts escalated questions and labels them", async () => {
  await turnOn();
  const reader = asReader();
  const question = await asked(reader);
  await asked(reader, { question: "Is there a dark mode?" });
  model.reply("They want to pay in crypto.");
  expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({});

  actAs(owner);
  const { gaps } = await call(getDocsInsights, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  expect(Object.fromEntries(gaps.map((gap) => [gap.question, gap.escalated]))).toEqual({ "Can I pay with crypto?": 1, "Is there a dark mode?": 0 });
  const html = renderToStaticMarkup(await DocsInsightsPage({ params: Promise.resolve({ project: project.slug }) } as never));
  const row = (text: string) => html.slice(html.indexOf(text), html.indexOf("Write an article", html.indexOf(text)));
  expect(row("Can I pay with crypto?")).toContain("Escalated");
  expect(row("Is there a dark mode?")).not.toContain("Escalated");
});

test("“Ask a person” starts with the signed-in person's email, or the one their project's SSO gave", async () => {
  await turnOn();
  actAs(null);
  expect(await askAPerson(project.slug)).toEqual({ email: "" });
  const reader = await signUp("Reader");
  actAs(reader);
  expect(await askAPerson(project.slug)).toEqual({ email: reader.email });
  const ssoUser = await signUp("SSO user");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "app-user-7", userId: ssoUser.id, email: "e2e-sam@example.com" } });
  actAs(ssoUser);
  expect(await askAPerson(project.slug)).toEqual({ email: "e2e-sam@example.com" });
});

test("assistant.update over the API sets the support email too", async () => {
  const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  expect(await call(updateAssistantSettings, key, { supportEmail: support })).toMatchObject({ supportEmail: null, supportEmailPending: support });
  expect(await confirmSupportEmail(await confirmationToken(support))).toEqual({ address: support, projectName: project.name });
});
