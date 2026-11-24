import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";

import { teamToTell, whoWrote } from "./conversations";
import type { JobLogger, JobResult } from "./index";

/**
 * Push notifications to the mobile app (docs/plan.md, Mobile app), through Expo's push service: any server can send to
 * the app without an account, so a self-hosted one needs no setup. `EXPO_ACCESS_TOKEN`, if set, goes with every request
 * (Expo's "enhanced security", for an app whose Expo project turned it on); `EXPO_PUSH_URL` is for tests' fake.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push";

/** Expo takes up to 100 messages a request, and receipts for up to 1,000 tickets. */
const MESSAGES_PER_REQUEST = 100;
const RECEIPTS_PER_REQUEST = 1000;
/** Expo's advice: read a push's receipt 15 minutes on. It keeps them a day. */
export const RECEIPT_AFTER_MS = 15 * 60 * 1000;
const RECEIPTS_KEPT_MS = 24 * 60 * 60 * 1000;
/** How much of the message a notification shows; the phone cuts it shorter still. */
export const PUSH_TEXT_MAX = 200;

/** Expo's answer for a token that's no longer the app's on its device (signed out of the store account, uninstalled). */
const GONE = "DeviceNotRegistered";

type Outcome = { status: "ok"; id: string } | { status: "error"; message?: string; details?: { error?: string } };
const isGone = (outcome: Outcome | undefined) => outcome?.status === "error" && outcome.details?.error === GONE;

async function expo<T>(path: "send" | "getReceipts", body: unknown): Promise<T> {
  const token = process.env.EXPO_ACCESS_TOKEN;
  const response = await fetch(`${process.env.EXPO_PUSH_URL || EXPO_PUSH_URL}/${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Expo's push service answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/** A message's text as a notification shows it: on one line, cut at PUSH_TEXT_MAX. */
export function pushText(body: string) {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > PUSH_TEXT_MAX ? `${text.slice(0, PUSH_TEXT_MAX - 1).trimEnd()}…` : text;
}

/**
 * A user wrote in the support inbox: a notification on the phones of exactly the team members its email is for
 * (teamToTell), every message (the email waits NOTIFY_EVERY_MS between them; a phone is for answering as they come).
 * A device counts while the session it was registered under lasts. Its text unless the teammate turned "Show message
 * text" off; the data opens the conversation in the app.
 */
export async function conversationPush({ messageId }: JobInput<"conversationPush">, log: JobLogger): Promise<JobResult> {
  const message = await prisma.conversationMessage.findUnique({
    where: { id: messageId },
    select: {
      author: true,
      body: true,
      fromAddress: true,
      conversation: {
        select: {
          projectId: true,
          number: true,
          spam: true,
          email: true,
          name: true,
          assigneeId: true,
          user: { select: { name: true } },
          project: { select: { slug: true, name: true } },
        },
      },
    },
  });
  const conversation = message?.conversation;
  if (!message || !conversation || message.author !== "USER" || conversation.spam) {
    return { skipped: "nothing to tell" };
  }
  const told = await prisma.device.findMany({
    where: { user: { teamMemberships: { some: teamToTell(conversation) } }, session: { expiresAt: { gt: new Date() } } },
    select: { id: true, token: true, user: { select: { pushShowsText: true } } },
  });
  // A token goes to the account that registered it last, across everyone's: a phone someone signed out of offline (their
  // session and row left on the server) and then signed in to as someone else is told only the latter's. It registers
  // again each time the app opens, so this is the one it's on. Once a token, too. The cost: someone who had another's token
  // (Expo's, never shown by Tuti) and registered it would mute that phone until its app opens again; a phone showing a
  // previous account's messages is worse.
  const latest = new Set(
    (
      await prisma.device.findMany({
        where: { token: { in: told.map((device) => device.token) } },
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
        distinct: ["token"],
        select: { id: true },
      })
    ).map((device) => device.id),
  );
  const devices = told.filter((device) => latest.has(device.id));
  if (devices.length === 0) {
    return { skipped: "no devices" };
  }
  const title = `${whoWrote(message, conversation)} · ${conversation.project.name}`;
  const text = pushText(message.body);
  const messages = devices.map((device) => ({
    to: device.token,
    title,
    ...(device.user.pushShowsText && text && { body: text }),
    sound: "default",
    priority: "high",
    data: { project: conversation.project.slug, conversation: conversation.number },
  }));
  let sent = 0;
  let gone = 0;
  // ponytail: a request that fails after earlier ones went through retries them all (a second notification for those
  // phones); only for a team with over 100 phones on one message. What's saved after a send never fails the job, so it
  // isn't sent again.
  for (let i = 0; i < messages.length; i += MESSAGES_PER_REQUEST) {
    const batch = messages.slice(i, i + MESSAGES_PER_REQUEST);
    // Before the send: what Expo answers is about the registrations as they were then, so a phone that registers again
    // while the request or its receipt is pending isn't dropped for it.
    const sentAt = new Date();
    const { data } = await expo<{ data: Outcome[] }>("send", batch);
    const tickets = batch.flatMap((m, j) => (data[j]?.status === "ok" ? [{ id: (data[j] as { id: string }).id, token: m.to, createdAt: sentAt }] : []));
    const unregistered = batch.filter((_, j) => isGone(data[j])).map((m) => m.to);
    const failed = batch.length - tickets.length - unregistered.length;
    if (failed > 0) {
      log.warn(`Expo refused ${failed} of ${batch.length} pushes about conversation #${conversation.number}: ${JSON.stringify(data.find((d) => d.status === "error")).slice(0, 300)}`);
    }
    try {
      await prisma.pushTicket.createMany({ data: tickets, skipDuplicates: true });
      await prisma.device.deleteMany({ where: { token: { in: unregistered }, lastSeenAt: { lte: sentAt } } });
    } catch (error) {
      // Lost: their receipts aren't read, and a token Expo no longer has is dropped by a later push.
      log.warn(`Couldn't save the pushes about conversation #${conversation.number}: ${String(error)}`);
    }
    sent += tickets.length;
    gone += unregistered.length;
  }
  return { pushed: sent, ...(gone > 0 && { unregistered: gone }) };
}

