import { SymbolView } from "expo-symbols";
import { memo, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { ageOf, initialsOf, lineOf, personOf, type Row, searchAgeOf, spokenAgeOf, STATUS } from "@/lib/inbox";
import { type Colors } from "@/lib/theme";

// A person's face colour (the theme's `faces`): the same one each time.
const faceOf = (name: string, faces: string[]) => faces[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % faces.length]!;

// The row swiped open, closed when another opens, as Mail's.
let swiped: SwipeableMethods | null = null;

type Props = {
  row: Row;
  colors: Colors;
  q: string;
  now: number;
  onPress: (row: Row) => void;
  onSnooze?: (row: Row) => void;
  onClose?: (row: Row) => void;
  /** Open beside the list (a wide window). */
  selected?: boolean;
};

/**
 * One conversation in the Inbox: who, their company and how long ago; the subject; the latest message (or the match);
 * unread in bold with a dot. Swiped left, Snooze and Close (each when given); a screen reader has them as its actions.
 */
export const InboxRow = memo(function InboxRow({ row, colors, q, now, onPress, onSnooze, onClose, selected = false }: Props) {
  const swipe = useRef<SwipeableMethods>(null);
  const actions = [
    onSnooze && { name: "snooze", label: "Snooze", icon: { ios: "clock", android: "schedule" } as const, ink: colors.onFace, background: colors.snooze, run: onSnooze },
    onClose && { name: "close", label: "Close", icon: { ios: "checkmark", android: "check" } as const, ink: colors.onPrimary, background: colors.primary, run: onClose },
  ].filter((action) => !!action);
  const pressable = <RowBody row={row} colors={colors} q={q} now={now} onPress={onPress} actions={actions} selected={selected} />;
  if (!actions.length) {
    return pressable;
  }
  return (
    <Swipeable
      ref={swipe}
      friction={1.5}
      rightThreshold={40}
      overshootRight={false}
      onSwipeableWillOpen={() => {
        if (swiped !== swipe.current) {
          swiped?.close();
        }
        swiped = swipe.current;
      }}
      onSwipeableClose={() => {
        if (swiped === swipe.current) {
          swiped = null;
        }
      }}
      renderRightActions={() => (
        // Behind the row: a screen reader has them as the row's actions instead.
        <View style={styles.actions} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {actions.map((action) => (
            <Pressable
              key={action.name}
              onPress={() => {
                swipe.current?.close();
                action.run(row);
              }}
              style={({ pressed }) => [styles.action, { backgroundColor: action.background, opacity: pressed ? 0.8 : 1 }]}
            >
              <SymbolView name={action.icon} size={22} tintColor={action.ink} />
              <Text style={[styles.actionText, { color: action.ink }]}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    >
      {pressable}
    </Swipeable>
  );
});

function RowBody({ row, colors, q, now, onPress, actions, selected }: Omit<Props, "onSnooze" | "onClose"> & { actions: { name: string; label: string; run: (row: Row) => void }[] }) {
  const person = personOf(row);
  const line = lineOf(row);
  const weight = row.unread ? "700" : "400";
  return (
    <Pressable
      onPress={() => onPress(row)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityActions={actions.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={(event) => actions.find((action) => action.name === event.nativeEvent.actionName)?.run(row)}
      // Read as the web's row: who, what and which, who has it, and (in words) how long ago; in a search, its status too.
      accessibilityLabel={`${row.unread ? "Unread, " : ""}${person}${row.company ? `, ${row.company}` : ""}: ${row.subject} (#${row.number})${row.assignee ? `, assigned to ${row.assignee.name}` : ""}${q ? `, ${STATUS[row.status]}` : ""}, latest message ${spokenAgeOf(row.lastMessageAt, now)}`}
      accessibilityHint={line ?? undefined}
      android_ripple={{ color: colors.border }}
      // Opaque, over the actions behind it.
      // The one open beside the list in the soft colour, as the mockup's tablet.
      style={({ pressed }) => [styles.row, { backgroundColor: selected ? colors.soft : Platform.OS === "ios" && pressed ? colors.secondary : colors.page }]}
    >
      <View style={[styles.dot, row.unread && { backgroundColor: colors.primary }]} />
      <View style={[styles.face, { backgroundColor: faceOf(person, colors.faces) }]}>
        <Text style={[styles.initials, { color: colors.onFace }]}>{initialsOf(person)}</Text>
      </View>
      <View style={[styles.body, Platform.OS === "ios" && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
        <View style={styles.top}>
          <Text style={[styles.person, { color: colors.text, fontWeight: row.unread ? "700" : "500" }]} numberOfLines={1}>
            {person}
          </Text>
          {row.company && (
            <Text style={[styles.company, { color: colors.muted }]} numberOfLines={1}>
              {row.company}
            </Text>
          )}
          <Text style={[styles.age, { color: row.unread ? colors.primary : colors.muted, fontWeight: row.unread ? "600" : "400" }]}>{q ? searchAgeOf(row, now) : ageOf(row.lastMessageAt, now)}</Text>
        </View>
        <Text style={[styles.subject, { color: colors.text, fontWeight: weight }]} numberOfLines={1}>
          {row.subject}
        </Text>
        <View style={styles.bottom}>
          <Text style={[styles.line, { color: colors.muted }]} numberOfLines={1}>
            {line ? <Marked text={line} q={q} colors={colors} /> : " "}
          </Text>
          {row.assignee && (
            <View style={[styles.assignee, { backgroundColor: faceOf(row.assignee.name, colors.faces) }]}>
              <Text style={[styles.assigneeInitial, { color: colors.onFace }]}>{initialsOf(row.assignee.name).slice(0, 1)}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** The search's words marked in the line that matched, as the web's search results. */
function Marked({ text, q, colors }: { text: string; q: string; colors: Colors }) {
  if (!q) {
    return text;
  }
  // Split on the search text, whatever the case: odd parts are the matches.
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"));
  return parts.map((part, i) =>
    i % 2 ? (
      <Text key={i} style={{ backgroundColor: colors.soft, color: colors.text }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, paddingLeft: 6, paddingTop: Platform.OS === "ios" ? 10 : 12 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 16 },
  face: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  initials: { fontWeight: "600", fontSize: 14 },
  body: { flex: 1, minWidth: 0, paddingRight: 16, paddingBottom: Platform.OS === "ios" ? 10 : 12, gap: 1 },
  top: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  person: { fontSize: 16, flexShrink: 1 },
  company: { fontSize: 14, flexShrink: 2 },
  age: { fontSize: 13, marginLeft: "auto", paddingLeft: 6 },
  subject: { fontSize: 15 },
  bottom: { flexDirection: "row", alignItems: "center", gap: 8 },
  line: { fontSize: 14, flex: 1 },
  assignee: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  assigneeInitial: { fontSize: 10, fontWeight: "600" },
  actions: { flexDirection: "row" },
  action: { width: 76, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { fontSize: 12, fontWeight: "500" },
});
