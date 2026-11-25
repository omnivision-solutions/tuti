import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Alert, AppState, BackHandler, FlatList, type HostInstance, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { confirmSignOut, openCount, type Project } from "@/app/inbox/projects";
import { ConversationPane } from "@/app/conversation/[number]";
import { pickSnooze } from "@/app/inbox/snooze";
import { InboxRow } from "@/components/inbox-row";
import { offerNotifications } from "@/components/notifications";
import { onRead } from "@/lib/conversation";
import { type Change, snoozeTime, updateConversation } from "@/lib/details";
import { appendPage, firstRows, type InboxView, latestOnly, listPath, type Page, type Row, rowPath, type ViewName, withRow } from "@/lib/inbox";
import { listWidth, onForgetChosen, useWide } from "@/lib/layout";
import { type LiveUpdate, openLive } from "@/lib/live";
import { cached, cacheGeneration, inboxKey, isOffline, keep as remember, offlineNote, projectsKey, useMinutes, viewsKey } from "@/lib/offline";
import { useApi, useSession } from "@/lib/session";
import { type Colors, useColors } from "@/lib/theme";

/**
 * The list shown, and what it lists (`for`: the project, view and search it was loaded for). `moved`: rows live changes
 * have added (or, below zero, removed) since, which move where the next page starts.
 */
type List = { for: string; rows: Row[]; next: string | null; total: number; moved: number } & Kept;

/**
 * Where a list came from: the server, with the cache's generation as its load started (`since`, kept for reading
 * offline unless everything was forgotten since) and when it landed (`loadedAt`); or, with no connection, the cache or
 * the list already shown (`savedAt`: when it was last loaded).
 */
type Kept = { since: number; loadedAt: number; savedAt?: undefined } | { since?: undefined; loadedAt?: undefined; savedAt: number };

/** A view's list as it's kept to read offline: its first rows, up to the server's most for a page. */
type Saved = { rows: Row[]; total: number };

