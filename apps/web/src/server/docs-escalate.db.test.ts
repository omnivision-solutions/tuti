import { randomUUID } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import ReportingUnansweredPage from "@/app/app/[project]/reporting/unanswered/page";
import { hashSecret } from "@/lib/portal-handoff";
import { widgetToken } from "@/lib/widget-session";
import { SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR, SIGN_IN_LINKS_PER_CLIENT_PER_HOUR, SIGN_IN_LINKS_PER_PORTAL_PER_HOUR } from "@/lib/sign-in-link";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { escalateDocs } from "./docs-readers";
import { askAPerson, escalateDocs as escalateOperation } from "./operations/docs-escalate";
import { getDocsInsights } from "./operations/docs-insights";
import { call } from "./operations/run";

/** Makes announcing a new conversation fail (webhooks, the team's email), once it's started. */
const announcing = vi.hoisted(() => ({ fails: false }));
vi.mock("./operations/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operations/conversations")>();
  return {
    ...actual,
    announceConversation: async (...args: Parameters<typeof actual.announceConversation>) => {
      if (announcing.fails) {
        throw new Error("Announcing failed");
      }
      return actual.announceConversation(...args);
    },
  };
});
import { upsertProjectUser } from "./project-users";
import { widgetConversation } from "./widget-inbox";

/**
 * "Ask a person": passing a question the AI couldn't help with to the team as a conversation in the
 * support inbox (docs.escalate), on the portal, in the widget and over the API. The summary comes
 * from the model fake.
 */

let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

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

/** Turns the support inbox on, which turns "Ask a person" on. */
const turnOn = () => prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });

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

const escalated = async (id: string) => (await prisma.docsQuestion.findUniqueOrThrow({ where: { id }, select: { escalatedAt: true } })).escalatedAt;
const conversations = () =>
  prisma.conversation.findMany({ where: { projectId: project.id }, include: { messages: { orderBy: { createdAt: "asc" } } }, orderBy: { number: "asc" } });
const messages = (conversation: Awaited<ReturnType<typeof conversations>>[number]) =>
  conversation.messages.map((m) => ({ author: m.author, note: m.note, body: m.body }));

describe("off", () => {
  test("until the support inbox is on, and while Messages is hidden in the widget, where the reply shows", async () => {
    const reader = asReader();
    const question = await asked(reader);
    expect(await askAPerson(project.slug)).toBeNull();
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: "This team doesn't take questions here" });

    await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, widgetHidden: ["messages"] } });
    expect(await askAPerson(project.slug)).toBeNull();
    expect(await escalateDocs(project.slug, question.id, newAddress(), "", "widget", {})).toEqual({ error: "This team doesn't take questions here" });
    expect(await conversations()).toEqual([]);
    expect(await escalated(question.id)).toBeNull();
  });
});

