import { router, useLocalSearchParams } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { getConversation } from "@/lib/conversation";
import {
  type Assignee,
  type Change,
  dayOf,
  getAssignees,
  getPerson,
  getTriage,
  isSnoozed,
  type Person,
  POST_STATUS,
  screenKey,
  showTriage,
  snoozeChoices,
  snoozeTime,
  STATUS_WORDS,
  subscribeTriage,
  updateConversation,
} from "@/lib/details";
import { useApi, useSession } from "@/lib/session";
import { type Colors, useColors } from "@/lib/theme";

const IOS = Platform.OS === "ios";

type Pane = "details" | "assign" | "snooze";

// The sheet over a conversation (its header opens it): who it's with, as the web's panel shows them, and assigning,
// snoozing, closing and spam. iOS's sheet, Android's bottom sheet (`_layout.tsx` sets its sizes).
export default function Details() {
  const { number: param } = useLocalSearchParams<{ number: string }>();
  const number = Number(param);
  const colors = useColors();
  const api = useApi();
  const { session } = useSession();
  const key = screenKey(session!, number);
  const triage = useSyncExternalStore(subscribeTriage, () => getTriage(key));
  const [person, setPerson] = useState<Person | null>(null);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  // Why something didn't load (who it's with, its status, the team), in the server's words: Try again loads it all.
  const [failures, setFailures] = useState<{ person?: string; conversation?: string; team?: string }>({});
  const failure = (part: "person" | "conversation" | "team", why: string | null) => setFailures((now) => ({ ...now, [part]: why ?? undefined }));
  const error = failures.person ?? failures.conversation ?? failures.team ?? null;
  const [pane, setPane] = useState<Pane>("details");
  const [busy, setBusy] = useState(false);
  // Why the latest change didn't happen, in the server's words.
  const [failed, setFailed] = useState<string | null>(null);

  // Changes made here so far: a fetch that started before one doesn't put back what it replaced.
  const changes = useRef(0);
  const load = useCallback(() => {
    getPerson(api, number).then(
      (loaded) => {
        setPerson(loaded);
        failure("person", null);
      },
      (e: Error) => failure("person", e.message),
    );
    getAssignees(api).then(
      (loaded) => {
        setAssignees(loaded);
        failure("team", null);
      },
      (e: Error) => failure("team", e.message),
    );
    // Its status as it is now (opened by a link, nothing under it has fetched it lately), unless a change here
    // answered meanwhile.
    const since = changes.current;
    getConversation(api, number).then(
      (loaded) => {
        if (changes.current === since) {
          showTriage(key, loaded);
        }
        failure("conversation", null);
      },
      (e: Error) => failure("conversation", e.message),
    );
  }, [api, number, key]);
  useEffect(load, [load]);

  // A list in place of the details: Android's back returns to them, rather than closing the sheet.
  useEffect(() => {
    if (pane === "details") {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setPane("details");
      return true;
    });
    return () => subscription.remove();
  }, [pane]);

  // VoiceOver has no live regions: said when it changes (TalkBack reads the live region).
  useEffect(() => {
    if (IOS && (failed || error)) {
      AccessibilityInfo.announceForAccessibility((failed ?? error)!);
    }
  }, [failed, error]);

  const change = async (body: Change, done: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const updated = await updateConversation(api, number, body);
      changes.current++;
      showTriage(key, updated);
      setPane("details");
      AccessibilityInfo.announceForAccessibility(done);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const you = assignees?.find((a) => a.you);
  const assignee = triage?.assignee;
  const assignedToYou = !!assignee && assignee.email.toLowerCase() === you?.email.toLowerCase();
  const canSnooze = !!triage && triage.status !== "closed" && !triage.spam;
  const snoozed = !!triage && isSnoozed(triage);
  const background = IOS ? colors.page : colors.card;

  if (pane === "assign") {
    return (
      <Choices title="Assign" colors={colors} background={background} busy={busy} failed={failed} onBack={() => setPane("details")}>
        {(assignees ?? []).map((a) => {
          const chosen = assignee?.email.toLowerCase() === a.email.toLowerCase();
          return (
            <Choice
              key={a.email}
              label={a.you ? "You" : a.name}
              detail={a.you ? a.name : undefined}
              chosen={chosen}
              colors={colors}
              onPress={() => (chosen ? setPane("details") : void change({ assignee: a.email }, a.you ? "Assigned to you" : `Assigned to ${a.name}`))}
            />
          );
        })}
        <Choice label="Unassigned" chosen={!assignee} colors={colors} onPress={() => (!assignee ? setPane("details") : void change({ assignee: null }, "Unassigned"))} />
      </Choices>
    );
  }
  if (pane === "snooze") {
    return (
      <Choices title="Snooze" colors={colors} background={background} busy={busy} failed={failed} onBack={() => setPane("details")}>
        {snoozeChoices().map(({ label, at }) => (
          <Choice key={label} label={label} colors={colors} onPress={() => void change({ snoozedUntil: at.toISOString() }, `Snoozed till ${snoozeTime(at)}`)} />
        ))}
        {snoozed && <Choice label="Wake now" colors={colors} onPress={() => void change({ snoozedUntil: null }, "Back in the inbox")} />}
      </Choices>
    );
  }

  const name = person ? (person.name ?? person.email ?? "Unknown") : "";
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.sheet}>
      {person ? (
        <View style={styles.who}>
          <View style={[styles.avatar, { backgroundColor: colors.soft }]}>
            <Text style={[styles.avatarText, { color: colors.onSoft }]}>{name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.whoText}>
            <Text style={[styles.name, { color: colors.text }]} accessibilityRole="header">
              {name}
            </Text>
            {person.email && (
              <Text style={[styles.detail, { color: colors.muted }]} selectable>
                {person.email}
                {!person.verified && " (not verified)"}
              </Text>
            )}
          </View>
        </View>
      ) : (
        !error && (
          <Text style={[styles.detail, styles.loading, { color: colors.muted }]} accessibilityLiveRegion="polite">
            Loading…
          </Text>
        )
      )}
      {error && (
        <View style={styles.loading}>
          <Text style={[styles.detail, { color: colors.error, textAlign: "center" }]} accessibilityLiveRegion="polite">
            {error}
          </Text>
          <TextButton label="Try again" colors={colors} onPress={load} />
        </View>
      )}
      {person && (
        <View style={styles.notes}>
          {person.blocked && <Note colors={colors}>Marked your email as spam, so replies aren&apos;t emailed to them any more.</Note>}
          {!person.account && <Note colors={colors}>Known only by this address.</Note>}
          {person.maybe && (
            <Note colors={colors}>
              Maybe {person.maybe.name} (not signed in){person.maybe.id && `, id ${person.maybe.id}`}
            </Note>
          )}
          {person.id && <Note colors={colors}>id {person.id}</Note>}
          {person.groups.length > 0 && (
            <View style={styles.groups}>
              {person.groups.map((group) => (
                <Text key={group.key} style={[styles.group, { backgroundColor: colors.secondary, color: colors.text }]}>
                  {group.name}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      <Group title="Conversation" colors={colors}>
        <Row
          label="Assignee"
          value={assignee ? `${assignee.name}${assignedToYou ? " (you)" : ""}` : triage ? "Unassigned" : ""}
          colors={colors}
          onPress={assignees && assignees.length > 0 ? () => setPane("assign") : undefined}
        />
        <Row label="Status" value={triage ? STATUS_WORDS[triage.status] : ""} dot={triage && (triage.status === "open" ? colors.onNote : colors.muted)} colors={colors} />
        <Row
          label="Snooze"
          value={!triage ? "" : snoozed ? `Snoozed till ${snoozeTime(new Date(triage.snoozedUntil!))}` : "Not snoozed"}
          colors={colors}
          onPress={canSnooze ? () => setPane("snooze") : undefined}
        />
        {triage && (
          <Row
            label={triage.status === "closed" ? "Reopen" : "Close"}
            action
            colors={colors}
            onPress={() => void (triage.status === "closed" ? change({ status: "open" }, "Reopened") : change({ status: "closed" }, "Closed"))}
          />
        )}
        {triage && (
          <Row
            label={triage.spam ? "Not spam" : "Mark as spam"}
            action
            danger={!triage.spam}
            colors={colors}
            onPress={() => void change({ spam: !triage.spam }, triage.spam ? "Moved back to the inbox" : "Marked as spam")}
          />
        )}
      </Group>
      {busy && <ActivityIndicator style={styles.busy} color={colors.muted} />}
      {failed && (
        <Text style={[styles.detail, styles.pad, { color: colors.error }]} accessibilityLiveRegion="polite">
          {failed}
        </Text>
      )}

      {person && person.properties.length > 0 && (
        <Group title="Properties" colors={colors}>
          {person.properties.map((property) => (
            <Row key={property.key} label={property.label} value={property.text} colors={colors} />
          ))}
        </Group>
      )}
      {person?.account && (
        <>
          <Group title="Posts" count={person.postCount} colors={colors}>
            {person.posts.length === 0 ? <Empty text="No posts." colors={colors} /> : person.posts.map((post) => <Row key={post.number} label={post.title} value={POST_STATUS[post.status]} colors={colors} />)}
          </Group>
          <Group title="Votes" count={person.voteCount} colors={colors}>
            {person.votes.length === 0 ? (
              <Empty text="No votes on others' posts." colors={colors} />
            ) : (
              person.votes.map((post) => <Row key={post.number} label={post.title} value={POST_STATUS[post.status]} colors={colors} />)
            )}
          </Group>
        </>
      )}
      {person && (
        <Group title="Other conversations" count={person.conversationCount} colors={colors}>
          {person.conversations.length === 0 ? (
            <Empty text="None." colors={colors} />
          ) : (
            person.conversations.map((other) => (
              <Pressable
                key={other.number}
                onPress={() => {
                  router.back();
                  router.push(`/conversation/${other.number}`);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${other.subject}, #${other.number}, ${STATUS_WORDS[other.status]}, ${dayOf(other.lastMessageAt)}`}
                accessibilityHint={other.line ?? undefined}
                android_ripple={{ color: colors.border }}
                style={({ pressed }) => [styles.other, IOS && pressed && { backgroundColor: colors.secondary }]}
              >
                <Text style={[styles.meta, { color: colors.muted }]}>
                  {dayOf(other.lastMessageAt)} · {STATUS_WORDS[other.status]} · #{other.number}
                </Text>
                <Text style={[styles.otherSubject, { color: colors.text }]}>{other.subject}</Text>
                {other.line && (
                  <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>
                    {other.line}
                  </Text>
                )}
              </Pressable>
            ))
          )}
        </Group>
      )}
    </ScrollView>
  );
}

/** A part of the sheet: iOS's grouped rows on a card, Android's under a heading in the primary colour. */
function Group({ title, count, colors, children }: { title: string; count?: number; colors: Colors; children: ReactNode }) {
  return (
    <View>
      <Text style={[styles.heading, IOS ? { color: colors.muted } : { color: colors.primary, fontWeight: "500" }]} accessibilityRole="header">
        {title}
        {count ? ` · ${count}` : ""}
      </Text>
      <View style={IOS ? [styles.card, { backgroundColor: colors.card }] : undefined}>{children}</View>
    </View>
  );
}

/** A label and its value; with `onPress`, a row that opens choices (›), or with `action`, one that acts. */
function Row({
  label,
  value,
  dot,
  action = false,
  danger = false,
  colors,
  onPress,
}: {
  label: string;
  value?: string;
  dot?: string | null;
  action?: boolean;
  danger?: boolean;
  colors: Colors;
  onPress?: () => void;
}) {
  const content = (
    <>
      <Text style={[styles.label, { color: action ? (danger ? colors.error : colors.primary) : colors.text }, !action && value !== undefined && styles.labelBeside]}>{label}</Text>
      {value !== undefined && (
        <View style={styles.value}>
          {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
          <Text style={[styles.valueText, { color: colors.muted }]}>{value}</Text>
        </View>
      )}
      {onPress && !action && <Icon name={{ ios: "chevron.right", android: "chevron_right" }} size={14} color={colors.muted} />}
    </>
  );
  const style = [styles.row, IOS && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }];
  return onPress ? (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      android_ripple={{ color: colors.border }}
      style={({ pressed }) => [...style, IOS && pressed && { backgroundColor: colors.secondary }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={style} accessible accessibilityLabel={value ? `${label}, ${value}` : label}>
      {content}
    </View>
  );
}

/** A list of choices in place of the details (assign, snooze), with Back. */
function Choices({ title, colors, background, busy, failed, onBack, children }: { title: string; colors: Colors; background: string; busy: boolean; failed: string | null; onBack: () => void; children: ReactNode }) {
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.sheet}>
      <View style={styles.bar}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10} style={styles.back}>
          <Icon name={{ ios: "chevron.left", android: "arrow_back" }} size={IOS ? 17 : 22} color={IOS ? colors.primary : colors.text} />
          {IOS && <Text style={[styles.label, { color: colors.primary }]}>Back</Text>}
        </Pressable>
        <Text style={[styles.barTitle, { color: colors.text }]} accessibilityRole="header">
          {title}
        </Text>
        {busy && <ActivityIndicator color={colors.muted} />}
      </View>
      {failed && (
        <Text style={[styles.detail, styles.pad, { color: colors.error }]} accessibilityLiveRegion="polite">
          {failed}
        </Text>
      )}
      <View style={IOS ? [styles.card, { backgroundColor: colors.card }] : undefined}>{children}</View>
    </ScrollView>
  );
}

function Choice({ label, detail, chosen = false, colors, onPress }: { label: string; detail?: string; chosen?: boolean; colors: Colors; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: chosen }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      android_ripple={{ color: colors.border }}
      style={({ pressed }) => [
        styles.row,
        IOS ? { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth } : [{ paddingRight: 16, borderRadius: 28 }, chosen && { backgroundColor: colors.soft }],
        IOS && pressed && { backgroundColor: colors.secondary },
      ]}
    >
      <View style={styles.choiceText}>
        <Text style={[styles.label, { color: !IOS && chosen ? colors.onSoft : colors.text }]}>{label}</Text>
        {detail && <Text style={[styles.meta, { color: colors.muted }]}>{detail}</Text>}
      </View>
      {chosen && <Icon name={{ ios: "checkmark", android: "check" }} size={16} color={IOS ? colors.primary : colors.onSoft} />}
    </Pressable>
  );
}

function Note({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <Text style={[styles.meta, { color: colors.muted }]}>{children}</Text>;
}

function Empty({ text, colors }: { text: string; colors: Colors }) {
  return <Text style={[styles.detail, styles.empty, { color: colors.muted }]}>{text}</Text>;
}

function Icon({ name, size, color }: { name: SymbolViewProps["name"]; size: number; color: string }) {
  return <SymbolView name={name} size={size} tintColor={color} />;
}

function TextButton({ label, colors, onPress }: { label: string; colors: Colors; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
      <Text style={[styles.label, { color: colors.primary, fontWeight: "600" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: 16, paddingTop: IOS ? 20 : 8, paddingBottom: 40 },
  loading: { alignItems: "center", gap: 10, paddingVertical: 24 },
  who: { flexDirection: "row", alignItems: "center", gap: 12 },
  whoText: { flexShrink: 1, gap: 2 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 20, fontWeight: "600" },
  name: { fontSize: 18, fontWeight: "600" },
  detail: { fontSize: 14 },
  notes: { gap: 4, marginTop: 8, paddingLeft: 60 },
  groups: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  group: { fontSize: 12.5, fontWeight: "500", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: "hidden" },
  heading: { fontSize: 13, marginTop: 20, marginBottom: 6, marginHorizontal: IOS ? 4 : 0 },
  card: { borderRadius: 12, paddingLeft: 14, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 10, paddingRight: IOS ? 12 : 0 },
  label: { fontSize: 16 },
  labelBeside: { flexShrink: 1 },
  value: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 },
  valueText: { fontSize: 16, textAlign: "right", flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  meta: { fontSize: 13, lineHeight: 18 },
  other: { gap: 2, paddingVertical: 10, paddingRight: IOS ? 12 : 0 },
  otherSubject: { fontSize: 15, fontWeight: "600" },
  empty: { paddingVertical: 12 },
  busy: { marginTop: 10 },
  pad: { paddingTop: 8, paddingHorizontal: 4 },
  bar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, marginBottom: 12 },
  back: { flexDirection: "row", alignItems: "center", gap: 4 },
  barTitle: { fontSize: 17, fontWeight: "600", flex: 1 },
  choiceText: { flex: 1, gap: 1, paddingLeft: IOS ? 0 : 16 },
});
