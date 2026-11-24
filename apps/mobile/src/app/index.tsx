import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";

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

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => void signOut()} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.action, { color: colors.primary }]}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={projects ?? []}
        keyExtractor={(project) => project.slug}
        contentInsetAdjustmentBehavior="automatic"
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void load().finally(() => setRefreshing(false));
        }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: error ? colors.error : colors.muted }]}>
            {error ?? (projects ? "You're not on a project yet. Create one, or ask a teammate to invite you, on the web." : "Loading…")}
          </Text>
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
      />
    </>
  );
}

const styles = StyleSheet.create({
  action: { fontSize: 17, fontWeight: Platform.OS === "ios" ? "400" : "500" },
  empty: { fontSize: 15, lineHeight: 21, textAlign: "center", padding: 32 },
  row: { paddingLeft: 16 },
  rowBody: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingRight: 16, gap: 12 },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: "500" },
  detail: { fontSize: 14 },
  check: { fontSize: 18, fontWeight: "600" },
});
