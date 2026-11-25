import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { openBrowserAsync } from "expo-web-browser";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Conversation,
  delivery,
  type Draft,
  draftsGeneration,
  draftWithAi,
  canEdit,
  EDIT_FIRST,
  FIRST_SENT,
  newlyKept,
  unsentKey,
  queueUnsent,
  typed,
  unsentId,
  editUnsent,
  afterFetch,
  afterSend,
  attach as attachFile,
  clearUploadFailure,
  getDraft,
  getUploadFailure,
  getUploading,
  droppedLine,
  fileSize,
  getConversation,
  isImage,
  isOnline,
  composerInset,
  isSending,
  linkParts,
  markReadIfLooking,
  type Message,
  personName,
  type Picked,
  runsOn,
  sendUnsent,
  subscribeDraft,
  type Unsent,
  updateDraft,
  watchLive,
  withDraft,
  writer,
  writtenAt,
} from "@/lib/conversation";
import { getTriage, holdTriage, screenKey, showTriage, standing, subscribeTriage, type Triage, triageChanges } from "@/lib/details";
import { lookAt } from "@/lib/notifications";
import { cached, cacheGeneration, conversationKey, isOffline, keep as keepCached, offlineNote, useMinutes } from "@/lib/offline";
import { useApi, useSession } from "@/lib/session";
import { type Colors, useColors } from "@/lib/theme";

type Kind = "reply" | "note";
type Row = { message: Message; index: number } | { unsent: Unsent };

const IOS = Platform.OS === "ios";

// A conversation, opened from the Inbox or a link (`tuti://conversation/12`), in the signed-in teammate's project.
export default function ConversationRoute() {
  const { number } = useLocalSearchParams<{ number: string }>();
  const { session } = useSession();
  // One screen per conversation: its draft is read once, and goes with it.
  const key = screenKey(session!, number);
  return <ConversationScreen key={key} number={Number(number)} draftKey={key} />;
}