/** Swipes are by project and number: numbers start again in each project. */
const swipeKey = (project: string | undefined, number: number) => `${project}#${number}`;

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
  const projectsShown = useRef(false);
  useEffect(() => {
    projectsShown.current = !!projects;
  }, [projects]);
  // The views' counts, for the project they're of: another project's never show under this one's (offline, its own kept
  // counts or none).
  const [counts, setCounts] = useState<{ for: string | undefined; views: InboxView[] } | null>(null);
  const views = counts !== null && counts.for === project ? counts.views : null;
  const [view, setView] = useState<ViewName>("open");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [loaded, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useMinutes();
  const [loads] = useState(latestOnly);
  /**
   * Swiped rows, hidden from the list: while the server hasn't answered (null), then until a load of the list that
   * started after the answer has come in (0 till that load starts, then its number). That load has the row as the server
   * has it now, wherever it went; meanwhile the row's own fetches are ignored, and no next page is asked for.
   */
  const [swipes, setSwipes] = useState<ReadonlyMap<string, number | null>>(new Map());
  // The same, for callbacks to read as they run.
  const swipesNow = useRef(swipes);
  const changeSwipes = useCallback((change: (swipes: Map<string, number | null>) => void) => {
    const next = new Map(swipesNow.current);
    change(next);
    swipesNow.current = next;
    setSwipes(next);
  }, []);
  const [swipesAnswered, setSwipesAnswered] = useState(0);
  const pagingAfterSwipes = useRef(false);
  const [pageAfterSwipes, setPageAfterSwipes] = useState(0);
  const paging = useRef(false);
  // The latest load of everything: the list it shows once it's in (null if a newer one replaced it, or it failed).
  const reload = useRef<Promise<List | null>>(Promise.resolve(null));
  // A new project, view or search starts from nothing shown.
  const key = `${project}\n${view}\n${q}`;
  const list = loaded?.for === key ? loaded : null;
  // The list as last drawn, for a load's answer to see.
  const shown = useRef<List | null>(null);
  useEffect(() => {
    shown.current = list;
  }, [list]);

  // Notifications are offered here, where they make sense, rather than at launch: once on this phone.
  useEffect(() => {
    void offerNotifications();
  }, []);

  // The search waits for typing to pause. A search's error isn't the next one's; the same search keeps it.
  useEffect(() => {
    const soon = setTimeout(() => {
      const next = typed.trim();
      if (next !== q) {
        setError(null);
        setQ(next);
      }
    }, 300);
    return () => clearTimeout(soon);
  }, [typed, q]);

  // The teammate's projects, for the switcher. None chosen yet (or no longer theirs): the first.
  const loadProjects = useCallback(() => {
    const since = cacheGeneration();
    return api<{ projects: Project[] }>("/projects").then(
        (answer) => {
          setProjects(answer.projects);
          remember(projectsKey(session!), answer.projects, since, session!.owner);
          const first = answer.projects[0];
          if (first && !answer.projects.some((p) => p.slug === project)) {
            void setProject(first.slug).catch((e: Error) => setError(`Couldn't open ${first.name}: ${e.message}`));
          }
        },
        (e: Error) => {
          // No connection: the projects last loaded, for the switcher. Nothing said when the switcher has them already,
          // or the list shows what was kept (its note says it's offline).
          const saved = isOffline(e) ? cached<Project[]>(projectsKey(session!), session!.owner) : null;
          if (saved) {
            setProjects((now) => now ?? saved.data);
          } else if (!(isOffline(e) && (projectsShown.current || shown.current?.savedAt !== undefined))) {
            setError(e.message);
          }
        },
      );
  }, [api, project, setProject, session]);
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // The views' counts, unless a newer load of everything started meanwhile.
  const loadCounts = useCallback(
    (mine = loads.current()) => {
      const since = cacheGeneration();
      return api<{ views: InboxView[] }>("/inbox/views").then((answer) => {
        if (loads.isLatest(mine)) {
          setCounts({ for: session!.project, views: answer.views });
          remember(viewsKey(session!), answer.views, since, session!.owner);
        }
      });
    },
    [api, loads, session],
  );

  // Everything shown: the views' counts and the list from its start (`keep`: as many rows as are shown, so a reload keeps
  // them all, however many pages that is).
  const loadAll = useCallback(
    (keep = 0) => {
      if (!project) {
        return Promise.resolve();
      }
      const mine = loads.start();
      const since = cacheGeneration();
      // The counts show as they come, without waiting on the list. With no connection, the list's failure says so.
      const counts = loadCounts(mine).catch((e: unknown) => {
        if (!isOffline(e)) {
          throw e;
        }
        // Not once a newer load (another project's, say) has started.
        if (!loads.isLatest(mine)) {
          return;
        }
        // The chips as they were last kept.
        const kept = cached<InboxView[]>(viewsKey(session!), session!.owner)?.data;
        setCounts((now) => (now?.for === session!.project || !kept ? now : { for: session!.project, views: kept }));
      });
      const rows = firstRows(api, view, q, keep).then((page) => {
        if (loads.isLatest(mine)) {
          const fresh = { for: key, since, loadedAt: Date.now(), rows: page.conversations, next: page.nextCursor, total: page.total, moved: 0 };
          setList(fresh);
          // Swipes it has: those answered before it started.
          if ([...swipesNow.current.values()].some((reload) => reload && reload <= mine)) {
            changeSwipes((now) => now.forEach((reload, at) => reload && reload <= mine && now.delete(at)));
          }
          // A next page asked for while they were waiting: asked now, from where this list starts it.
          if (pagingAfterSwipes.current && swipesNow.current.size === 0) {
            pagingAfterSwipes.current = false;
            setPageAfterSwipes((n) => n + 1);
          }
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
          if (!loads.isLatest(mine)) {
            return;
          }
          // No connection: what's shown of the view stays (however many pages), or it's as it was last kept (a search
          // never is), saying so rather than the error.
          const showing = shown.current?.for === key;
          const saved = !q && isOffline(e) ? cached<Saved>(inboxKey(session!, view), session!.owner) : null;
          if (!q && isOffline(e) && (showing || saved)) {
            setList((now) =>
              now?.for === key
                ? now.savedAt !== undefined
                  ? now
                  : { ...now, since: undefined, loadedAt: undefined, savedAt: now.loadedAt }
                : saved
                  ? { for: key, savedAt: saved.at, rows: saved.data.rows, next: null, total: saved.data.total, moved: 0 }
                  : now,
            );
            setError(null);
            setNow(Date.now());
          } else {
            setError(e.message);
          }
        },
      );
    },
    [api, project, view, q, key, loads, loadCounts, changeSwipes, session, setNow],
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
  // A failed reload after swipes, asked for again by Try again or scrolling to the end: once every swipe's reload has
  // started (a swipe still waiting brings its own).
  const retriesReload = (tracked: ReadonlyMap<string, number | null>) => !!error && tracked.size > 0 && [...tracked.values()].every((reload) => reload);
  const loadMore = async (from = list): Promise<void> => {
    // Pages start at an offset, which a swipe the server has may have moved: the next page waits for the list's reload.
    // That reload failed (the error says so): asked for again here, as Try again or scrolling to the end asks for more,
    // whether or not there's a next page.
    if (swipesNow.current.size > 0) {
      if (from?.next) {
        pagingAfterSwipes.current = true;
      }
      if (retriesReload(swipesNow.current)) {
        void loadAll(from?.rows.length);
      }
      return;
    }
    // Offline, a list's next page waits for the connection (pull to refresh, or the stream's reconnecting).
    if (!from?.next || from.savedAt !== undefined || paging.current) {
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
        // A row with a swipe waiting comes with the list's reload after the answer.
        if (loads.isLatest(mine) && rowLoads.get(number) === turn && !swipesNow.current.has(swipeKey(project, number))) {
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
    [api, project, view, loads, rowLoads, setNow],
  );

  // A swipe's change: the row is hidden at once. When the server answers, either way, the list shown then is loaded again
  // from its start, as many rows as it shows (the only list kept: another view loads fresh when chosen). Refused, the row
  // comes back at once, with why.
  const triage = useCallback(
    async (row: Row, change: Change, done: string, verb: string) => {
      const at = swipeKey(project, row.number);
      changeSwipes((now) => now.set(at, null));
      try {
        await updateConversation(api, row.number, change);
        changeSwipes((now) => now.set(at, 0));
        AccessibilityInfo.announceForAccessibility(done);
      } catch (e) {
        changeSwipes((now) => now.delete(at));
        // An alert: the row may be far down the list, out of sight.
        Alert.alert(`Couldn't ${verb} "${row.subject}"`, e instanceof Error ? e.message : String(e));
      }
      setSwipesAnswered((n) => n + 1);
    },
    [api, project, changeSwipes],
  );
  const close = useCallback((row: Row) => void triage(row, { status: "closed" }, "Closed", "close"), [triage]);
  const snooze = useCallback(
    (row: Row) =>
      pickSnooze(row.number, view === "snoozed" && !q, (_, at) =>
        void (at ? triage(row, { snoozedUntil: at.toISOString() }, `Snoozed till ${snoozeTime(at)}`, "snooze") : triage(row, { snoozedUntil: null }, "Back in the inbox", "wake")),
      ),
    [triage, view, q],
  );
  // The reload after an answer, of whatever list is shown now; answered swipes wait for it.
  const reloadAfterSwipes = useEffectEvent(() => {
    void loadAll(list?.rows.length);
    const started = loads.current();
    changeSwipes((now) => now.forEach((reload, at) => reload === 0 && now.set(at, started)));
  });
  useEffect(() => {
    if (swipesAnswered) {
      reloadAfterSwipes();
    }
  }, [swipesAnswered]);
  const pageNow = useEffectEvent(() => void loadMore());
  useEffect(() => {
    if (pageAfterSwipes) {
      pageNow();
    }
  }, [pageAfterSwipes]);

  // Live while it's open, and opened again on coming back to the foreground (a phone drops it in the background). Several
  // changes at once make one fetch; a search is fetched whole.
  const onLive = useEffectEvent((all: boolean, numbers: number[]) => {
    if (all || q) {
      void loadAll(list?.rows.length);
    } else if (numbers.some((number) => swipesNow.current.get(swipeKey(project, number)))) {
      // A swiped row changed once its reload had started, which may not have it: loaded again.
      void loadAll(list?.rows.length);
    } else {
      // A row with a swipe waiting for its answer comes with the list's reload after it.
      numbers.filter((number) => !swipesNow.current.has(swipeKey(project, number))).forEach((number) => void loadRow(number));
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

  // VoiceOver has no live regions: an error is announced (TalkBack reads the live regions below), and so is the list
  // turning to what was kept.
  useEffect(() => {
    if (error && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);
  const savedAt = list?.savedAt;
  useEffect(() => {
    if (savedAt !== undefined && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(offlineNote(savedAt));
    }
  }, [savedAt]);

  const choose = (slug: string) => {
    if (slug !== project) {
      void setProject(slug).catch((e: Error) => setError(`Couldn't keep that choice: ${e.message}`));
    }
  };
  // A wide window: the conversation chosen beside the list, as the route's `c` (its number) and `p` (its project, so another
  // project's of that number never shows). However it was opened: a row, a notification, a link, the details (the
  // conversation's route hands it here). A narrow one has none: one chosen in a wide window is pushed when it narrows.
  const wide = useWide();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ c?: string; p?: string }>();
  const chosen = params.c && params.p === project ? Number(params.c) : null;
  // This screen's own params, whatever is over it (a sheet): the router's `setParams` sets the screen in front's.
  const navigation = useNavigation();
  const unchoose = useCallback(() => navigation.setParams({ c: undefined, p: undefined } as never), [navigation]);
  // A conversation opened on its own, or a notification about to open one: the choice is forgotten (`forgetChosen`).
  useEffect(() => onForgetChosen(unchoose), [unchoose]);
  // One chosen in another project (switched since): forgotten, so switching back never brings it back unasked.
  useEffect(() => {
    if (params.c && params.p !== project) {
      unchoose();
    }
  }, [params.c, params.p, project, unchoose]);
  // The pane emptied by its conversation (a Send and close): a screen reader's focus, on the control that's gone, goes
  // to that conversation's row, or to the empty pane's note once the row has left the list.
  const rowNodes = useRef(new Map<number, HostInstance>());
  const onRowNode = useCallback((number: number, node: HostInstance | null) => {
    if (node) {
      rowNodes.current.set(number, node);
    } else {
      rowNodes.current.delete(number);
    }
  }, []);
  const emptyNote = useRef<HostInstance>(null);
  const leftFrom = useRef<number | null>(null);
  const leave = useCallback(() => {
    leftFrom.current = chosen;
    unchoose();
  }, [chosen, unchoose]);
  useEffect(() => {
    if (chosen !== null || leftFrom.current === null) {
      return;
    }
    const target = rowNodes.current.get(leftFrom.current) ?? emptyNote.current;
    leftFrom.current = null;
    if (target) {
      AccessibilityInfo.sendAccessibilityEvent(target, "focus");
    }
  }, [chosen]);
  // iOS's large title is drawn over the screen: the pane starts below it (the list has its own inset). Android's isn't.
  const headerHeight = useHeaderHeight();
  // Only while the Inbox is in front: with a sheet or settings over it, once it's back.
  useFocusEffect(
    useCallback(() => {
      if (!wide && chosen !== null) {
        unchoose();
        router.push(`/conversation/${chosen}`);
      }
    }, [wide, chosen, unchoose]),
  );
  // Android's back, with one chosen: the pane emptied first, as back from a conversation on a phone shows the list. Only
  // while the Inbox is in front: with a sheet over it (the details), back closes the sheet.
  useFocusEffect(
    useCallback(() => {
      if (!wide || chosen === null) {
        return;
      }
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        // As a Send and close: a screen reader's focus goes to the row (`leave`).
        leave();
        return true;
      });
      return () => subscription.remove();
    }, [wide, chosen, leave]),
  );

  // Back from a conversation: its row and the counts again, as its stream would after a change. Reading it there sends no
  // live change (unread is the teammate's own), so it would stay bold and counted till something else changed. (Beside
  // the list, its read says so itself: `onRead` below.)
  const opened = useRef<number | null>(null);
  const open = useCallback(
    (row: Row) => {
      if (wide) {
        navigation.setParams({ c: String(row.number), p: project } as never);
        return;
      }
      opened.current = row.number;
      router.push(`/conversation/${row.number}`);
    },
    [wide, project, navigation],
  );
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
  // The list without the rows swiped.
  const rows = (list?.rows ?? []).filter((row) => !swipes.has(swipeKey(project, row.number)));
  // What's shown of a view, as it changes (pages, live changes, the reload after a swipe), kept to read offline. Not
  // while a swipe waits: what's kept stays as the server last had it till the reload brings the change, or the swipe is
  // refused.
  useEffect(() => {
    if (list?.since !== undefined && !q && session && swipes.size === 0) {
      remember(inboxKey(session, view), { rows: list.rows.slice(0, 100), total: list.total } satisfies Saved, list.since, session.owner);
    }
  }, [list, swipes, q, view, session]);
  const searching = !!q;
  const noProjects = projects?.length === 0;

  // The list: the whole window when narrow, the left of it when wide.
  const listView = (
    <FlatList
      testID="inbox-list"
      data={rows}
      keyExtractor={(row) => String(row.number)}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      refreshing={refreshing}
      onRefresh={refresh}
      onEndReached={() => void loadMore()}
      onEndReachedThreshold={0.5}
      renderItem={({ item }) => (
        <InboxRow
          row={item}
          colors={colors}
          q={q}
          now={now}
          onPress={open}
          selected={wide && item.number === chosen}
          onNode={onRowNode}
          // Not for one that's closed; nor snoozed in Spam, as the details sheet.
          onClose={item.status === "closed" ? undefined : close}
          onSnooze={item.status === "closed" || (view === "spam" && !q) ? undefined : snooze}
        />
      )}
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
                // A view's error isn't the next one's. The view shown, tapped again, is loaded again, as pulling it does.
                onPress={(next) => {
                  if (next === view) {
                    refresh();
                    return;
                  }
                  setError(null);
                  setView(next);
                }}
                colors={colors}
              />
            )
          )}
          {/* Kept from when it was last loaded: said quietly, with when. */}
          {list?.savedAt !== undefined && (
            <Text style={[styles.total, { color: colors.muted }]} accessibilityLiveRegion="polite">
              {offlineNote(list.savedAt, now)}
            </Text>
          )}
          {/* A refresh that failed says so above the list it couldn't update. */}
          {error && rows.length > 0 && (
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
        // Nothing under no rows: the empty view has its own Try again.
        rows.length === 0 ? undefined : (swipes.size > 0 ? retriesReload(swipes) : !!list?.next && !!error) ? (
          // A page, or the reload after a swipe, that failed: tried again here (the error is at the top).
          <Pressable onPress={() => void loadMore()} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.more, { opacity: pressed ? 0.6 : 1 }]}>
            <Text style={[styles.retry, { color: colors.primary, textAlign: "center" }]}>Try again</Text>
          </Pressable>
        ) : list?.next && list.savedAt === undefined ? (
          <ActivityIndicator style={styles.more} color={colors.muted} />
        ) : undefined
      }
    />
  );

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
              <Stack.Toolbar.MenuAction onPress={() => router.push("/notifications")}>Notifications</Stack.Toolbar.MenuAction>
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
        onChangeText={(event) => setTyped(event.nativeEvent.text)}
        onCancelButtonPress={() => setTyped("")}
        onClose={() => setTyped("")}
      />
      {/* The list under the same parent in both, so a fold or a resize keeps it (and where it's scrolled to). */}
      <View style={styles.panes}>
        <View style={wide ? [styles.listPane, { width: listWidth(width), borderRightColor: colors.border }] : styles.wholeList}>{listView}</View>
        {wide && (
          <View style={[styles.conversationPane, { backgroundColor: colors.card, paddingTop: Platform.OS === "ios" ? headerHeight : 0 }]} testID="conversation-pane">
            {chosen !== null ? (
              <ConversationPane number={chosen} onLeave={leave} />
            ) : (
              <View style={[styles.emptyBox, styles.emptyPane]}>
                <Text ref={emptyNote} style={[styles.empty, { color: colors.muted }]}>
                  Choose a conversation to read it here.
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
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
  panes: { flex: 1, flexDirection: "row" },
  listPane: { borderRightWidth: StyleSheet.hairlineWidth },
  conversationPane: { flex: 1 },
  wholeList: { flex: 1 },
  emptyPane: { flex: 1, justifyContent: "center" },
});