/**
 * Expo's receipts for the pushes it took 15 minutes ago or more: a token Expo says is no longer registered loses its
 * devices registered before the push. A ticket goes once its receipt is read; one with none yet is asked about again next time, until receipts are
 * gone (a day on).
 */
export async function checkPushReceipts(_: JobInput<"checkPushReceipts">, log: JobLogger, now = new Date()): Promise<JobResult> {
  await prisma.pushTicket.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - RECEIPTS_KEPT_MS) } } });
  let read = 0;
  let gone = 0;
  let after = "";
  for (;;) {
    const tickets = await prisma.pushTicket.findMany({
      where: { createdAt: { lte: new Date(now.getTime() - RECEIPT_AFTER_MS) }, id: { gt: after } },
      orderBy: { id: "asc" },
      take: RECEIPTS_PER_REQUEST,
      select: { id: true, token: true, createdAt: true },
    });
    if (tickets.length === 0) {
      break;
    }
    after = tickets.at(-1)!.id;
    const { data } = await expo<{ data?: Record<string, Outcome> }>("getReceipts", { ids: tickets.map((ticket) => ticket.id) });
    const answered = tickets.filter((ticket) => data?.[ticket.id]);
    const unregistered = answered.filter((ticket) => isGone(data![ticket.id]));
    const failed = answered.filter((ticket) => data![ticket.id]!.status === "error").length - unregistered.length;
    if (failed > 0) {
      log.warn(`${failed} pushes didn't reach their phones: ${JSON.stringify(Object.values(data!).find((r) => r.status === "error" && r.details?.error !== GONE)).slice(0, 300)}`);
    }
    // Only a device registered before the push: one registered again since has a token Expo may have taken back.
    if (unregistered.length > 0) {
      await prisma.device.deleteMany({ where: { OR: unregistered.map((ticket) => ({ token: ticket.token, lastSeenAt: { lte: ticket.createdAt } })) } });
    }
    await prisma.pushTicket.deleteMany({ where: { id: { in: answered.map((ticket) => ticket.id) } } });
    read += answered.length;
    gone += unregistered.length;
  }
  return { read, unregistered: gone };
}
