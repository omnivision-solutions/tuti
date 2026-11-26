import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";

import { ApiError, createApi, fetchUntil } from "./api";
import { draftsGeneration, sendReply, trackSend, type Unsent, updateDraft } from "./conversation";
import { screenKey, updateConversation } from "./details";
import { CHANNEL, forThisSignIn, isTheirs, type Target, targetOf } from "./notifications";
import { readSession } from "./session-store";

/**
 * Reply and Close on a notification itself (docs/plan.md, Mobile app, M8): the server's pushes name the `conversation`
 * category (packages/jobs push.ts), whose two actions act without opening the app, each only on an unlocked phone (iOS
 * here; Android through the patch in patches/expo-notifications.patch).
 *
 * How an action reaches this code: iOS wakes the app (or launches it in the background, when it was killed) and tells
 * the response listener, or keeps it as the last response for a launch that wasn't listening yet. Android tells the
 * listener only while the app is in front; otherwise it runs the background task, in a JavaScript of its own when the app
 * was killed. Each response is acted on once here, and a reply sent twice (by two of these) is one reply on the server:
 * its `requestId` is made from the notification and the text.
 */

export const CATEGORY = "conversation";
export const REPLY = "reply";
export const CLOSE = "close";
const TASK = "notification-action";

const OPTIONS = { opensAppToForeground: false, isAuthenticationRequired: true };

/**
 * The category's actions, set at every start: the system keeps them, and an update may change them. Close not before
 * Android 12, which has no unlock requirement for an action: it'd close a conversation from a locked phone (a reply
 * there asks to unlock before it's typed). It stays in the app.
 */
