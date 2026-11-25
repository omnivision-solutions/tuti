import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { useApi, useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

type Project = { slug: string; name: string; role: string; openConversations: number };

// Signed in. For now the teammate's projects, to choose the one the Inbox shows (the Inbox comes next, here).
export default function Projects() {
  const colors = useColors();
  const api = useApi();
  const { session, setProject, signOut } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      api<{ projects: Project[] }>("/projects").then(
        (answer) => {
          setProjects(answer.projects);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // VoiceOver has no live regions: an error is announced (TalkBack reads the live regions below).
  useEffect(() => {
    if (error && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  // As the platforms do it: the last row, in the error colour, confirmed first (never one tap in the header).
  const confirmSignOut = () =>
    Alert.alert("Sign out of Tuti?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);

  return (
    <FlatList
      data={projects ?? []}
      keyExtractor={(project) => project.slug}
      contentInsetAdjustmentBehavior="automatic"
      refreshing={refreshing}
      onRefresh={refresh}
      // A refresh that failed says so above the list it couldn't update.
      ListHeaderComponent={error && projects?.length ? <Text style={[styles.stale, { color: colors.error }]} accessibilityLiveRegion="polite">{error}</Text> : undefined}
      ListEmptyComponent={
        <View style={styles.emptyBox}>
          <Text style={[styles.empty, { color: error ? colors.error : colors.muted }]} accessibilityLiveRegion="polite">
            {error ?? (projects ? "You're not on a project yet. Create one, or ask a teammate to invite you, on the web." : "Loading…")}
          </Text>
          {error && (
            // Pull to refresh isn't there for TalkBack or a keyboard.
            <Pressable
              // Not `disabled`, which would drop focus while it loads: a press is ignored then.
              onPress={() => !refreshing && refresh()}
              accessibilityRole="button"
              accessibilityState={{ busy: refreshing }}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed || refreshing ? 0.6 : 1 })}
            >
              <Text style={[styles.name, { color: colors.primary }]}>Try again</Text>
            </Pressable>
          )}
        </View>
      }
      renderItem={({ item }) => {
        const chosen = item.slug === session?.project;
        return (
          <Pressable
            onPress={() => void setProject(item.slug)}
            accessibilityRole="button"
            accessibilityState={{ selected: chosen }}
            android_ripple={{ color: colors.border }}
            style={({ pressed }) => [styles.row, { backgroundColor: Platform.OS === "ios" && pressed ? colors.secondary : chosen ? colors.soft : undefined }]}
          >
            <View style={[styles.rowBody, Platform.OS === "ios" && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[styles.detail, { color: colors.muted }]}>
                  {item.openConversations === 1 ? "1 open conversation" : `${item.openConversations} open conversations`}
                </Text>
              </View>
              {chosen && <Text style={[styles.check, { color: colors.primary }]}>✓</Text>}
            </View>
          </Pressable>
        );
      }}
      ListFooterComponent={
        <Pressable
          onPress={confirmSignOut}
          accessibilityRole="button"
          android_ripple={{ color: colors.border }}
          style={({ pressed }) => [styles.signOut, Platform.OS === "ios" && pressed && { backgroundColor: colors.secondary }]}
        >
          <Text style={[styles.name, { color: colors.error }]}>Sign out</Text>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  stale: { fontSize: 14, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 8 },
  emptyBox: { alignItems: "center", gap: 12, padding: 32 },
  empty: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  row: { paddingLeft: 16 },
  rowBody: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingRight: 16, gap: 12 },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: "500" },
  detail: { fontSize: 14 },
  check: { fontSize: 18, fontWeight: "600" },
  signOut: { marginTop: 32, paddingHorizontal: 16, paddingVertical: 12 },
});
