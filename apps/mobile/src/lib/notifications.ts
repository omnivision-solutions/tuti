import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import { AndroidImportance, IosAuthorizationStatus } from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import { type Api, ApiError } from "./api";
import type { Session } from "./session-store";
import { STORE_OPTIONS } from "./sign-in";

/**
 * Notifications on the phone (docs/plan.md, Mobile app, M8): the server pushes a user's message to the devices its
 * teammate registered (`devices.register`), with `data: { project: <slug>, conversation: <number> }`
 * (packages/jobs/src/push.ts). Asked for once the Inbox shows, never at launch; a tap opens the conversation.
 */

type Platform = "ios" | "android";

const DEVICE_ID = "device-id";
/** Asked already, in a file rather than the keychain: iOS forgets the permission on reinstalling, and so does this. */
const asked = () => new File(Paths.document, "notifications-asked");
/** The channel the server's pushes name (packages/jobs push.ts): unnamed, they'd go to Expo's own "Miscellaneous". */
const CHANNEL = "default";

/**
 * This install's id, kept on the phone, so registering again replaces its row rather than adding one. A new one with
 * each sign-out (removeDevice).
 */
let keptId: Promise<string> | null = null;
export function deviceId() {
  keptId ??= SecureStore.getItemAsync(DEVICE_ID, STORE_OPTIONS).then(async (kept) => {
    if (kept) {
      return kept;
    }
    const made = randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID, made, STORE_OPTIONS);
    return made;
  });
  // A read or write that failed is tried again next time.
  keptId.catch(() => (keptId = null));
  return keptId;
}

/** Whether the system shows Tuti's notifications, and whether it would still ask (rather than only its settings can change it). */
export async function permission() {
  const now = await Notifications.getPermissionsAsync();
  const allowed = now.granted || now.ios?.status === IosAuthorizationStatus.PROVISIONAL;
  return { allowed, canAsk: !allowed && now.canAskAgain };
}

/** Android shows nothing without a channel, and from Android 13 doesn't ask until there is one. */
export const ensureChannel = (platform: Platform) =>
  platform === "android"
    ? Notifications.setNotificationChannelAsync(CHANNEL, { name: "Messages", importance: AndroidImportance.HIGH }).then(() => {})
    : Promise.resolve();

/** The system's prompt: whether they're allowed now. */
export async function askPermission(platform: Platform) {
  await ensureChannel(platform);
  await Notifications.requestPermissionsAsync();
  return (await permission()).allowed;
}

/**
 * Whether to explain notifications and ask now, as the signed-in Inbox first shows: only once on this phone, whatever
 * the answer, and only while the system would still ask. Once is marked before anything shows: a phone where it can't be
 * kept is never asked, rather than asked on every launch.
 */
export async function shouldOffer() {
  try {
    const file = asked();
    if (file.exists) {
      return false;
    }
    file.writeSync("1");
    const now = await Notifications.getPermissionsAsync();
    // Not the status: Android calls a permission it never asked for "denied", with canAskAgain.
    return !now.granted && now.canAskAgain;
  } catch {
    return false;
  }
}

/** The Expo project pushes come through: a build without one (a fork's, before it has an EAS project) gets no token. */
const projectId = () => (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ?? Constants.easConfig?.projectId;

/** The session and Expo token last registered (or being registered): the same pair isn't sent twice. */
let registered: string | null = null;
/** Whether this phone is registered (or being registered) for the session: cleared when a registration fails. */
export const registeredFor = (session: { token: string }) => !!registered?.startsWith(`${session.token}\n`);
/** Moves on with each registration and removal: a removal's late failure leaves a registration started since alone. */
let turn = 0;

/**
 * Registers this phone for the session's teammate (`devices.register`), if notifications are allowed. `devicePushToken`:
 * the new one the system just gave (fetching it again would fire its listener again).
 */
export async function registerDevice(api: Api, session: { token: string }, platform: Platform, devicePushToken?: Notifications.DevicePushToken) {
  const mine = ++turn;
  const project = projectId();
  if (!project || !(await permission()).allowed) {
    return;
  }
  await ensureChannel(platform);
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: project, devicePushToken });
  const id = await deviceId();
  // Signed out meanwhile (or a newer registration took over): this one would outlive the removal, under the new id.
  if (turn !== mine) {
    return;
  }
  const key = `${session.token}\n${token}`;
  if (registered === key) {
    return;
  }
  registered = key;
  try {
    await api("/devices", { method: "POST", body: { deviceId: id, token, platform } });
  } catch (error) {
    registered = null;
    throw error;
  }
}

