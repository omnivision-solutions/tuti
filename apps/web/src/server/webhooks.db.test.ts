import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startWebhookReceiver, type WebhookReceiver } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { changePostStatus } from "./manage-posts";
import { addComment, createPost } from "./posts";
import { createWebhook, deleteWebhook, sendTestWebhook } from "./webhooks";

/** A receiver like a customer's (see @tuti/testkit). */
let receiver: WebhookReceiver;
let received: WebhookReceiver["received"];
let receiverUrl: string;

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  receiver = await startWebhookReceiver();
  receiverUrl = receiver.url;
});
afterAll(() => receiver.close());

beforeEach(async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  receiver.received.length = 0;
  received = receiver.received;
  receiver.status = 200;
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

/** Checks a delivery's signature the way the docs tell receivers to. */
function verify(delivery: { headers: IncomingHttpHeaders; body: string }, secret: string) {
  const { t, v1 } = Object.fromEntries(String(delivery.headers["tuti-signature"]).split(",").map((p) => p.split("=")));
  return createHmac("sha256", secret).update(`${t}.${delivery.body}`).digest("hex") === v1;
}

async function post(title = "Dark mode") {
  const form = new FormData();
  form.set("projectSlug", project.slug);
  form.set("boardSlug", "feature-requests");
  form.set("title", title);
  expect(await createPost({}, form)).toEqual({});
  return prisma.post.findFirstOrThrow({ where: { projectId: project.id, title } });
}

describe("deliveries", () => {
  test("a new post reaches the webhook, signed, with a stable event id", async () => {
    const { secret } = await createWebhook(project.slug, receiverUrl, ["post.created"]);
    expect(secret).toMatch(/^whsec_/);
    await post();

    expect(received).toHaveLength(1);
    const [delivery] = received;
    expect(verify(delivery!, secret!)).toBe(true);
    expect(verify(delivery!, "whsec_wrong")).toBe(false);
    const body = JSON.parse(delivery!.body);
    expect(body).toMatchObject({
      type: "post.created",
      project: { slug: project.slug },
      data: { number: 1, title: "Dark mode", status: "open", votes: 1 },
    });
    expect(delivery!.headers).toMatchObject({ "tuti-event-id": body.id, "tuti-event-type": "post.created" });
    expect(body.id).toMatch(/^evt_/);
  });

  test("status changes (only real ones) and comments, each to the webhooks that want them", async () => {
    await createWebhook(project.slug, receiverUrl, ["post.status_changed"]);
    await createWebhook(project.slug, `${receiverUrl}?comments`, ["comment.created"]);
    const dark = await post();
    expect(received).toEqual([]); // nobody wants post.created

    await changePostStatus(project.slug, dark.id, "PLANNED");
    await changePostStatus(project.slug, dark.id, "PLANNED"); // no change, no event
    const form = new FormData();
    form.set("postId", dark.id);
    form.set("body", "On it");
    await addComment({}, form);

    const events = received.map((r) => JSON.parse(r.body));
    expect(events).toEqual([
      expect.objectContaining({
        type: "post.status_changed",
        data: { post: expect.objectContaining({ number: 1, status: "planned" }), previousStatus: "open" },
      }),
      expect.objectContaining({
        type: "comment.created",
        data: { post: expect.objectContaining({ number: 1 }), comment: expect.objectContaining({ body: "On it" }) },
      }),
    ]);
  });

  test("a failing endpoint doesn't fail the post; the retry sends the same event id", async () => {
    await createWebhook(project.slug, receiverUrl, ["post.created"]);
    receiver.status = 500;
    await post();
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhook: { projectId: project.id } } });
    expect(delivery).toMatchObject({ attempts: 1, lastStatus: 500, lastError: "Answered 500", deliveredAt: null });

    receiver.status = 200;
    await handlers.webhookDelivery({ deliveryId: delivery.id }, { info: () => {}, warn: () => {} });
    expect(received.map((r) => r.headers["tuti-event-id"])).toEqual([delivery.eventId, delivery.eventId]);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      attempts: 2,
      lastStatus: 200,
      deliveredAt: expect.any(Date),
    });
  });

  test("redirects aren't followed", async () => {
    await createWebhook(project.slug, receiverUrl, ["post.created"]);
    receiver.status = 302;
    await post();
    expect(received).toHaveLength(1);
    expect(await prisma.webhookDelivery.findFirstOrThrow({ where: { webhook: { projectId: project.id } } })).toMatchObject({
      lastStatus: 302,
      deliveredAt: null,
    });
  });

  test("a test event, and nothing more once the webhook is deleted", async () => {
    await createWebhook(project.slug, receiverUrl, ["post.created"]);
    const webhook = await prisma.webhook.findFirstOrThrow({ where: { projectId: project.id } });
    expect(await sendTestWebhook(project.slug, webhook.id)).toEqual({});
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: "ping", data: { message: "Hello from Tuti" } });

    expect(await deleteWebhook(project.slug, webhook.id)).toEqual({});
    await post();
    expect(received).toHaveLength(1);
  });
});

describe("settings", () => {
  test("endpoints must be valid, public HTTPS URLs, with at least one event", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
    expect(await createWebhook(project.slug, "http://example.com/hook", ["post.created"])).toEqual({
      error: "Webhook URLs must start with https://",
    });
    expect(await createWebhook(project.slug, "https://169.254.169.254/", ["post.created"])).toEqual({
      error: "Webhook URLs must point to a public address",
    });
    expect(await createWebhook(project.slug, "https://93.184.215.14/hook", [])).toEqual({ error: "Pick at least one event" });
    expect(await createWebhook(project.slug, "https://93.184.215.14/hook", ["post.deleted"])).toMatchObject({
      error: expect.any(String),
    });
    expect(await prisma.webhook.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("an endpoint that turns private later is refused at delivery", async () => {
    await createWebhook(project.slug, receiverUrl, ["post.created"]);
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
    await post();
    expect(received).toEqual([]);
    expect(await prisma.webhookDelivery.findFirstOrThrow({ where: { webhook: { projectId: project.id } } })).toMatchObject({
      lastStatus: null,
      lastError: "Webhook URLs must start with https://",
    });
  });
});

test("deliveries whose job never started are queued again, so none is lost", async () => {
  await createWebhook(project.slug, receiverUrl, ["post.created"]);
  const webhook = await prisma.webhook.findFirstOrThrow({ where: { projectId: project.id } });
  const minutes = (n: number) => new Date(Date.now() - n * 60_000);
  const delivery = (eventId: string, createdAt: Date, attempts = 0) =>
    prisma.webhookDelivery.create({
      data: { webhookId: webhook.id, eventId, event: "post.created", payload: { id: eventId }, createdAt, attempts },
    });
  // Queueing failed 10 minutes ago; one is just being queued; one was already tried; one is two days old.
  await delivery("evt_lost", minutes(10));
  await delivery("evt_new", minutes(1));
  await delivery("evt_tried", minutes(10), 1);
  await delivery("evt_old", minutes(48 * 60));

  const log = { info: () => {}, warn: () => {} };
  expect(await handlers.resubmitWebhookDeliveries({}, log)).toEqual({ found: 1, queued: 1 });
  expect(received.map((r) => r.headers["tuti-event-id"])).toEqual(["evt_lost"]);
  expect(await handlers.resubmitWebhookDeliveries({}, log)).toEqual({ found: 0, queued: 0 });
});
