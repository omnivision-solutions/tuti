import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, type HostInstance, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { allow } from "@/components/notifications";
import { permission, registerAgain } from "@/lib/notifications";
import { useApi } from "@/lib/session";
import { useColors } from "@/lib/theme";

type Settings = { showMessageText: boolean };

// Notifications, from where signing out is: whether the system shows them (changed in its settings, or asked here if
// it never was), and whether they show the message's text (the teammate's own, in all their projects).
export default function NotificationSettings() {
  const colors = useColors();
  const api = useApi();
  const [allowed, setAllowed] = useState<{ allowed: boolean; canAsk: boolean } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One change at a time: an answer to an older one can't put the switch back over a newer one.
  const [saving, setSaving] = useState(false);

  // Read again on coming back from the system's settings, and the phone registered if they were turned on there.
  const check = useCallback(
    () =>
      permission().then((now) => {
        setAllowed(now);
        if (now.allowed) {
          registerAgain();
        }
      }),
    [],
  );
  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener("change", (state) => state === "active" && void check());
    return () => subscription.remove();
  }, [check]);

  // VoiceOver has no live regions: an error (a switch put back) is announced (TalkBack reads the live region below).
  useEffect(() => {
    if (error && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const load = useCallback(() => api<Settings>("/notifications").then(setSettings, (e: Error) => setError(e.message)), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  // Try again goes with the error it's under: a screen reader's focus moves to the switch it loads, rather than being lost.
  const showText = useRef<HostInstance>(null);
  const retried = useRef(false);
  const retry = () => {
    retried.current = true;
    setError(null);
    void load();
  };
  useEffect(() => {
    if (!error && retried.current) {
      retried.current = false;
      if (showText.current) {
        AccessibilityInfo.sendAccessibilityEvent(showText.current, "focus");
      }
    }
  }, [error]);

  const turn = () => {
    if (allowed?.canAsk) {
      void allow().then(() => check());
    } else {
      void Linking.openSettings();
    }
  };

  // Shown switched at once; put back, with why, if the server didn't take it.
  const setShowText = (showMessageText: boolean) => {
    setSettings({ showMessageText });
    setError(null);
    setSaving(true);
    api<Settings>("/notifications", { method: "PATCH", body: { showMessageText } })
      .then(setSettings, (e: Error) => {
        setSettings({ showMessageText: !showMessageText });
        setError(e.message);
      })
      .finally(() => setSaving(false));
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      <View style={[styles.group, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Pressable
          onPress={turn}
          disabled={!allowed}
          accessibilityRole="button"
          accessibilityLabel={allowed ? `Notifications, ${allowed.allowed ? "on" : "off"}` : "Notifications"}
          accessibilityHint={allowed?.canAsk ? "Asks to turn them on" : "Opens the system's settings"}
          android_ripple={{ color: colors.border }}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={styles.rowText}>
            <Text style={[styles.label, { color: colors.text }]}>Notifications</Text>
            <Text style={[styles.detail, { color: colors.muted }]}>
              {allowed?.allowed ? "Tuti tells you when someone writes to a conversation you'd get an email about." : allowed?.canAsk ? "Tap to turn them on." : "Turn them on in your phone's settings."}
            </Text>
          </View>
          {allowed && <Text style={[styles.value, { color: allowed.allowed ? colors.text : colors.muted }]}>{allowed.allowed ? "On ›" : "Off ›"}</Text>}
        </Pressable>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={[styles.label, { color: colors.text }]}>Show message text</Text>
            <Text style={[styles.detail, { color: colors.muted }]}>Off, a notification says who wrote and in which project, not what.</Text>
          </View>
          <Switch
            ref={showText}
            value={settings?.showMessageText ?? false}
            disabled={!settings || saving}
            accessibilityState={{ disabled: !settings || saving }}
            onValueChange={setShowText}
            accessibilityLabel="Show message text"
            trackColor={{ true: colors.primary }}
            // Android's thumb is the system's accent otherwise, not Tuti's: on, it sits on the green track as Material's does.
            thumbColor={Platform.OS === "android" && settings?.showMessageText ? colors.onPrimary : undefined}
          />
        </View>
      </View>
      <Text style={[styles.footer, { color: colors.muted }]}>These hold in all your projects.</Text>
      {error && (
        <View style={styles.errorBox}>
          <Text style={[styles.detail, { color: colors.error }]} accessibilityLiveRegion="polite">
            {error}
          </Text>
          {!settings && (
            <Pressable onPress={retry} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.retry, { color: colors.primary }]}>Try again</Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 12 },
  rowText: { flex: 1, gap: 2 },
  label: { fontSize: 17 },
  detail: { fontSize: 14, lineHeight: 19 },
  value: { fontSize: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  footer: { fontSize: 13, paddingHorizontal: 16 },
  errorBox: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  retry: { fontSize: 17, fontWeight: "500" },
});
