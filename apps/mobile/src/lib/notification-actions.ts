import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";

import { ApiError, createApi } from "./api";
import { sendReply, type Unsent, updateDraft } from "./conversation";
import { screenKey, updateConversation } from "./details";
import { CHANNEL, isTheirs, type Target, targetOf } from "./notifications";
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

/** The category's actions, set at every start: the system keeps them, and an update may change them. */
export const setCategory = () =>
  Notifications.setNotificationCategoryAsync(CATEGORY, [
    { identifier: REPLY, buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Reply" }, options: OPTIONS },
    { identifier: CLOSE, buttonTitle: "Close", options: OPTIONS },
  ]);

/** Responses acted on in this JavaScript: the listener and the last response can both tell of one. */
const done = new Set<string>();

/** What the failure notification says, in the server's words where it gave them. */
const reasonOf = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.");

/** Why an action wasn't taken, said in the notification left in its place. */
export const SIGNED_OUT = "You're signed out of Tuti.";
export const NOT_YOURS = "It's in a project you're not on.";

/**
 * Acts on a Reply or Close: as the signed-in teammate, in the notification's project when it's one of theirs. Done, the
 * notification goes. Not done, it goes too (Android would keep a reply's spinner), and one in its place says why and
 * opens the conversation, so nothing typed is lost unsaid: a reply that failed to send is kept there, as one that didn't
 * send, with Retry. Signed out, or in a project that isn't theirs, nothing is sent or kept: only why.
 */
export async function act(response: Notifications.NotificationResponse) {
  const { actionIdentifier: action } = response;
  const { identifier, content } = response.notification.request;
  const target = targetOf(content.data);
  const text = response.userText?.trim() ?? "";
  const key = `${identifier}\n${action}\n${text}`;
  if ((action !== REPLY && action !== CLOSE) || !target || (action === REPLY && !text) || done.has(key)) {
    return;
  }
  done.add(key);
  const session = await readSession();
  // The reply, made before anything that can fail, so a failure keeps it. Its id is made from the notification and the
  // text: the same reply sent again is the one already saved, never a second.
  let unsent: Unsent | undefined;
  let refused: string | null = null;
  try {
    if (!session) {
      refused = SIGNED_OUT;
    } else {
      const projects = () =>
        createApi({ server: session.server, token: session.token }, () => {})<{ projects: { slug: string }[] }>("/projects").then((answer) => answer.projects.map((p) => p.slug));
      if (action === REPLY) {
        const id = `notification-${(await digestStringAsync(CryptoDigestAlgorithm.SHA256, `${identifier}\n${text}`)).slice(0, 40)}`;
        unsent = { id, body: text, note: false, close: false, files: [], seen: null };
      }
      if (!(await isTheirs(target, session, projects))) {
        refused = NOT_YOURS;
      } else {
        const api = createApi({ ...session, project: target.project }, () => {});
        await (unsent ? sendReply(api, target.number, unsent) : updateConversation(api, target.number, { status: "closed" }));
        await Notifications.dismissNotificationAsync(identifier).catch(() => {});
        return;
      }
    }
  } catch (error) {
    const kept = unsent;
    if (session && kept) {
      updateDraft(screenKey({ server: session.server, project: target.project }, target.number), (draft) =>
        draft.unsent.some((one) => one.id === kept.id) ? draft : { ...draft, unsent: [...draft.unsent, { ...kept, error: reasonOf(error) }] },
      );
    }
    await tell(identifier, action, content.title, target, reasonOf(error), !!kept);
    return;
  }
  await tell(identifier, action, content.title, target, refused, false);
}

/** Takes the notification acted on away, and leaves one saying why it wasn't done. */
async function tell(identifier: string, action: string, title: string | null, target: Target, reason: string, kept: boolean) {
  await Notifications.dismissNotificationAsync(identifier).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    content: { ...failure(action, title, reason, kept), data: { project: target.project, conversation: target.number } },
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
      // Also told of every push received: only an action is for this.
      if (data && "actionIdentifier" in data) {
        await act(data).catch(() => {});
      }
    });
    void Notifications.registerTaskAsync(TASK).catch(() => {});
  }
  Notifications.addNotificationResponseReceivedListener(heard);
  return heard(Notifications.getLastNotificationResponse());
}