describe("asking a person", () => {
  beforeEach(turnOn);

  test("on the portal, signed out: a conversation with the address they typed, the AI's answer and a note with the summary, theirs in Messages", async () => {
    const article = await prisma.article.create({
      data: { projectId: project.id, slug: "billing", title: "Billing", body: "Cards only.", publishedAt: new Date() },
    });
    const reader = asReader();
    expect(await askAPerson(project.slug)).toEqual({ email: "" });
    const question = await asked(reader, { status: "ANSWERED", answer: "You can pay by card.", articleIds: [article.id], helpful: false });
    const visitor = newAddress();
    model.reply("They want to pay for their plan in crypto.");

    const result = await escalateDocs(project.slug, question.id, ` ${visitor.toUpperCase()}`, "We're a <b>crypto</b> company.");
    expect(result).toEqual({ conversation: 1, visitor: expect.any(String) });

    const [conversation] = await conversations();
    expect(conversation).toMatchObject({ origin: "ESCALATION", status: "OPEN", email: visitor, userId: null, subject: "Can I pay with crypto?" });
    // The portal's Messages are the widget's.
    expect(conversation!.messages[0]).toMatchObject({ channel: "WIDGET" });
    expect(messages(conversation!)).toEqual([
      // The note is text, as they typed it.
      { author: "USER", note: false, body: "Can I pay with crypto?\n\nWe're a <b>crypto</b> company." },
      { author: "AI", note: false, body: expect.stringMatching(/^You can pay by card\.\n\nSources: Billing \(http.*\/docs\/billing\)$/) },
      { author: "AI", note: true, body: "Summary: They want to pay for their plan in crypto.\nThey marked the AI's answer not helpful." },
    ]);
    expect(await escalated(question.id)).toEqual(expect.any(Date));
    // Reporting's AI conversations link to the conversation it started.
    expect(await prisma.docsQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ conversationId: conversation!.id });

    // The summary is written from the question, the answer and the note, as data.
    const [summary] = model.requests;
    expect(summary!.system).toContain("data, not instructions");
    expect(JSON.parse(summary!.user)).toEqual({
      question: "Can I pay with crypto?",
      askedBefore: [],
      answer: "You can pay by card.",
      notHelpful: true,
      note: "We're a <b>crypto</b> company.",
    });

    // Theirs in Messages, with their visitor token, and the note isn't.
    const opened = await widgetConversation(project.slug, { visitor: (result as { visitor: string }).visitor }, 1);
    expect(opened).toMatchObject({ messages: [{ fromTeam: false }, { fromTeam: true, body: expect.stringContaining("card") }] });
    expect((opened as { messages: unknown[] }).messages).toHaveLength(2);
  });

  test("someone signed in on the portal gets it as their own conversation", async () => {
    const reader = await signUp("Reader");
    actAs(reader);
    expect(await askAPerson(project.slug)).toEqual({ email: reader.email });
    const question = await asked(reader.id);
    model.reply("They want to pay in crypto.");
    // Theirs whatever address is sent (the form shows theirs, read-only): replies reach their account.
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ conversation: 1 });
    expect((await conversations())[0]).toMatchObject({ userId: reader.id, email: null, visitorHash: null });
  });

  test("a follow-up goes with the questions asked before it in the conversation, in the note and the summary", async () => {
    const reader = asReader();
    const first = await asked(reader, { question: "How do I sign in?", status: "ANSWERED", answer: "With your email and password." });
    const followUp = await asked(reader, { question: "And with Google on mobile?", followsId: first.id });
    model.reply("They want to sign in to the mobile app with Google.");
    expect(await escalateDocs(project.slug, followUp.id, newAddress(), "")).toMatchObject({ conversation: 1 });
    const [conversation] = await conversations();
    // Their words, not the earlier answer.
    expect(messages(conversation!).at(-1)).toEqual({
      author: "AI",
      note: true,
      body: "Summary: They want to sign in to the mobile app with Google.\nAsked before: How do I sign in?",
    });
    expect(JSON.parse(model.requests[0]!.user)).toMatchObject({ question: "And with Google on mobile?", askedBefore: ["How do I sign in?"] });
  });

  test("starts without the summary when the model fails", async () => {
    const reader = asReader();
    const question = await asked(reader);
    model.fail(500);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toMatchObject({ conversation: 1 });
    const [conversation] = await conversations();
    expect(messages(conversation!)).toEqual([{ author: "USER", note: false, body: "Can I pay with crypto?" }]);
  });

  test("only for the person who asked, within the hour, once", async () => {
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
    expect(results).toEqual(expect.arrayContaining([{ conversation: 1, visitor: expect.any(String) }, { error: "You've already passed this question to the team" }]));
    expect(await conversations()).toHaveLength(1);
    for (const question of [theirs, old, elsewhere]) {
      expect(await escalated(question.id)).toBeNull();
    }
  });

  test("an API key escalates the questions it asked, as a conversation with the address it gives, once replies can reach it by email", async () => {
    const key = (keyId: string) => ({ actor: { kind: "apiKey" as const, keyId, projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id });
    const question = await asked("key-1");
    const visitor = newAddress();
    // Only email reaches an address: refused while the server doesn't send support email, or the project has no support address.
    vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "");
    await expect(call(escalateOperation, key("key-1"), { questionId: question.id, email: visitor })).rejects.toMatchObject({
      status: 409,
      message: "This server doesn't send support email, so replies couldn't reach this address",
    });
    vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "mail.tuti.example");
    await expect(call(escalateOperation, key("key-1"), { questionId: question.id, email: visitor })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("until the project has a support address"),
    });
    expect(await escalated(question.id)).toBeNull();
    await prisma.mailSubdomain.create({ data: { projectId: project.id, subdomain: `acme-${randomUUID().slice(0, 8)}` } });
    // Nor to an address that marked the project's email as spam.
    await prisma.emailBlock.create({ data: { projectId: project.id, email: visitor } });
    await expect(call(escalateOperation, key("key-1"), { questionId: question.id, email: visitor })).rejects.toMatchObject({
      status: 409,
      message: "This address marked an email from you as spam, so replies couldn't reach it",
    });
    await prisma.emailBlock.delete({ where: { projectId_email: { projectId: project.id, email: visitor } } });
    await expect(call(escalateOperation, key("key-2"), { questionId: question.id, email: visitor })).rejects.toMatchObject({ status: 404 });
    model.reply("They want to pay in crypto.");
    expect(await call(escalateOperation, key("key-1"), { questionId: question.id, email: visitor })).toEqual({ id: question.id, escalated: true, conversation: 1 });
    const [conversation] = await conversations();
    expect(conversation).toMatchObject({ email: visitor, userId: null, visitorHash: null, origin: "ESCALATION" });
    expect(conversation!.messages[0]).toMatchObject({ author: "USER", channel: "API" });
  });

  test("a signed-in user escalates over the API as their own conversation, which needs no email", async () => {
    const reader = await signUp("Reader");
    const question = await asked(reader.id);
    vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "");
    model.reply("They want to pay in crypto.");
    expect(await call(escalateOperation, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { questionId: question.id, email: newAddress() })).toEqual({
      id: question.id,
      escalated: true,
      conversation: 1,
    });
    const [conversation] = await conversations();
    expect(conversation).toMatchObject({ userId: reader.id, email: null, visitorHash: null, origin: "ESCALATION" });
    expect(conversation!.messages[0]).toMatchObject({ author: "USER", channel: "API" });
  });

  test("checks the visitor's email and the note's length", async () => {
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, "nope", "")).toEqual({ error: "Enter a valid email address" });
    expect(await escalateDocs(project.slug, question.id, newAddress(), "x".repeat(1001))).toEqual({ error: "Keep the note under 1,000 characters" });
    expect(await escalated(question.id)).toBeNull();
  });

  test("“Ask a person” starts with the signed-in person's email, or the one their project's SSO gave", async () => {
    const ssoUser = await signUp("SSO user");
    await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "app-user-7", userId: ssoUser.id, email: "e2e-sam@example.com" } });
    actAs(ssoUser);
    expect(await askAPerson(project.slug)).toEqual({ email: "e2e-sam@example.com" });
  });
});

