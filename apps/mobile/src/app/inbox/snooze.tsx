import { router, useLocalSearchParams } from "expo-router";
import { ActionSheetIOS, Platform, Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { snoozeChoices } from "@/lib/details";
import { useColors } from "@/lib/theme";

/** A snooze chosen for a conversation: till `at`, or null to wake it. */
type Chosen = (number: number, at: Date | null) => void;
let chosen: Chosen | null = null;

/** The details sheet's snooze choices, and Wake now for a snoozed one. */
const choicesFor = (snoozed: boolean) => [...snoozeChoices().map(({ label, at }) => ({ label, at: at as Date | null })), ...(snoozed ? [{ label: "Wake now", at: null }] : [])];

/**
 * Asks when to snooze a row's conversation, then calls `then` (not at all when cancelled). iOS: an action sheet. Android:
 * a bottom sheet (this screen), as the project switcher.
 */
export function pickSnooze(number: number, snoozed: boolean, then: Chosen) {
  if (Platform.OS === "ios") {
    const choices = choicesFor(snoozed);
    ActionSheetIOS.showActionSheetWithOptions({ title: "Snooze", options: [...choices.map((c) => c.label), "Cancel"], cancelButtonIndex: choices.length }, (i) => {
      if (i < choices.length) {
        then(number, choices[i]!.at);
      }
    });
    return;
  }
  chosen = then;
  router.push({ pathname: "/inbox/snooze", params: { number, snoozed: snoozed ? "1" : "" } });
}

// The snooze choices on Android, a bottom sheet over the Inbox (`pickSnooze`).
export default function Snooze() {
  const colors = useColors();
  const params = useLocalSearchParams<{ number: string; snoozed?: string }>();
  return (
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text style={[styles.heading, { color: colors.primary }]} accessibilityRole="header">
        Snooze
      </Text>
      {choicesFor(!!params.snoozed).map(({ label, at }) => (
        <Pressable
          key={label}
          onPress={() => {
            router.back();
            chosen?.(Number(params.number), at);
            chosen = null;
          }}
          accessibilityRole="button"
          android_ripple={{ color: colors.border }}
          style={styles.row}
        >
          <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 8, paddingBottom: 24 },
  heading: { fontSize: 14, fontWeight: "500", paddingHorizontal: 24, paddingVertical: 8 },
  row: { justifyContent: "center", minHeight: 56, paddingHorizontal: 24, marginHorizontal: 12, borderRadius: 28, overflow: "hidden" },
  label: { fontSize: 16, fontWeight: "500" },
});