export const setCategory = () =>
  Notifications.setNotificationCategoryAsync(CATEGORY, [
    { identifier: REPLY, buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Reply" }, options: OPTIONS },
    ...(Platform.OS === "android" && Number(Platform.Version) < 31 ? [] : [{ identifier: CLOSE, buttonTitle: "Close", options: OPTIONS }]),
  ]);

/** Responses acted on in this JavaScript: the listener and the last response can both tell of one. */
const done = new Set<string>();

/**
 * How long an action's requests (`/projects`, then the reply or close) wait for their answers, all together, bodies
 * included: a phone can leave one hanging for minutes (a network that went and came back), which would say nothing at
 * all. Counted from when the JavaScript starts acting, which a cold launch delays, so well within the 25 seconds iOS keeps
 * the app running from the tap (patches/expo-notifications.patch): what's left is for the app to start and to say that
 * the action didn't go. A reply whose answer this gave up on may have been saved: its `requestId` makes Retry give back
 * the one saved, not a second.
 */
export const ACTION_TIMEOUT_MS = 12_000;

/** What the failure notification says, in the server's words where it gave them. */
const reasonOf = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.");

/** Why an action wasn't taken, said in the notification left in its place. */
export const SIGNED_OUT = "You're signed out of Tuti.";
export const NOT_YOURS = "It's in a project you're not on.";
export const SIGNED_OUT_SINCE = "It's for an account you've since signed out of.";

/**
 * The response as the last one the system keeps, forgotten once it's taken: a later start of the app's JavaScript (a
 * reload, a launch) would otherwise act on it again. Only if it's still this one: a newer one is left for its start.
 */
function forget({ actionIdentifier, userText, notification }: Notifications.NotificationResponse) {
  const last = Notifications.getLastNotificationResponse();
  if (last?.actionIdentifier === actionIdentifier && last.userText === userText && last.notification.request.identifier === notification.request.identifier) {
    Notifications.clearLastNotificationResponse();
  }
}

/**
 * Acts on a Reply or Close: as the signed-in teammate, in the notification's project when it's one of theirs, when it
 * was pushed to this sign-in (`forThisSignIn`). Done, the notification goes. Not done, it goes too (Android would keep a reply's spinner), and one in its place
 * says why and opens the conversation, so nothing typed is lost unsaid. A reply is in the conversation's draft, as one
 * being sent, from before it's sent until it's saved (the app's process can end meanwhile), and stays there with Retry
 * when it fails; signed out, for a sign-in since left, or in a project that isn't theirs, nothing is sent or kept: only why.
 */
export async function act(response: Notifications.NotificationResponse) {
  const { actionIdentifier: action } = response;
  const { identifier, content } = response.notification.request;
  const data = dataOf(content);
  const target = targetOf(data);
  const text = response.userText?.trim() ?? "";
  const key = `${identifier}\n${action}\n${text}`;
  if ((action !== REPLY && action !== CLOSE) || !target || done.has(key)) {
    return;
  }
  done.add(key);
  // The stored response is cleared so a later start doesn't act on it again: a Close's first (repeated, it could close a
  // conversation reopened meanwhile), a Reply's once its text is in the draft (repeated, it's the same reply, `requestId`).
  if (action === CLOSE) {
    forget(response);
  }
  const timedFetch = fetchUntil(Date.now() + ACTION_TIMEOUT_MS);
  // A reply of only spaces: nothing to send, but the notification goes, or Android shows it sending for good.
  if (action === REPLY && !text) {
    forget(response);
    await remove(response);
    return;
  }
  // Drafts changed only in this sign-in's generation, and only while it's still this session: a sign-out (here, or in
  // the app's other JavaScript, which has generations of its own) while the send is on its way keeps nothing of it.
  const since = draftsGeneration();
  const session = await readSession();
  if (!session || !(await forThisSignIn(target))) {
    forget(response);
    await tell(response, target, session ? SIGNED_OUT_SINCE : SIGNED_OUT, false);
    return;
  }
  const draftKey = screenKey({ server: session.server, project: target.project }, target.number);
  const change = async (change: (all: Unsent[]) => Unsent[]) => {
    if ((await readSession())?.token !== session.token || since !== draftsGeneration()) {
      return false;
    }
    updateDraft(draftKey, (draft) => {
      const all = change(draft.unsent);
      return all === draft.unsent ? draft : { ...draft, unsent: all };
    }, since);
    return true;
  };
  const drop = (id: string) => change((all) => (all.some((one) => one.id === id) ? all.filter((one) => one.id !== id) : all));
  const projects = () =>
    createApi({ server: session.server, token: session.token }, () => {}, timedFetch)<{ projects: { slug: string }[] }>("/projects").then((answer) => answer.projects.map((p) => p.slug));
  // Its id is made from the notification and the text: the same reply sent again is the one already saved, never a second.
  let unsent: Unsent | undefined;
  // Ends the reply's "Sending…" with how it went (`trackSend`): a Retry tapped meanwhile hears that it didn't go.
  let settle: ((sent: boolean) => void) | undefined;
  try {
    if (action === REPLY) {
      const id = `notification-${(await digestStringAsync(CryptoDigestAlgorithm.SHA256, `${identifier}\n${text}`)).slice(0, 40)}`;
      const made: Unsent = { id, body: text, note: false, close: false, files: [], seen: seenOf(data) };
      unsent = made;
      trackSend(id, new Promise<void>((resolve, reject) => (settle = (sent) => (sent ? resolve() : reject(new Error("Not sent"))))));
      await change((all) => (all.some((one) => one.id === made.id) ? all : [...all, made]));
      forget(response);
    }
    try {
      if (!(await isTheirs(target, session, projects))) {
        if (unsent) {
          settle?.(false);
          await drop(unsent.id);
        }
        await tell(response, target, NOT_YOURS, false);
        return;
      }
      const api = createApi({ ...session, project: target.project }, () => {}, timedFetch);
      await (unsent ? sendReply(api, target.number, unsent) : updateConversation(api, target.number, { status: "closed" }));
      // No longer sending, before the draft says what happened.
      settle?.(true);
    } catch (error) {
      settle?.(false);
      throw error;
    }
    if (unsent) {
      await drop(unsent.id);
    }
    await remove(response);
  } catch (error) {
    forget(response);
    // Kept only while it's still this session (`change`); not after a 401: the session's over, and the next launch
    // forgets its drafts.
    const ended = error instanceof ApiError && error.status === 401;
    const failed = unsent;
    const kept = !!failed && !ended && (await change((all) => all.map((one) => (one.id === failed.id ? { ...one, error: reasonOf(error) } : one))));
    if (failed && !kept) {
      await drop(failed.id);
    }
    await tell(response, target, ended ? SIGNED_OUT : reasonOf(error), kept);
  }
}

/**
 * A push received on Android, as the task is given it: the server's are data only (packages/jobs push.ts), its `data`
 * in `data.body` as JSON with the notification's `title` and `text`, and shown here with the category's Reply and Close
 * (Firebase shows a push with a title itself while the app isn't in front, without them). Only for this sign-in: a push
 * a sign-out that didn't reach the server left coming shows nothing.
 */
export async function present(payload: unknown) {
  const { data: raw, messageId } = (payload ?? {}) as { data?: { body?: unknown } | null; messageId?: unknown };
  let data: { title?: unknown; text?: unknown };
  try {
    data = JSON.parse(String(raw?.body)) as typeof data;
  } catch {
    return;
  }
  const target = targetOf(data);
  const title = typeof data.title === "string" ? data.title : null;
  const session = title && target ? await readSession() : null;
  // Only for this sign-in, which the notification keeps saying for its actions.
  if (!target || !title || !session || !(await forThisSignIn(target))) {
    return;
  }
  const at = seenOf(data);
  await Notifications.scheduleNotificationAsync({
    // Firebase's id for the push: the same push shown again replaces it.
    ...(typeof messageId === "string" && { identifier: messageId }),
    content: {
      title,
      ...(typeof data.text === "string" && { body: data.text }),
      data: { project: target.project, conversation: target.number, ...(at && { at }), ...(target.device && { device: target.device }) },
      categoryIdentifier: CATEGORY,
      sound: "default",
    },
    trigger: { channelId: CHANNEL },
  });
}

/**
 * A notification's data. Android's task is given the response as it comes from the system, the data still as JSON in
 * `dataString` (the listener's has it read into `data`).
 */
export function dataOf(content: Notifications.NotificationContent): Record<string, unknown> | undefined {
  const { dataString } = content as { dataString?: unknown };
  if (content.data == null && typeof dataString === "string") {
    try {
      return JSON.parse(dataString) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return content.data ?? undefined;
}

/** What the notification's message was sent at (the push's `at`), as the reply's `seen`; null from a server without it. */
export function seenOf(data: unknown) {
  const at = (data as { at?: unknown } | null)?.at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * Takes the notification acted on away. Android keeps one whose reply is still sending (its spinner) for the reply's
 * history, even once it's cancelled, until the app updates it: a silent update, without the buttons, ends that. Expo
 * posts it off the caller's thread, so it's waited for (`sent` in its data) before the cancel, which it would otherwise
 * outlive, and the system's taking the spinner off after it is too.
 */
async function remove({ actionIdentifier, notification }: Notifications.NotificationResponse) {
  const { identifier, content } = notification.request;
  if (Platform.OS === "android" && actionIdentifier === REPLY) {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title: content.title, body: content.body, data: { ...dataOf(content), sent: true }, sound: false },
      trigger: { channelId: CHANNEL },
    }).catch(() => {});
    // ponytail: the update polled for up to 3 seconds, then a fixed 1.5 seconds for the system to redraw it (300 ms
    // wasn't enough on an Android 13 emulator, 1.5 seconds was). Past those, the update stays until it's swiped away.
    for (let tries = 0; tries < 20; tries++) {
      await wait(150);
      const shown = (await Notifications.getPresentedNotificationsAsync().catch(() => [])).find((one) => one.request.identifier === identifier);
      // The update itself, not the original's absence: one already swiped away says nothing of the update posted.
      if (shown && dataOf(shown.request.content)?.sent) {
        break;
      }
    }
    await wait(SPINNER_OFF_MS);
  }
  await Notifications.dismissNotificationAsync(identifier).catch(() => {});
}
const SPINNER_OFF_MS = 1500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Takes the notification acted on away, and leaves one saying why it wasn't done. */
async function tell(response: Notifications.NotificationResponse, target: Target, reason: string, kept: boolean) {
  await remove(response);
  await Notifications.scheduleNotificationAsync({
    // With its registration's id: tapped, it opens the conversation only while that's still this sign-in (openTarget).
    content: {
      ...failure(response.actionIdentifier, response.notification.request.content.title, reason, kept),
      // `failed`: always shown, also over its conversation or signed out (notifications.ts `behaviourFor`).
      data: { project: target.project, conversation: target.number, ...(target.device && { device: target.device }), failed: true },
    },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL } : null,
  });
}

