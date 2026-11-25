import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, AppState, FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { confirmSignOut, openCount, type Project } from "@/app/inbox/projects";
import { InboxRow } from "@/components/inbox-row";
import { onRead } from "@/lib/conversation";
import { appendPage, firstRows, type InboxView, latestOnly, listPath, type Page, type Row, rowPath, type ViewName, withRow } from "@/lib/inbox";
import { type LiveUpdate, openLive } from "@/lib/live";
import { useApi, useSession } from "@/lib/session";
import { type Colors, useColors } from "@/lib/theme";

/**
 * The list shown, and what it lists (`for`: the project, view and search it was loaded for). `moved`: rows live changes
 * have added (or, below zero, removed) since, which move where the next page starts.
 */
type List = { for: string; rows: Row[]; next: string | null; total: number; moved: number };

/** What each view says when it has nothing, as the web's Inbox. */
const EMPTY: Record<ViewName, string> = {
  open: "No replies waiting. You're up to date.",
  mine: "Nothing's assigned to you.",
  unassigned: "Every open conversation has someone on it.",
  waiting: "No conversations wait on a user.",
  snoozed: "Nothing's snoozed.",
  closed: "No closed conversations yet.",
  spam: "No spam.",
};

// Signed in: the Inbox of the project chosen, its views as chips, a search, and the list, kept current while it's open.
export default function Inbox() {
  const colors = useColors();
  const api = useApi();
  const { session, setProject, signOut } = useSession();
  const project = session?.project;

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [views, setViews] = useState<InboxView[] | null>(null);
  const [view, setView] = useState<ViewName>("open");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [loaded, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [loads] = useState(latestOnly);
  const paging = useRef(false);
  // The latest load of everything: the list it shows once it's in (null if a newer one replaced it, or it failed).
  const reload = useRef<Promise<List | null>>(Promise.resolve(null));
  // A new project, view or search starts from nothing shown.
  const key = `${project}\n${view}\n${q}`;
  const list = loaded?.for === key ? loaded : null;

  // The rows' ages move on while nothing else changes.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  // The search waits for typing to pause.
  useEffect(() => {
    const soon = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(soon);
  }, [typed]);

  // The teammate's projects, for the switcher. None chosen yet (or no longer theirs): the first.
  const loadProjects = useCallback(
    () =>
      api<{ projects: Project[] }>("/projects").then(
        (answer) => {
          setProjects(answer.projects);
          const first = answer.projects[0];
          if (first && !answer.projects.some((p) => p.slug === project)) {
            void setProject(first.slug).catch((e: Error) => setError(`Couldn't open ${first.name}: ${e.message}`));
          }
        },
        (e: Error) => setError(e.message),
      ),
    [api, project, setProject],
  );
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // The views' counts, unless a newer load of everything started meanwhile.
  const loadCounts = useCallback(
    (mine = loads.current()) => api<{ views: InboxView[] }>("/inbox/views").then((answer) => loads.isLatest(mine) && setViews(answer.views)),
    [api, loads],
  );

  // Everything shown: the views' counts and the list from its start (`keep`: as many rows as are shown, so a reload keeps
  // them all, however many pages that is).
  const loadAll = useCallback(
    (keep = 0) => {
      if (!project) {
        return Promise.resolve();
      }
      const mine = loads.start();
      // The counts show as they come, without waiting on the list.
      const counts = loadCounts(mine);
      const rows = firstRows(api, view, q, keep).then((page) => {
        if (loads.isLatest(mine)) {
          const fresh = { for: key, rows: page.conversations, next: page.nextCursor, total: page.total, moved: 0 };
          setList(fresh);
          setError(null);
          setNow(Date.now());
          return fresh;
        }
        return null;
      });
      reload.current = rows.catch(() => null);
      return Promise.all([counts, rows]).then(
        () => {},
        (e: Error) => {
          if (loads.isLatest(mine)) {
            setError(e.message);
          }
        },
      );
    },
    [api, project, view, q, key, loads, loadCounts],
  );
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([loadAll(list?.rows.length), loadProjects()]).finally(() => setRefreshing(false));
  };

  // The list the latest reload shows, once it's in: waiting again for one that starts meanwhile.
  const latestReload = async () => {
    let waited: Promise<List | null>;
    let fresh: List | null;
    do {
      waited = reload.current;
      fresh = await waited;
    } while (waited !== reload.current);
    return fresh;
  };

  // The next page after `from` (the list shown, unless a reload's).
  const loadMore = async (from = list): Promise<void> => {
    if (!from?.next || paging.current) {
      return;
    }
    paging.current = true;
    const mine = loads.current();
    const moved = from.moved;
    setError(null);
    try {
      const page = await api<Page>(listPath({ view, q, cursor: from.next }));
      if (loads.isLatest(mine)) {
        // Rows a live change added or removed while it loaded move the next page's start too.
        setList(
          (now) =>
            now && {
              ...now,
              rows: appendPage(now.rows, page.conversations),
              next: page.nextCursor && String(Number(page.nextCursor) + now.moved - moved),
              total: page.total,
            },
        );
      }
    } catch (e) {
      if (loads.isLatest(mine)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      paging.current = false;
    }
    // A reload replaced the list meanwhile, whether the page came or failed. Of this same list, it brings back as many
    // rows, so the list won't ask for the page itself (its length is as it was): asked again once the latest reload is in.
    if (!loads.isLatest(mine)) {
      const fresh = await latestReload();
      if (fresh?.for === from.for) {
        return loadMore(fresh);
      }
    }
  };

  // One conversation changed: its row (in place, moved up, or gone from the view). Of two fetches of one row, only the
  // later one's answer is taken. The counts are the caller's, once for several rows.
  const [rowLoads] = useState(() => new Map<number, number>());
  const loadRow = useCallback(
    async (number: number) => {
      const mine = loads.current();
      const turn = (rowLoads.get(number) ?? 0) + 1;
      rowLoads.set(number, turn);
      try {
        const page = await api<Page>(rowPath(view, number));
        if (loads.isLatest(mine) && rowLoads.get(number) === turn) {
          const found = page.conversations.find((row) => row.number === number);
          setList((now) => {
            if (!now) {
              return now;
            }
            // The server pages by position: a row in or out of those shown moves where the next page starts.
            const rows = withRow(now.rows, number, found ? { ...found, match: null } : null, now.next === null);
            const moved = rows.length - now.rows.length;
            return { ...now, rows, next: now.next && String(Number(now.next) + moved), moved: now.moved + moved };
          });
          setNow(Date.now());
        }
      } catch {
        // The next change, or the stream's next opening, fetches it again.
      }
    },
    [api, view, loads, rowLoads],
  );

  // Live while it's open, and opened again on coming back to the foreground (a phone drops it in the background). Several
  // changes at once make one fetch; a search is fetched whole.
  const onLive = useEffectEvent((all: boolean, numbers: number[]) => {
    if (all || q) {
      void loadAll(list?.rows.length);
    } else {
      numbers.forEach((number) => void loadRow(number));
      void loadCounts().catch(() => {});
    }
  });
  const [awake, setAwake] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && setAwake((n) => n + 1));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!session?.project) {
      return;
    }
    let all = false;
    const numbers = new Set<number>();
    let soon: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      onLive(all, [...numbers]);
      all = false;
      numbers.clear();
    };
    const close = openLive(session, (update: LiveUpdate) => {
      if (update.kind === "all") {
        all = true;
      } else {
        numbers.add(update.number);
      }
      clearTimeout(soon);
      soon = setTimeout(flush, 200);
    });
    return () => {
      close();
      clearTimeout(soon);
    };
  }, [session, awake]);

  // VoiceOver has no live regions: an error is announced (TalkBack reads the live regions below).
  useEffect(() => {
    if (error && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const choose = (slug: string) => {
    if (slug !== project) {
      void setProject(slug).catch((e: Error) => setError(`Couldn't keep that choice: ${e.message}`));
    }
  };
  // Back from a conversation: its row and the counts again, as its stream would after a change. Reading it there sends no
  // live change (unread is the teammate's own), so it would stay bold and counted till something else changed.
  const opened = useRef<number | null>(null);
  const open = useCallback((row: Row) => {
    opened.current = row.number;
    router.push(`/conversation/${row.number}`);
  }, []);
  const [returned, setReturned] = useState<{ number: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (opened.current !== null) {
        setReturned({ number: opened.current });
        opened.current = null;
      }
    }, []),
  );
  useEffect(() => {
    if (returned) {
      onLive(false, [returned.number]);
    }
  }, [returned]);
  // A conversation marked read (in its screen, its read maybe answering after the fetch above): its row and the counts
  // again, whether the Inbox is in front or not.
  useEffect(() => onRead((number) => onLive(false, [number])), []);

  const current = projects?.find((p) => p.slug === project);
  const searching = !!q;
  const noProjects = projects?.length === 0;

  return (
    <>
      {/* The switcher: the chosen project's name, opening the teammate's projects; signing out is its last item. iOS: the
          header's own menu. Android: the title, opening a bottom sheet (its menu needs a native module the app doesn't have). */}
      {Platform.OS === "ios" ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Menu accessibilityLabel={`${current?.name ?? "Projects"}, switch project`} title="Projects">
            <Stack.Toolbar.Label>{current?.name ?? "Projects"}</Stack.Toolbar.Label>
            {(projects ?? []).map((p) => (
              <Stack.Toolbar.MenuAction key={p.slug} isOn={p.slug === project} subtitle={openCount(p.openConversations)} onPress={() => choose(p.slug)}>
                {p.name}
              </Stack.Toolbar.MenuAction>
            ))}
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction destructive onPress={() => confirmSignOut(signOut)}>
                Sign out
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : (
        <Stack.Screen
          options={{
            headerTitle: () => (
              <Pressable
                onPress={() => router.push("/inbox/projects")}
                accessibilityRole="button"
                accessibilityLabel={`${current?.name ?? "Inbox"}, switch project`}
                hitSlop={8}
                style={styles.titleButton}
              >
                <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                  {current?.name ?? "Inbox"}
                </Text>
                <Text style={[styles.title, { color: colors.muted }]}>▾</Text>
              </Pressable>
            ),
          }}
        />
      )}
      <Stack.SearchBar
        placeholder={Platform.OS === "ios" ? "Search" : "Search conversations"}
        // Under the large title, as Mail and Messages have it (iOS 26 would put it at the bottom).
        placement="stacked"
        hideWhenScrolling={false}
        // Android's search bar keeps the system's colours otherwise: dark text on the dark palette.
        textColor={colors.text}
        hintTextColor={colors.muted}
        headerIconColor={colors.text}
        tintColor={colors.primary}
        autoCapitalize="none"
        onChangeText={(event) => {
          setError(null);
          setTyped(event.nativeEvent.text);
        }}
        onCancelButtonPress={() => setTyped("")}
        onClose={() => setTyped("")}
      />
      <FlatList
        testID="inbox-list"
        data={list?.rows ?? []}
        keyExtractor={(row) => String(row.number)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        refreshing={refreshing}
        onRefresh={refresh}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        renderItem={({ item }) => <InboxRow row={item} colors={colors} q={q} now={now} onPress={open} />}
        ListHeaderComponent={
          <>
            {searching ? (
              list && (
                <Text style={[styles.total, { color: colors.muted }]} accessibilityLiveRegion="polite">
                  {list.total === 1 ? "1 conversation" : `${list.total} conversations`}
                </Text>
              )
            ) : (
              views && (
                <Chips
                  views={views}
                  view={view}
                  // A view's error isn't the next one's.
                  onPress={(next) => {
                    setError(null);
                    setView(next);
                  }}
                  colors={colors}
                />
              )
            )}
            {/* A refresh that failed says so above the list it couldn't update. */}
            {error && !!list?.rows.length && (
              <Text style={[styles.stale, { color: colors.error }]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            {!error && !noProjects && !list ? (
              <ActivityIndicator color={colors.muted} accessibilityLabel="Loading" />
            ) : (
              <Text style={[styles.empty, { color: error ? colors.error : colors.muted }]} accessibilityLiveRegion="polite">
                {error ??
                  (noProjects
                    ? "You're not on a project yet. Create one, or ask a teammate to invite you, on the web."
                    : searching
                      ? "No conversations match your search. Try other words, a name or an email address."
                      : EMPTY[view])}
              </Text>
            )}
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
                <Text style={[styles.retry, { color: colors.primary }]}>Try again</Text>
              </Pressable>
            )}
          </View>
        }
        ListFooterComponent={
          !list?.next ? undefined : error ? (
            // A page that failed: tried again here (the error is at the top).
            <Pressable onPress={() => void loadMore()} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.more, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={[styles.retry, { color: colors.primary, textAlign: "center" }]}>Try again</Text>
            </Pressable>
          ) : (
            <ActivityIndicator style={styles.more} color={colors.muted} />
          )
        }
      />
    </>
  );
}


/** The views as filter chips, in the server's order, each with its count when it has any. */
function Chips({ views, view, onPress, colors }: { views: InboxView[]; view: ViewName; onPress: (view: ViewName) => void; colors: Colors }) {
  const ios = Platform.OS === "ios";
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="tablist">
      {views.map((v) => {
        const on = v.view === view;
        const ink = on ? (ios ? colors.onPrimary : colors.onSoft) : colors.text;
        return (
          <Pressable
            key={v.view}
            onPress={() => onPress(v.view)}
            accessibilityRole="tab"
            accessibilityLabel={v.count ? `${v.title}, ${v.count}` : v.title}
            accessibilityState={{ selected: on }}
            android_ripple={{ color: colors.border }}
            style={({ pressed }) => [
              styles.chip,
              ios
                ? { borderRadius: 16, backgroundColor: on ? colors.primary : colors.secondary, opacity: pressed ? 0.7 : 1 }
                : { borderRadius: 8, borderWidth: 1, borderColor: on ? "transparent" : colors.border, backgroundColor: on ? colors.soft : undefined },
            ]}
          >
            {!ios && on && <Text style={[styles.chipText, { color: ink }]}>✓</Text>}
            <Text style={[styles.chipText, { color: ink }]}>{v.title}</Text>
            {v.count > 0 && <Text style={[styles.chipText, { color: ink, opacity: on ? 0.85 : 0.65 }]}>{v.count}</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // As wide as its text: the header stretches its title over the search action otherwise.
  titleButton: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  title: { fontSize: 22 },
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10 },
  chip: { height: 32, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 6, overflow: "hidden" },
  chipText: { fontSize: 14, fontWeight: "500" },
  total: { fontSize: 13, paddingHorizontal: 24, paddingTop: 2, paddingBottom: 6 },
  stale: { fontSize: 14, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 8 },
  emptyBox: { alignItems: "center", gap: 12, padding: 32 },
  empty: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  retry: { fontSize: 17, fontWeight: "500" },
  more: { paddingVertical: 16 },
});
