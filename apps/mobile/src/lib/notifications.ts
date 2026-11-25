import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import * as Notifications from "expo-notifications";
import { AndroidImportance, IosAuthorizationStatus } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useEffectEvent } from "react";

import type { Api } from "./api";
import type { Session } from "./session-store";
import { STORE_OPTIONS } from "./sign-in";

/**
 * Notifications on the phone (docs/plan.md, Mobile app, M8): the server pushes a user's message to the devices its
 * teammate registered (`devices.register`), with `data: { project: <slug>, conversation: <number> }`
 * (packages/jobs/src/push.ts). Asked for once the Inbox shows, never at launch; a tap opens the conversation.
 */

type Platform = "ios" | "android";

const DEVICE_ID = "device-id";
const ASKED = "notifications-asked";
/** Where pushes without a channel of their own go: Expo's push service sends to `default` when none is named. */
const CHANNEL = "default";

/** This install's id, made up once and kept on the phone, so registering again replaces its row rather than adding one. */
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
    if (await SecureStore.getItemAsync(ASKED, STORE_OPTIONS)) {
      return false;
    }
    await SecureStore.setItemAsync(ASKED, "1", STORE_OPTIONS);
    const now = await Notifications.getPermissionsAsync();
    return !now.granted && now.status === Notifications.PermissionStatus.UNDETERMINED && now.canAskAgain;
  } catch {
    return false;
  }
}

/** The Expo project pushes come through: a build without one (a fork's, before it has an EAS project) gets no token. */
const projectId = () => (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ?? Constants.easConfig?.projectId;

/** The session and Expo token last registered (or being registered): the same pair isn't sent twice. */
let registered: string | null = null;

/**
 * Registers this phone for the session's teammate (`devices.register`), if notifications are allowed. `devicePushToken`:
 * the new one the system just gave (fetching it again would fire its listener again).
 */
export async function registerDevice(api: Api, session: { token: string }, platform: Platform, devicePushToken?: Notifications.DevicePushToken) {
  const project = projectId();
  if (!project || !(await permission()).allowed) {
    return;
  }
  await ensureChannel(platform);
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: project, devicePushToken });
  const key = `${session.token}\n${token}`;
  if (registered === key) {
    return;
  }
  registered = key;
  try {
    await api("/devices", { method: "POST", body: { deviceId: await deviceId(), token, platform } });
  } catch (error) {
    registered = null;
    throw error;
  }
}

/**
 * Stops this phone's notifications for the session signing out (`devices.remove`). Done once the request is sent (the
 * id is read on the phone): its answer is never waited for, and its failure is no one's, as signing out ends the
 * session, and with it the server's rows for it, anyway.
 */
export async function removeDevice(api: Api) {
  registered = null;
  const id = await deviceId().catch(() => null);
  if (id) {
    void api(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
}

const again = new Set<() => void>();
/** Registers again now (notifications just allowed). */
export const registerAgain = () => again.forEach((register) => register());

/**
 * Keeps this phone registered while signed in: as each session gets its project (the API needs one), at each launch,
 * when the system gives a new token, and when notifications are allowed.
 */
export function usePushRegistration(session: Session | null | undefined, api: Api | null, platform: Platform) {
  const signedIn = session?.project ? session.token : null;
  const register = useEffectEvent((devicePushToken?: Notifications.DevicePushToken) => {
    if (api && session) {
      void registerDevice(api, session, platform, devicePushToken).catch(() => {});
    }
  });
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    register();
    const changed = Notifications.addPushTokenListener((token) => register(token));
    const allowed = () => register();
    again.add(allowed);
    return () => {
      changed.remove();
      again.delete(allowed);
    };
  }, [signedIn]);
}

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
let looking: string | null = null;
const keyOf = (target: Target) => `${target.project}\n${target.number}`;
/** Marks the conversation as the one on screen; the function returned unmarks it. */
export function lookAt(target: Target) {
  const key = keyOf(target);
  looking = key;
  return () => {
    if (looking === key) {
      looking = null;
    }
  };
}

/** How a notification arriving while the app is in front shows: not at all over its own conversation, as a banner elsewhere. */
export function behaviourFor(notification: Notifications.Notification): Notifications.NotificationBehavior {
  const target = targetOf(notification.request.content.data);
  const show = !target || keyOf(target) !== looking;
  return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
}

/**
 * Opens a tapped notification's conversation, in its project: switching to it first if another is chosen. Signed out,
 * nothing (sign-in is all there is).
 */
export async function openTarget(target: Target, session: Session | null, setProject: (slug: string) => Promise<void>, open: (path: string) => void) {
  if (!session) {
    return;
  }
  if (session.project !== target.project) {
    await setProject(target.project);
  }
  open(`/conversation/${target.number}`);
}