function ConversationScreen({ number, draftKey }: { number: number; draftKey: string }) {
  const colors = useColors();
  const api = useApi();
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown as it was kept on the phone, with no connection: when it was last loaded.
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // What's being written, kept on the phone as it's typed (and by sends and uploads that finish after the screen's gone).
  const draft = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDraft(draftKey, listener), [draftKey]),
    () => getDraft(draftKey),
  );
  const setDraft = useCallback((change: (draft: Draft) => Draft, since?: number) => updateDraft(draftKey, change, since), [draftKey]);
  // An edit kept because its first version had already gone out (a 409, or a fetch), said with why on both platforms: "Not
  // sent" alone sounds like the network, and Retry would send a second reply. TalkBack's live region doesn't speak it.
  const shownUnsent = useRef(draft.unsent);
  useEffect(() => {
    if (newlyKept(shownUnsent.current, draft.unsent).length > 0) {
      AccessibilityInfo.announceForAccessibility(`Not sent: ${FIRST_SENT}`);
    }
    shownUnsent.current = draft.unsent;
  }, [draft.unsent]);
  // On screen (not under another one pushed over it): it's read only while it's looked at.
  const focused = useRef(false);
  // The newest fetch wins: an older one answering late doesn't put back what it had. Rejects when it can't (the screen's
  // own calls go through `refresh`).
  const asked = useRef(0);
  // When what's shown last came from the server (null: it didn't): offline, it stays (what was kept may be older), said
  // to be offline since then.
  const loadedAt = useRef<number | null>(null);
  const [now] = useMinutes();
  const load = useCallback((): Promise<Conversation> => {
    const ask = ++asked.current;
    const since = draftsGeneration();
    const triageSince = triageChanges(draftKey);
    const cacheSince = cacheGeneration();
    const cacheKey = conversationKey(session!, number);
    return getConversation(api, number).then(
      (loaded) => {
        // A reply whose id a message has arrived (its answer lost): gone, from any fetch (that's never stale), but not
        // into the next teammate's drafts if they signed out meanwhile.
        afterFetch(draftKey, loaded, since);
        if (ask === asked.current) {
          setConversation(loaded);
          loadedAt.current = Date.now();
          // Not over a change the details sheet made while this was on its way.
          showTriage(draftKey, loaded, triageSince);
          setError(null);
          setSavedAt(null);
          keepCached(cacheKey, loaded, cacheSince, session!.owner);
          markReadIfLooking(api, loaded, focused.current && AppState.currentState === "active");
        }
        return loaded;
      },
      (e: Error) => {
        if (ask === asked.current) {
          // No connection: what's shown stays, or it's as it was last kept, if it was, saying so.
          const saved = isOffline(e) ? cached<Conversation>(cacheKey, session!.owner) : null;
          if (isOffline(e) && loadedAt.current !== null) {
            setSavedAt(loadedAt.current);
            setError(null);
          } else if (saved) {
            setConversation(saved.data);
            showTriage(draftKey, saved.data, triageSince);
            setSavedAt(saved.at);
            setError(null);
          } else {
            setError(e.message);
          }
        }
        throw e;
      },
    );
  }, [api, number, draftKey, session]);
  const refresh = useCallback(() => void load().catch(() => {}), [load]);
  // VoiceOver has no live regions: a failed fetch is announced (TalkBack reads the live region), and so is showing what
  // was kept.
  useEffect(() => {
    if (error && IOS) {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);
  useEffect(() => {
    if (savedAt !== null && IOS) {
      AccessibilityInfo.announceForAccessibility(offlineNote(savedAt));
    }
  }, [savedAt]);

  // Live while it's on screen and the app is in front: the stream says when it changed (and opening it fetches it).
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || !session) {
      return;
    }
    return watchLive(session, (changed) => {
      if (changed === null || changed === number) {
        refresh();
      }
    });
  }, [active, session, number, refresh]);
  // Fetched as it comes on screen, the first time and when a screen over it closes (the stream may have said nothing
  // since): what's unread then is read, as it's looked at.
  const project = session?.project;
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      refresh();
      // Its notifications don't show over it.
      const away = project ? lookAt({ project, number }) : () => {};
      return () => {
        focused.current = false;
        away();
      };
    }, [refresh, project, number]),
  );
  // The keyboard covers the home indicator: no space kept for it under the composer then.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener(IOS ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener(IOS ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // Its status and assignee, as the details sheet over it changes them too.
  const triage = useSyncExternalStore(subscribeTriage, () => getTriage(draftKey));
  useEffect(() => holdTriage(draftKey), [draftKey]);
  const details = () => router.push(`/conversation/${number}/details`);

  const [kind, setKind] = useState<Kind>("reply");
  // Files uploading, also those started before the screen was opened again.
  const uploading = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDraft(draftKey, listener), [draftKey]),
    () => getUploading(draftKey),
  );
  const [drafting, setDrafting] = useState(false);
  // Draft with AI's answer, or what a send's answer says (kept open).
  const [aiNotice, setNotice] = useState<string | null>(null);
  // Why the latest upload failed, whichever screen picked the file: said here till the next pick or a send.
  const uploadFailure = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDraft(draftKey, listener), [draftKey]),
    () => getUploadFailure(draftKey),
  );
  // Both said, each on its line: neither hides the other.
  const notice = [uploadFailure, aiNotice].filter(Boolean).join("\n") || null;
  useEffect(() => {
    if (notice && IOS) {
      AccessibilityInfo.announceForAccessibility(notice);
    }
  }, [notice]);

  const deliver = async (unsent: Unsent) => {
    const sent = await sendUnsent(api, draftKey, number, unsent, load);
    if (!sent) {
      // An edit kept as its first version had gone out is said by the effect below, with why; a reply that went but
      // wasn't closed says so (its error), never "Not sent".
      const left = getDraft(draftKey).unsent.find((one) => unsentKey(one) === unsentKey(unsent));
      if (IOS && left?.error !== FIRST_SENT) {
        AccessibilityInfo.announceForAccessibility(left?.closeOnly && left.error ? left.error : "Not sent");
      }
    } else {
      const { leave, notice } = afterSend(sent, focused.current);
      if (leave && router.canGoBack()) {
        // Answered and closed: done with, back to the Inbox.
        router.back();
      } else if (notice) {
        // Not closed after all: said here (and announced), as the web does.
        setNotice(notice);
      }
    }
  };

  const text = draft[kind];
  // Not before it's loaded: a reply says what it answers (`seen`), which closing it depends on.
  const canSend = !!conversation && !!text.trim() && uploading.length === 0;
  const send = (close = false) => {
    if (!canSend) {
      return;
    }
    const unsent: Unsent = {
      id: unsentId(draft, kind),
      body: text.trim(),
      note: kind === "note",
      close: close && kind === "reply",
      files: draft.files,
      seen: conversation!.messages.at(-1)?.createdAt ?? null,
    };
    setNotice(null);
    clearUploadFailure(draftKey);
    setDraft((now) => queueUnsent(now, kind, unsent));
    void deliver(unsent);
  };
  const discard = (unsent: Unsent) => setDraft((now) => ({ ...now, unsent: now.unsent.filter((one) => one.id !== unsent.id) }));
  // Back into the composer, with its files, to change what the server refused (too many files, one gone).
  const edit = (unsent: Unsent) => {
    if (!canEdit(draft, unsent, uploading.length)) {
      setNotice(EDIT_FIRST);
      return;
    }
    setDraft((now) => editUnsent(now, unsent));
    setKind(unsent.note ? "note" : "reply");
  };

  const attachPicked = (picked: Picked | null) => {
    if (!picked) {
      return;
    }
    setNotice(null);
    void attachFile(api, draftKey, picked);
  };
  const pickPhoto = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      // JPEG rather than HEIC: what every browser shows.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    const asset = picked.assets?.[0];
    attachPicked(
      asset
        ? { uri: asset.uri, name: asset.fileName ?? asset.uri.split("/").pop() ?? "photo.jpg", contentType: asset.mimeType ?? "image/jpeg", size: asset.fileSize ?? 0 }
        : null,
    );
  };
  const pickFile = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = picked.assets?.[0];
    attachPicked(asset ? { uri: asset.uri, name: asset.name, contentType: asset.mimeType ?? "application/octet-stream", size: asset.size ?? 0 } : null);
  };

  const suggest = async () => {
    if (drafting) {
      return;
    }
    setDrafting(true);
    setNotice(null);
    const since = draftsGeneration();
    const result = await draftWithAi(api, number);
    setDrafting(false);
    if ("draft" in result) {
      setDraft((now) => ({ ...now, reply: withDraft(now.reply, result.draft) }), since);
      setKind("reply");
    } else {
      setNotice(result.notice);
    }
  };

  const person = conversation ? personName(conversation.user) : "";
  const rows: Row[] = conversation
    ? [...draft.unsent.map((unsent) => ({ unsent })).reverse(), ...conversation.messages.map((message, index) => ({ message, index })).reverse()]
    : [];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.card }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          title: person,
          headerLargeTitleEnabled: false,
          headerStyle: { backgroundColor: colors.card },
          headerShadowVisible: true,
          headerTitle: conversation ? () => <Person conversation={conversation} colors={colors} onPress={details} /> : "",
          // Once this screen's fetch has answered: what's kept from an earlier visit may be out of date.
          headerRight: triage && conversation ? () => <Standing triage={triage} colors={colors} onPress={details} /> : undefined,
        }}
      />
      {!conversation ? (
        <View style={styles.center}>
          <Text style={[styles.body, { color: error ? colors.error : colors.muted, textAlign: "center" }]} accessibilityLiveRegion="polite">
            {error ?? "Loading…"}
          </Text>
          {error && <TextButton colors={colors} label="Try again" onPress={refresh} />}
        </View>
      ) : (
        <FlatList
          inverted
          data={rows}
          // An unsent reply by its first id: given a new one (an edit kept), it's the same bubble, and keeps a reader's place.
          keyExtractor={(row) => ("unsent" in row ? unsentKey(row.unsent) : row.message.id)}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.messages}
          // Inverted: the footer is the top, the header the bottom.
          ListFooterComponent={
            <View style={styles.subject}>
              <Text style={[styles.subjectText, { color: colors.text }]} accessibilityRole="header">
                {conversation.subject}
              </Text>
              <Text style={[styles.meta, { color: colors.muted }]}>#{conversation.number}</Text>
            </View>
          }
          ListHeaderComponent={
            error ? (
              <Text style={[styles.meta, styles.stale, { color: colors.error }]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            ) : savedAt !== null ? (
              // Kept from when it was last loaded: said quietly, with when.
              <Text style={[styles.meta, styles.stale, { color: colors.muted }]} accessibilityLiveRegion="polite">
                {offlineNote(savedAt, now)}
              </Text>
            ) : undefined
          }
          renderItem={({ item }) =>
            "unsent" in item ? (
              <UnsentBubble
                unsent={item.unsent}
                sending={isSending(item.unsent.id)}
                colors={colors}
                onRetry={() => void deliver(item.unsent)}
                onEdit={() => edit(item.unsent)}
                onDiscard={() => discard(item.unsent)}
              />
            ) : (
              <Bubble message={item.message} person={person} runs={runsOn(conversation.messages, item.index, person)} colors={colors} />
            )
          }
        />
      )}

      <View style={{ paddingBottom: composerInset(insets.bottom, keyboard) + 8 }}>
      <View style={[IOS ? styles.composerIos : styles.composerAndroid, IOS ? { borderColor: colors.border, backgroundColor: kind === "note" ? colors.note : colors.card } : { backgroundColor: kind === "note" ? colors.note : colors.secondary }]}>
        <View style={[styles.tabs, { borderBottomColor: colors.border }]} accessibilityRole="tablist">
          {(["reply", "note"] as const).map((tab) => (
            <Pressable
              key={tab}
              onPress={() => setKind(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected: kind === tab }}
              hitSlop={6}
              style={[styles.tab, kind === tab && { borderBottomColor: tab === "note" ? colors.onNote : colors.primary }]}
            >
              <Text style={[styles.tabText, { color: kind === tab ? colors.text : colors.muted }]}>{tab === "reply" ? "Reply" : "Note"}</Text>
            </Pressable>
          ))}
        </View>
        {(draft.files.length > 0 || uploading.length > 0) && (
          <View style={styles.files}>
            {draft.files.map((file) => (
              <View key={file.id} style={[styles.chip, { backgroundColor: colors.page, borderColor: colors.border }]}>
                <Text style={[styles.meta, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
                  {file.name}
                </Text>
                <Pressable
                  onPress={() => setDraft((now) => ({ ...now, files: now.files.filter((one) => one.id !== file.id) }))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  hitSlop={10}
                >
                  <Icon name={{ ios: "xmark", android: "close" }} size={14} color={colors.muted} />
                </Pressable>
              </View>
            ))}
            {uploading.map(({ id, name }) => (
              <View key={id} style={[styles.chip, { backgroundColor: colors.page, borderColor: colors.border }]}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={[styles.meta, { color: colors.muted, flexShrink: 1 }]} numberOfLines={1}>
                  {name}
                </Text>
              </View>
            ))}
          </View>
        )}
        <TextInput
          value={text}
          onChangeText={(text) => setDraft((now) => typed(now, kind, text))}
          placeholder={kind === "note" ? "Write a note only your team sees…" : "Write a reply…"}
          placeholderTextColor={colors.muted}
          accessibilityLabel={kind === "note" ? "Note" : "Reply"}
          multiline
          style={[styles.input, { color: colors.text }]}
        />
        <View style={styles.tools}>
          <IconButton
            label="Attach a photo or file"
            icon={{ ios: "paperclip", android: "attach_file" }}
            colors={colors}
            onPress={() =>
              menu(
                [
                  { label: "Photo", onPress: () => void pickPhoto() },
                  { label: "File", onPress: () => void pickFile() },
                ],
                "Attach",
              )
            }
          />
          <Pressable
            onPress={() => void suggest()}
            accessibilityRole="button"
            accessibilityState={{ busy: drafting }}
            style={({ pressed }) => [styles.draft, { backgroundColor: colors.soft, opacity: pressed || drafting ? 0.6 : 1 }]}
          >
            {drafting ? <ActivityIndicator size="small" color={colors.onSoft} /> : <Icon name={{ ios: "sparkles", android: "auto_awesome" }} size={14} color={colors.onSoft} />}
            <Text style={[styles.draftText, { color: colors.onSoft }]}>{drafting ? "Drafting…" : "Draft with AI"}</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => send()}
            // Holding Send offers Send and close (a reply only).
            onLongPress={kind === "reply" && canSend ? () => menu([{ label: "Send and close", onPress: () => send(true) }]) : undefined}
            accessibilityRole="button"
            accessibilityLabel={kind === "note" ? "Add note" : "Send"}
            accessibilityState={{ disabled: !canSend }}
            accessibilityActions={kind === "reply" ? [{ name: "longpress", label: "Send and close" }] : undefined}
            onAccessibilityAction={(event) => event.nativeEvent.actionName === "longpress" && send(true)}
            style={({ pressed }) => [styles.send, { backgroundColor: colors.primary, opacity: !canSend ? 0.4 : pressed ? 0.7 : 1 }]}
          >
            <Icon name={{ ios: "arrow.up", android: "send" }} size={18} color={colors.onPrimary} />
          </Pressable>
        </View>
      </View>
      {notice && (
        <Text style={[styles.meta, styles.notice, { color: colors.muted }]} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** Who it's with, in the header: their initial, name, and Online and their company under it. Opens the details. */
function Person({ conversation, colors, onPress }: { conversation: Conversation; colors: Colors; onPress: () => void }) {
  const name = personName(conversation.user);
  const online = isOnline(conversation.onlineUntil);
  const about = [online && "Online", conversation.company].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      style={styles.person}
      accessible
      accessibilityRole="header"
      accessibilityLabel={[name, about].filter(Boolean).join(", ")}
      accessibilityHint="Shows who they are"
    >
      <View style={[styles.avatar, { backgroundColor: colors.soft }]}>
        <Text style={[styles.avatarText, { color: colors.onSoft }]}>{name.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text style={[styles.personName, { color: colors.text }]} numberOfLines={1}>
          {name}
        </Text>
        {about ? (
          <View style={styles.about}>
            {online && <View style={[styles.dot, { backgroundColor: colors.primary }]} />}
            <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>
              {about}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Where it stands and who has it, in the header (the status a Send and close or a kept-open reply changes). Opens the details. */
function Standing({ triage, colors, onPress }: { triage: Triage; colors: Colors; onPress: () => void }) {
  const word = standing(triage);
  const assignee = triage.assignee?.name;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${word}, ${assignee ? `assigned to ${assignee}` : "unassigned"}, details`}
      hitSlop={6}
      style={({ pressed }) => [styles.standing, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={[styles.dot, { backgroundColor: word === "Open" ? colors.onNote : colors.muted }]} />
      <Text style={[styles.standingText, { color: colors.text }]}>{word}</Text>
      {assignee ? (
        <View style={[styles.face, { backgroundColor: colors.soft }]}>
          <Text style={[styles.faceText, { color: colors.onSoft }]}>{assignee.slice(0, 1).toUpperCase()}</Text>
        </View>
      ) : (
        <Icon name={{ ios: "person.badge.plus", android: "person_add" }} size={18} color={colors.muted} />
      )}
    </Pressable>
  );
}

/** A message as the web's Inbox shows it: the user's on the left, the team's on the right in green, notes in the note colour. */
function Bubble({ message, person, runs, colors }: { message: Message; person: string; runs: boolean; colors: Colors }) {
  const fromTeam = message.author !== "user";
  const who = writer(message, person);
  const sent = delivery(message);
  const tone = message.note ? colors.text : fromTeam ? colors.onPrimary : colors.text;
  return (
    <View style={[styles.message, { alignItems: fromTeam ? "flex-end" : "flex-start" }, runs && styles.run]}>
      <View
        style={[
          styles.bubble,
          message.note
            ? { backgroundColor: colors.note, borderColor: colors.onNote, borderWidth: StyleSheet.hairlineWidth, borderStyle: "dashed", borderRadius: 12 }
            : { backgroundColor: fromTeam ? colors.primary : colors.customer },
        ]}
      >
        {message.note && (
          <View style={styles.noteBy}>
            <Icon name={{ ios: "lock.fill", android: "lock" }} size={11} color={colors.onNote} />
            <Text style={[styles.noteByText, { color: colors.onNote }]}>Internal note · {who}</Text>
          </View>
        )}
        <Body text={message.body} color={tone} />
        <Attachments message={message} colors={colors} tone={tone} />
      </View>
      {!runs && (
        <Text style={[styles.meta, styles.by, { color: colors.muted, textAlign: fromTeam ? "right" : "left" }]}>
          {message.note ? "" : `${who} · `}
          {writtenAt(message.createdAt)}
          {sent && <Text style={sent.problem ? { color: colors.error } : undefined}> · {sent.text}</Text>}
        </Text>
      )}
    </View>
  );
}

/** A reply or note that hasn't arrived yet: sending, or kept with Retry. */
function UnsentBubble({ unsent, sending, colors, onRetry, onEdit, onDiscard }: { unsent: Unsent; sending: boolean; colors: Colors; onRetry: () => void; onEdit: () => void; onDiscard: () => void }) {
  return (
    <View style={[styles.message, { alignItems: "flex-end" }]}>
      <View
        style={[
          styles.bubble,
          unsent.note ? { backgroundColor: colors.note, borderRadius: 12 } : { backgroundColor: colors.primary },
          { opacity: sending ? 0.6 : 1 },
          !sending && { borderWidth: 1.5, borderColor: colors.error },
        ]}
      >
        <Body text={unsent.body} color={unsent.note ? colors.text : colors.onPrimary} />
        {unsent.files.map((file) => (
          <Text key={file.id} style={[styles.meta, { color: unsent.note ? colors.muted : colors.onPrimary }]} numberOfLines={1}>
            {file.name} · {fileSize(file.size)}
          </Text>
        ))}
      </View>
      {/* The buttons stay while it sends, off, so a keyboard or screen reader keeps its place on Retry. */}
      {/* An edit kept as its first version had gone out is announced, on both platforms: not read twice here. */}
      <View style={styles.unsentStatus} accessibilityLiveRegion={unsent.error === FIRST_SENT ? "none" : "polite"}>
        <Text style={[styles.meta, { color: sending ? colors.muted : colors.error, textAlign: "right" }]}>
          {/* A Send and close that went out but didn't close says so as it is, not as "Not sent". */}
          {sending ? "Sending…" : unsent.closeOnly ? unsent.error : unsent.error ? `Not sent: ${unsent.error}` : "Not sent"}
        </Text>
        <View style={styles.unsentActions}>
          <TextButton colors={colors} label="Retry" onPress={onRetry} disabled={sending} />
          <TextButton colors={colors} label="Edit" onPress={onEdit} disabled={sending} />
          <TextButton colors={colors} label="Delete" onPress={onDiscard} disabled={sending} muted />
        </View>
      </View>
    </View>
  );
}

/** Plain text, its web addresses tappable. */
function Body({ text, color }: { text: string; color: string }) {
  return (
    <Text style={[styles.body, { color }]} selectable>
      {linkParts(text).map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.link} onPress={() => void Linking.openURL(part)} accessibilityRole="link">
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/** Images shown, other files as rows that open them (their links are signed: no session needed). */
function Attachments({ message, colors, tone }: { message: Message; colors: Colors; tone: string }) {
  if (message.attachments.length === 0 && message.attachmentsDropped === 0) {
    return null;
  }
  return (
    <View style={styles.attachments}>
      {message.attachments.map((attachment) =>
        isImage(attachment) ? (
          <Pressable key={attachment.id} onPress={() => void openBrowserAsync(attachment.url!)} accessibilityRole="imagebutton" accessibilityLabel={attachment.filename}>
            <Picture uri={attachment.url!} colors={colors} />
          </Pressable>
        ) : (
          <Pressable
            key={attachment.id}
            onPress={() => attachment.url && void openBrowserAsync(attachment.url)}
            disabled={!attachment.url}
            accessibilityRole="button"
            accessibilityLabel={`${attachment.filename}, ${fileSize(attachment.size)}`}
            style={({ pressed }) => [styles.file, { backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}
          >
            <Icon name={{ ios: "doc", android: "description" }} size={18} color={colors.muted} />
            <View style={{ flexShrink: 1 }}>
              <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
                {attachment.filename}
              </Text>
              <Text style={[styles.meta, { color: colors.muted }]}>{fileSize(attachment.size)}</Text>
            </View>
          </Pressable>
        ),
      )}
      {message.attachmentsDropped > 0 && <Text style={[styles.meta, { color: tone }]}>{droppedLine(message.attachmentsDropped)}</Text>}
    </View>
  );
}

/** An image at its own shape, at most 220 by 280. */
function Picture({ uri, colors }: { uri: string; colors: Colors }) {
  const [ratio, setRatio] = useState(4 / 3);
  return (
    <Image
      source={{ uri }}
      onLoad={({ nativeEvent: { source } }) => source.width && source.height && setRatio(Math.max(source.width / source.height, 220 / 280))}
      style={[styles.image, { aspectRatio: ratio, backgroundColor: colors.secondary }]}
      resizeMode="cover"
    />
  );
}

function Icon({ name, size, color }: { name: SymbolViewProps["name"]; size: number; color: string }) {
  return <SymbolView name={name} size={size} tintColor={color} />;
}

function IconButton({ label, icon, colors, onPress }: { label: string; icon: SymbolViewProps["name"]; colors: Colors; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}>
      <Icon name={icon} size={20} color={colors.muted} />
    </Pressable>
  );
}

function TextButton({ colors, label, onPress, muted, disabled = false }: { colors: Colors; label: string; onPress: () => void; muted?: boolean; disabled?: boolean }) {
  return (
    // Not `disabled`, which would drop focus: a press is ignored while it's off.
    <Pressable
      onPress={() => !disabled && onPress()}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Text style={[styles.textButton, { color: muted ? colors.muted : colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

/** A short list of choices, as the platform offers one: an action sheet on iOS, a dialog on Android. */
function menu(choices: { label: string; onPress: () => void }[], title?: string) {
  if (IOS) {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...choices.map((choice) => choice.label), "Cancel"], cancelButtonIndex: choices.length }, (index) =>
      choices[index]?.onPress(),
    );
  } else {
    Alert.alert(title ?? "", undefined, [{ text: "Cancel", style: "cancel" }, ...choices.map((choice) => ({ text: choice.label, onPress: choice.onPress }))], { cancelable: true });
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  messages: { paddingHorizontal: 12, paddingVertical: 8 },
  subject: { paddingVertical: 12, gap: 2 },
  subjectText: { fontSize: 17, fontWeight: "600" },
  stale: { paddingVertical: 6, textAlign: "center" },
  message: { marginBottom: 10 },
  run: { marginBottom: 3 },
  bubble: { maxWidth: "82%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, gap: 6 },
  body: { fontSize: 16, lineHeight: 21 },
  link: { textDecorationLine: "underline" },
  meta: { fontSize: 12.5, lineHeight: 17 },
  by: { marginTop: 3, paddingHorizontal: 4, maxWidth: "90%" },
  noteBy: { flexDirection: "row", alignItems: "center", gap: 4 },
  noteByText: { fontSize: 12.5, fontWeight: "600" },
  attachments: { gap: 6 },
  image: { width: 220, borderRadius: 12 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, minWidth: 180 },
  fileName: { fontSize: 14, fontWeight: "500" },
  unsentStatus: { alignItems: "flex-end", gap: 4, marginTop: 3, paddingHorizontal: 4, maxWidth: "90%" },
  unsentActions: { flexDirection: "row", gap: 18 },
  textButton: { fontSize: 14, fontWeight: "600" },
  person: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 260 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 14, fontWeight: "600" },
  personName: { fontSize: 16, fontWeight: "600" },
  about: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  standing: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6, height: 36 },
  standingText: { fontSize: 14, fontWeight: "500" },
  face: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  faceText: { fontSize: 11, fontWeight: "600" },
  composerIos: { marginHorizontal: 10, marginTop: 6, borderWidth: 1, borderRadius: 20, overflow: "hidden" },
  composerAndroid: { marginHorizontal: 10, marginTop: 6, borderRadius: 24, overflow: "hidden" },
  tabs: { flexDirection: "row", gap: 18, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingTop: 8, paddingBottom: 7, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabText: { fontSize: 14, fontWeight: "500" },
  files: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 10, paddingTop: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", height: 30, paddingHorizontal: 10, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth },
  input: { fontSize: 16, lineHeight: 21, minHeight: 40, maxHeight: 140, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4, textAlignVertical: "top" },
  tools: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingBottom: 6 },
  iconButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  draft: { flexDirection: "row", alignItems: "center", gap: 5, height: 30, paddingHorizontal: 11, borderRadius: 15, marginLeft: 4 },
  draftText: { fontSize: 13.5, fontWeight: "500" },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  notice: { paddingHorizontal: 20, paddingTop: 6 },
});