/**
 * Stops this phone's notifications for the session signing out (`devices.remove`). Done once the request is sent (the
 * id is read on the phone): its answer is never waited for. A removal that failed other than with a 401 (the session's
 * over, and its rows with it) may mean the sign-out didn't get there either (offline, a Wi-Fi login page), so the phone
 * gives up its push token: Expo then calls it unregistered, and the server drops it. Not once a registration started
 * since (signed in again meanwhile): that one's token is the one in use.
 */
export async function removeDevice(api: Api) {
  registered = null;
  const mine = ++turn;
  const id = await deviceId().catch(() => null);
  if (id) {
    void api(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch((error: unknown) => {
      if (turn === mine && !(error instanceof ApiError && error.status === 401)) {
        return Notifications.unregisterForNotificationsAsync().catch(() => {});
      }
    });
    // A new id from here on: a sign-in that registers while this is still on its way gets a row of its own, which this
    // late removal can't reach. Kept in memory if storage fails (the next launch then reads the old one, as before).
    const made = randomUUID();
    keptId = Promise.resolve(made);
    void SecureStore.setItemAsync(DEVICE_ID, made, STORE_OPTIONS).catch(() => {});
  }
}

const again = new Set<() => void>();
/** Registers again now (notifications just allowed). */
export const registerAgain = () => again.forEach((register) => register());
/** Calls `register` on registerAgain; the function returned stops. */
export function onRegisterAgain(register: () => void) {
  again.add(register);
  return () => void again.delete(register);
}

/** Takes the notifications shown off the phone (signing out): they'd show the last account's customers' messages. */
export const dismissDelivered = () => Notifications.dismissAllNotificationsAsync().catch(() => {});

/** A notification's conversation: `data` as the server sends it, checked, since anything on the phone can post one. */
export type Target = { project: string; number: number };
export function targetOf(data: unknown): Target | null {
  const { project, conversation } = (data ?? {}) as { project?: unknown; conversation?: unknown };
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(project) || !Number.isSafeInteger(conversation) || (conversation as number) < 1) {
    return null;
  }
  return { project, number: conversation as number };
}

/** The conversation a tap opens: a tap on the notification itself (not one of its actions), with a conversation in it. */
export const tapped = (response: Notifications.NotificationResponse | null | undefined) =>
  response?.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER ? targetOf(response.notification.request.content.data) : null;

/** The conversation on screen, while it's focused (the handler below is asked only while the app is in front). */
let looking: { key: string } | null = null;
const keyOf = (target: Target) => `${target.project}\n${target.number}`;
/**
 * Marks the conversation as the one on screen; the function returned undoes this mark only, never a newer one (of the
 * same conversation too: its details sheet focusing as the conversation's screen blurs).
 */
export function lookAt(target: Target) {
  const mark = { key: keyOf(target) };
  looking = mark;
  return () => {
    if (looking === mark) {
      looking = null;
    }
  };
}

/**
 * How a notification arriving while the app is in front shows: not at all over its own conversation, or signed out (one
 * a sign-out that didn't reach the server left coming), as a banner elsewhere.
 */
export function behaviourFor(notification: Notifications.Notification, signedOut = false): Notifications.NotificationBehavior {
  const target = targetOf(notification.request.content.data);
  const show = !signedOut && (!target || keyOf(target) !== looking?.key);
  return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
}

/**
 * Opens a tapped notification's conversation, in its project, over the Inbox: the screens open go first (`leave`), so
 * it never opens over a sheet, and a conversation open can't show another project's of its number. Another project: only
 * one of the teammate's (`projects`, their slugs; a notification left from another account, or posted by something else,
 * opens nothing), switched to before it opens. Signed out, nothing (sign-in is all there is).
 */
export async function openTarget(
  target: Target,
  session: Session | null,
  setProject: (slug: string) => Promise<void>,
  { leave, open, projects }: { leave: () => void; open: (path: string) => void; projects: () => Promise<string[]> },
) {
  if (!session) {
    return;
  }
  const other = session.project !== target.project;
  if (other && !(await projects().catch(() => [] as string[])).includes(target.project)) {
    return;
  }
  // Back to the Inbox first, also in the same project: never over a sheet (the details, Android's projects).
  leave();
  if (other) {
    await setProject(target.project);
  }
  open(`/conversation/${target.number}`);
}