/** The notification left when an action didn't go: tapped, it opens the conversation. */
export function failure(action: string, title: string | null, reason: string, kept: boolean) {
  const about = title ? `${title}: ` : "";
  return action === REPLY
    ? { title: "Your reply didn't send", body: `${about}${reason}${kept ? " It's kept in the conversation, with Retry." : ""}` }
    : { title: "Couldn't close the conversation", body: `${about}${reason}` };
}

/** Acts on a response, on Android only while the app is in front: otherwise its background task does. Done when it is. */
const heard = (response: Notifications.NotificationResponse | null) =>
  response && (Platform.OS === "ios" || AppState.currentState === "active") ? act(response).catch(() => {}) : Promise.resolve();

/** At every start of the app's JavaScript (index.ts), Android's background one too. Done when the last response is acted on. */
export function startNotificationActions() {
  void setCategory().catch(() => {});
  if (Platform.OS === "android") {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
      // An action, or a push received (in front too).
      if (data && "actionIdentifier" in data) {
        await act(data).catch(() => {});
      } else {
        await present(data).catch(() => {});
      }
    });
    void Notifications.registerTaskAsync(TASK).catch(() => {});
  }
  Notifications.addNotificationResponseReceivedListener(heard);
  return heard(Notifications.getLastNotificationResponse());
}
