import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert, AppState, Platform } from "react-native";

import type { Api } from "@/lib/api";
import { askPermission, behaviourFor, onRegisterAgain, openTarget, registerAgain, registerDevice, registeredFor, shouldOffer, type Target, tapped } from "@/lib/notifications";
import { type Session, useSession } from "@/lib/session";

const platform = Platform.OS === "ios" ? "ios" : "android";

/**
 * Keeps this phone registered while signed in: as each session gets its project (the API needs one), at each launch, on
 * coming back to the foreground (a registration that failed, or notifications turned on in the system's settings), when
 * the system gives a new token, and when notifications are allowed. The same session and token are sent once.
 */
function usePushRegistration(session: Session | null | undefined, api: Api | null) {
  const signedIn = session?.project ? session.token : null;
  const register = useEffectEvent((devicePushToken?: Notifications.DevicePushToken) => {
    if (api && session) {
      void registerDevice(api, session, platform, devicePushToken).catch(() => {});
    }
  });
  const registerUnlessDone = useEffectEvent(() => {
    if (session && !registeredFor(session)) {
      register();
    }
  });
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    register();
    const changed = Notifications.addPushTokenListener((token) => register(token));
    // A phone already registered for the session reads no token again; the token listener covers a new one.
    const front = AppState.addEventListener("change", (state) => state === "active" && registerUnlessDone());
    const stop = onRegisterAgain(() => register());
    return () => {
      changed.remove();
      front.remove();
      stop();
    };
  }, [signedIn]);
}

/**
 * For the root layout: keeps the phone registered while signed in, and opens a tapped notification's conversation, the
 * app running or launched by the tap (once it knows whether anyone's signed in).
 */
export function useNotifications() {
  const { session, api, setProject } = useSession();
  usePushRegistration(session, api);

  // While the app is in front: a banner, except over the conversation it's about, and nothing signed out.
  const signedOut = session === null;
  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async (notification) => behaviourFor(notification, signedOut) });
  }, [signedOut]);

  // The tap waiting for the session to be read (a launch by the tap), then opened once.
  const waiting = useRef<Target | null>(null);
  const open = useEffectEvent((target: Target | null) => {
    waiting.current = target ?? waiting.current;
    const next = waiting.current;
    if (!next || session === undefined) {
      return;
    }
    waiting.current = null;
    // A launch that reads the last tap again doesn't open it again.
    Notifications.clearLastNotificationResponse();
    openTarget(next, session, setProject, {
      leave: () => router.canDismiss() && router.dismissAll(),
      open: (path) => router.push(path),
      projects: () => (api ? api<{ projects: { slug: string }[] }>("/projects").then((answer) => answer.projects.map((p) => p.slug)) : Promise.resolve([])),
    }).catch((e: Error) => Alert.alert("Couldn't switch project", e.message));
  });
  useEffect(() => {
    open(tapped(Notifications.getLastNotificationResponse()));
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => open(tapped(response)));
    return () => subscription.remove();
  }, []);
  const known = session !== undefined;
  useEffect(() => {
    if (known) {
      open(null);
    }
  }, [known]);
}

/** As the signed-in Inbox first shows, once on this phone: what notifications are for, then the system's prompt. */
export async function offerNotifications() {
  if (!(await shouldOffer())) {
    return;
  }
  Alert.alert("Turn on notifications?", "Tuti tells you when someone writes to a conversation you'd get an email about.", [
    { text: "Not now", style: "cancel" },
    { text: "Turn on", onPress: () => void allow() },
  ]);
}

/** The system's prompt, and the phone registered once it's allowed. */
export async function allow() {
  const allowed = await askPermission(platform);
  if (allowed) {
    registerAgain();
  }
  return allowed;
}
