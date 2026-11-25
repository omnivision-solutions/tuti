import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useApi, useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export type Project = { slug: string; name: string; role: string; openConversations: number };

export const openCount = (n: number) => (n === 1 ? "1 open conversation" : `${n} open conversations`);

/** As the platforms do it: confirmed first, in the error colour. */
export const confirmSignOut = (signOut: () => Promise<void>) =>
  Alert.alert("Sign out of Tuti?", undefined, [
    { text: "Cancel", style: "cancel" },
    { text: "Sign out", style: "destructive", onPress: () => void signOut() },
  ]);

// The project switcher on Android, a bottom sheet from the Inbox's title (iOS has the header's own menu): the teammate's
// projects to choose one, and signing out last.
export default function Projects() {
  const colors = useColors();
  const api = useApi();
  const { session, setProject, signOut } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ projects: Project[] }>("/projects").then(
      (answer) => setProjects(answer.projects),
      (e: Error) => setError(e.message),
    );
  }, [api]);

  const choose = (slug: string) => {
    router.back();
    if (slug !== session?.project) {
      // The Inbox says so if it can't be kept: this sheet is gone by then.
      void setProject(slug).catch((e: Error) => Alert.alert("Couldn't switch project", e.message));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text style={[styles.heading, { color: colors.primary }]} accessibilityRole="header">
        Projects
      </Text>
      {error && (
        <Text style={[styles.detail, styles.pad, { color: colors.error }]} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {projects?.map((item) => {
        const chosen = item.slug === session?.project;
        return (
          <Pressable
            key={item.slug}
            onPress={() => choose(item.slug)}
            accessibilityRole="button"
            accessibilityState={{ selected: chosen }}
            android_ripple={{ color: colors.border }}
            style={[styles.row, chosen && { backgroundColor: colors.soft }]}
          >
            <View style={styles.rowText}>
              <Text style={[styles.name, { color: chosen ? colors.onSoft : colors.text }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.detail, { color: colors.muted }]}>{openCount(item.openConversations)}</Text>
            </View>
            {chosen && <Text style={[styles.check, { color: colors.onSoft }]}>✓</Text>}
          </Pressable>
        );
      })}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <Pressable
        onPress={() => {
          router.back();
          router.push("/notifications");
        }}
        accessibilityRole="button"
        android_ripple={{ color: colors.border }}
        style={styles.row}
      >
        <Text style={[styles.name, { color: colors.text }]}>Notifications</Text>
      </Pressable>
      <Pressable onPress={() => confirmSignOut(signOut)} accessibilityRole="button" android_ripple={{ color: colors.border }} style={styles.row}>
        <Text style={[styles.name, { color: colors.error }]}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 8, paddingBottom: 24 },
  heading: { fontSize: 14, fontWeight: "500", paddingHorizontal: 24, paddingVertical: 8 },
  pad: { paddingHorizontal: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 24, paddingVertical: 8, marginHorizontal: 12, borderRadius: 28, overflow: "hidden" },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: "500" },
  detail: { fontSize: 14 },
  check: { fontSize: 18, fontWeight: "600" },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 24, marginVertical: 8 },
});