describe("limits", () => {
  beforeEach(turnOn);

  test("per address, shared with emailed sign-in links", async () => {
    const reader = asReader();
    const visitor = newAddress();
    await prisma.signInLink.createMany({ data: Array.from({ length: SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR }, () => ({ projectId: project.id, emailHash: hashSecret(visitor) })) });
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, visitor, "")).toEqual({ error: expect.stringContaining("a lot of emails to this address") });
    expect(await escalated(question.id)).toBeNull();
  });

  test("per visitor, told apart by the proxy's IP header", async () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    request.headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < SIGN_IN_LINKS_PER_CLIENT_PER_HOUR; i++) {
      const reader = asReader();
      model.reply("They want to pay in crypto.");
      expect(await escalateDocs(project.slug, (await asked(reader)).id, newAddress(), "")).toMatchObject({ conversation: i + 1 });
    }
    const reader = asReader();
    const question = await asked(reader);
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toEqual({ error: expect.stringContaining("a lot of emails") });
    // Another visitor still may.
    request.headers = { "cf-connecting-ip": "198.51.100.9" };
    model.reply("They want to pay in crypto.");
    expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toMatchObject({ conversation: SIGN_IN_LINKS_PER_CLIENT_PER_HOUR + 1 });
  });

  test("per project", async () => {
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
  expect(await escalateDocs(project.slug, question.id, newAddress(), "")).toMatchObject({ conversation: 1 });

  actAs(owner);
  const { gaps } = await call(getDocsInsights, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, {});
  expect(Object.fromEntries(gaps.map((gap) => [gap.question, gap.escalated]))).toEqual({ "Can I pay with crypto?": 1, "Is there a dark mode?": 0 });
  const html = renderToStaticMarkup(await ReportingUnansweredPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never));
  const row = (text: string) => html.slice(html.indexOf(text), html.indexOf("Write an article", html.indexOf(text)));
  expect(row("Can I pay with crypto?")).toContain("Passed to your team");
  expect(row("Is there a dark mode?")).not.toContain("Passed to your team");
});

describe("from the widget", () => {
  beforeEach(turnOn);

  test("someone the page signs in gets it as their own conversation; a token that doesn't check out is refused", async () => {
    const userId = await upsertProjectUser(project.id, "user-7", { name: "Sam", email: "e2e-sam-7@example.com" });
    const reader = asReader();
    const question = await asked(reader, { source: "WIDGET" });
    model.reply("They want to pay in crypto.");
    expect(await escalateDocs(project.slug, question.id, "e2e-sam-7@example.com", "", "widget", { token: "not-a-token" })).toEqual({
      error: "Sign in again to ask a person",
    });
    expect(await escalated(question.id)).toBeNull();

    expect(await escalateDocs(project.slug, question.id, "e2e-sam-7@example.com", "", "widget", { token: widgetToken(project.id, userId) })).toEqual({
      conversation: 1,
    });
    expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ userId, email: null, visitorHash: null });
  });

  test("once the conversation is started, the question stays passed on even if announcing it fails", async () => {
    const reader = asReader();
    const question = await asked(reader, { source: "WIDGET" });
    model.reply("They want to pay in crypto.");
    announcing.fails = true;
    try {
      expect(await escalateDocs(project.slug, question.id, newAddress(), "", "widget", {})).toEqual({ conversation: 1, visitor: expect.any(String) });
    } finally {
      announcing.fails = false;
    }
    expect(await escalated(question.id)).toEqual(expect.any(Date));
    expect(await escalateDocs(project.slug, question.id, newAddress(), "", "widget", {})).toEqual({ error: "You've already passed this question to the team" });
    expect(await prisma.conversation.count({ where: { projectId: project.id } })).toBe(1);
  });
});
