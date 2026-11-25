import { memo } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { ageOf, initialsOf, lineOf, personOf, type Row, searchAgeOf } from "@/lib/inbox";
import { type Colors } from "@/lib/theme";

// The faces' colours, as the mockups and the web's avatars: one per person, the same each time.
const FACES = ["#925651", "#83623a", "#456f4e", "#356d73", "#486491", "#785480"];
const faceOf = (name: string) => FACES[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % FACES.length]!;

/** One conversation in the Inbox: who, their company and how long ago; the subject; the latest message (or the match); unread in bold with a dot. */
export const InboxRow = memo(function InboxRow({ row, colors, q, now, onPress }: { row: Row; colors: Colors; q: string; now: number; onPress: (row: Row) => void }) {
  const person = personOf(row);
  const line = lineOf(row);
  const weight = row.unread ? "700" : "400";
  return (
    <Pressable
      onPress={() => onPress(row)}
      accessibilityRole="button"
      // Read as the web's row: who, what and which, and who has it.
      accessibilityLabel={`${row.unread ? "Unread, " : ""}${person}${row.company ? `, ${row.company}` : ""}: ${row.subject} (#${row.number})${row.assignee ? `, assigned to ${row.assignee.name}` : ""}`}
      accessibilityHint={line ?? undefined}
      android_ripple={{ color: colors.border }}
      style={({ pressed }) => [styles.row, Platform.OS === "ios" && pressed && { backgroundColor: colors.secondary }]}
    >
      <View style={[styles.dot, row.unread && { backgroundColor: colors.primary }]} />
      <View style={[styles.face, { backgroundColor: faceOf(person) }]}>
        <Text style={styles.initials}>{initialsOf(person)}</Text>
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
            <View style={[styles.assignee, { backgroundColor: faceOf(row.assignee.name) }]}>
              <Text style={styles.assigneeInitial}>{initialsOf(row.assignee.name).slice(0, 1)}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
});

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
  initials: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  body: { flex: 1, minWidth: 0, paddingRight: 16, paddingBottom: Platform.OS === "ios" ? 10 : 12, gap: 1 },
  top: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  person: { fontSize: 16, flexShrink: 1 },
  company: { fontSize: 14, flexShrink: 2 },
  age: { fontSize: 13, marginLeft: "auto", paddingLeft: 6 },
  subject: { fontSize: 15 },
  bottom: { flexDirection: "row", alignItems: "center", gap: 8 },
  line: { fontSize: 14, flex: 1 },
  assignee: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  assigneeInitial: { color: "#ffffff", fontSize: 10, fontWeight: "600" },
});
