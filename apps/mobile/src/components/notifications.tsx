import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert, Platform } from "react-native";

import { askPermission, behaviourFor, openTarget, registerAgain, shouldOffer, type Target, tapped, usePushRegistration } from "@/lib/notifications";
import { useSession } from "@/lib/session";

const platform = Platform.OS === "ios" ? "ios" : "android";

// While the app is in front: a banner, except over the conversation it's about.
Notifications.setNotificationHandler({ handleNotification: async (notification) => behaviourFor(notification) });

/**
 * For the root layout: keeps the phone registered while signed in, and opens a tapped notification's conversation, the
 * app running or launched by the tap (once it knows whether anyone's signed in).
 */
export function useNotifications() {
  const { session, api, setProject } = useSession();
  usePushRegistration(session, api, platform);

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
    openTarget(next, session, setProject, { leave: () => router.canDismiss() && router.dismissAll(), open: (path) => router.push(path) }).catch((e: Error) => Alert.alert("Couldn't switch project", e.message));
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
