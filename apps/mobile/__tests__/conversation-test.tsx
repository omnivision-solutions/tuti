import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import ConversationRoute from "@/app/conversation/[number]";
import { ApiError } from "@/lib/api";
import { cached, cacheGeneration, conversationKey, forgetCached, keep } from "@/lib/offline";
import { CLOSE_LEFT, type Conversation, FIRST_SENT, forgetDrafts, getDraft, type Message, type Unsent, updateDraft } from "@/lib/conversation";

jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("expo-router", () => {
  const React = require("react");
  return {
    Stack: { Screen: () => null },
    useLocalSearchParams: () => ({ number: "12" }),
    router: { back: jest.fn(), canGoBack: () => true },
    // Focused once it's on screen, and again when the test says it came back (`mockFocus`).
    useFocusEffect: (effect: () => void) => {
      mockFocus = effect;
      React.useEffect(() => effect(), [effect]);
    },
  };
});
let mockFocus: (() => void) | null = null;
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("expo-symbols", () => ({ SymbolView: () => null }));
jest.mock("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" } }));
jest.mock("expo-document-picker", () => ({}));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
// The phone's files: drafts are kept in memory here.
jest.mock("expo-file-system", () => {
  class Entry {
    exists = false;
    create() {}
    delete() {}
    textSync() {
      return "";
    }
    writeSync() {}
  }
  return { File: Entry, Directory: Entry, Paths: { document: "documents" } };
});

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockApi = jest.fn<(path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>>();
jest.mock("@/lib/session", () => ({ useApi: () => mockApi, useSession: () => ({ session: mockSession }) }));
// The live stream is tested on its own (src/lib/conversation.test.ts).
jest.mock("@/lib/conversation", () => ({ ...jest.requireActual<object>("@/lib/conversation"), watchLive: () => () => {} }));

const key = "https://tuti.example.com|acme|12";
const NETWORK = "Couldn't reach tuti.example.com. Check the address and your connection.";
const SAID = `Not sent: ${FIRST_SENT}`;

const message = (fields: Partial<Message>): Message => ({
  id: "m0",
  author: "user",
  name: "Maya Chen",
  body: "Hi! The export stops at 500 rows.",
  note: false,
  attachments: [],
  attachmentsDropped: 0,
  createdAt: "2026-11-25T09:00:00.000Z",
  fromYou: false,
  fromAddress: null,
  seenAt: null,
  emailStatus: null,
  emailError: null,
  requestId: null,
  ...fields,
});
const conversation = (messages: Message[], status: Conversation["status"] = "open"): Conversation => ({
  number: 12,
  subject: "CSV export stops at 500 rows",
  status,
  user: { id: null, name: "Maya Chen", email: "e2e-maya@example.com", verified: true },
  company: null,
  unread: false,
  onlineUntil: null,
  assignee: null,
  spam: false,
  snoozedUntil: null,
  messages,
});
// The first version, saved though its answer was lost, and the edit of it that kept its id.
const first = message({ id: "m1", author: "team", name: "Olive", fromYou: true, body: "Thanks!", requestId: "u1", createdAt: "2026-11-25T09:05:00.000Z" });
const edit: Unsent = { id: "u1", body: "Thanks, Maya! A fix is on its way.", note: false, close: false, files: [], seen: "2026-11-25T09:00:00.000Z", error: NETWORK };

let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  updateDraft(key, (draft) => ({ ...draft, unsent: [edit] }));
});
afterEach(() => {
  forgetDrafts();
  mockApi.mockReset();
  announce.mockRestore();
});

describe("an edit kept as its first version had already gone out", () => {
  it("is said with why when a fetch finds it, and stays the same bubble", async () => {
    let answer!: (value: Conversation) => void;
    mockApi.mockImplementation((path) => (path === "/conversations/12" ? new Promise((resolve) => (answer = resolve as never)) : Promise.resolve({})));
    // Its error is in the draft before the conversation loads; the list shows once it has.
    await render(<ConversationRoute />);
    await act(async () => answer(conversation([message({}), first])));

    expect(await screen.findByText(SAID)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(SAID);
    expect(announce).not.toHaveBeenCalledWith("Not sent");
    // A new id for the server, the same bubble for the list.
    const kept = getDraft(key).unsent[0]!;
    expect(kept.id).not.toBe("u1");
    expect(kept.key).toBe("u1");
  });

  it("is said with why when Retry comes back request_id_used, and not as a bare Not sent", async () => {
    let saved = false;
    mockApi.mockImplementation((path, init) => {
      if (path === "/conversations/12") {
        return Promise.resolve(conversation(saved ? [message({}), first] : [message({})]));
      }
      if (path === "/conversations/12/messages" && init?.method === "POST") {
        saved = true;
        return Promise.reject(new ApiError(409, "request_id_used", "This requestId was already used for another reply"));
      }
      return Promise.resolve({});
    });
    await render(<ConversationRoute />);
    const retry = await screen.findByRole("button", { name: "Retry" });

    await fireEvent.press(retry);

    expect(await screen.findByText(SAID)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(SAID);
    expect(announce).not.toHaveBeenCalledWith("Not sent");
    // The same bubble: its Retry is the one a screen reader was on.
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
  });
});

describe("a Send and close whose reply arrived, the conversation still waiting on the user", () => {
  it("shows that only the close is left, never as Not sent", async () => {
    const closing: Unsent = { id: "u1", body: "Thanks!", note: false, close: true, files: [], seen: "2026-11-25T09:00:00.000Z", error: NETWORK };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    mockApi.mockImplementation((path) => (path === "/conversations/12" ? Promise.resolve(conversation([message({}), first], "waiting")) : Promise.resolve({})));
    await render(<ConversationRoute />);

    expect(await screen.findByText(CLOSE_LEFT)).toBeTruthy();
    expect(screen.queryByText(/^Not sent/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("announces a failed Retry as sent but not closed, never as Not sent", async () => {
    const closing: Unsent = { id: "u1", body: "Thanks!", note: false, close: true, files: [], seen: "2026-11-25T09:00:00.000Z", error: NETWORK };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    let online = true;
    mockApi.mockImplementation((path, init) => {
      if (path === "/conversations/12") {
        return Promise.resolve(conversation([message({}), first], "waiting"));
      }
      if (path === "/conversations/12/messages" && init?.method === "POST" && !online) {
        return Promise.reject(new ApiError(0, "unreachable", NETWORK));
      }
      return Promise.resolve({});
    });
    await render(<ConversationRoute />);
    await screen.findByText(CLOSE_LEFT);
    online = false;

    await fireEvent.press(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(`Sent, but not closed: ${NETWORK}`)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(`Sent, but not closed: ${NETWORK}`);
    expect(announce).not.toHaveBeenCalledWith("Not sent");
  });
});

describe("reading offline", () => {
  beforeEach(() => {
    forgetDrafts();
    forgetCached();
  });
  afterEach(() => void jest.useRealTimers());

  it("shows a conversation as it was last opened, saying it's offline and when, with no connection", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-25T10:00:00Z") });
    mockApi.mockImplementation(async (path) => (path === "/conversations/12" ? conversation([message({})]) : {}));
    const opened = await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    await opened.unmount();

    jest.setSystemTime(new Date("2026-11-25T10:20:00Z"));
    mockApi.mockImplementation(() => Promise.reject(new ApiError(0, "unreachable", NETWORK)));
    await render(<ConversationRoute />);
    expect(await screen.findByText("Hi! The export stops at 500 rows.")).toBeTruthy();
    expect(screen.getByText("Offline · updated 20 minutes ago")).toBeTruthy();
    expect(screen.queryByText(NETWORK)).toBeNull();
  });

  it("keeps what's on screen when a refresh finds no connection, rather than an older kept copy, saying so", async () => {
    mockApi.mockImplementation(async (path) => (path === "/conversations/12" ? conversation([message({ body: "The newest." })]) : {}));
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
    await render(<ConversationRoute />);
    await screen.findByText("The newest.");
    // What was kept is older (a change the sheet made since, say).
    keep(conversationKey(mockSession, 12), conversation([message({ body: "An older copy." })]), cacheGeneration());

    mockApi.mockImplementation(() => Promise.reject(new ApiError(0, "unreachable", NETWORK)));
    announce.mockClear();
    await act(async () => mockFocus!());
    expect(screen.getByText("The newest.")).toBeTruthy();
    expect(screen.queryByText("An older copy.")).toBeNull();
    expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
    // Said to VoiceOver too.
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/^Offline · updated/));
  });

  it("dates the note from the last load that landed, and moves it on with the clock", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-25T10:00:00Z") });
    mockApi.mockImplementation(async (path) => (path === "/conversations/12" ? conversation([message({})]) : {}));
    await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    // Nothing kept (signed out elsewhere meanwhile, say): the note still dates from that load.
    forgetCached();

    await act(() => jest.advanceTimersByTimeAsync(15 * 60_000));
    mockApi.mockImplementation(() => Promise.reject(new ApiError(0, "unreachable", NETWORK)));
    await act(async () => mockFocus!());
    expect(screen.getByText("Offline · updated 15 minutes ago")).toBeTruthy();
    await act(() => jest.advanceTimersByTimeAsync(5 * 60_000));
    expect(screen.getByText("Offline · updated 20 minutes ago")).toBeTruthy();
  });

  it("keeps nothing from a load that answers after everything was forgotten (signed out)", async () => {
    let answer!: (conversation: Conversation) => void;
    mockApi.mockImplementation((path) => (path === "/conversations/12" ? new Promise((resolve) => (answer = resolve as never)) : Promise.resolve({})));
    await render(<ConversationRoute />);
    forgetCached();
    await act(async () => answer(conversation([message({ body: "Another account's customer." })])));
    expect(cached(conversationKey(mockSession, 12))).toBeNull();
  });

  it("says why when it was never opened", async () => {
    mockApi.mockImplementation(() => Promise.reject(new ApiError(0, "unreachable", NETWORK)));
    await render(<ConversationRoute />);
    expect(await screen.findByText(NETWORK)).toBeTruthy();
  });

  it("says the server's words, not the kept copy, when the server answers with an error", async () => {
    mockApi.mockImplementation(async (path) => (path === "/conversations/12" ? conversation([message({})]) : {}));
    const opened = await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    await opened.unmount();

    mockApi.mockImplementation(() => Promise.reject(new ApiError(404, "not_found", "Conversation not found.")));
    await render(<ConversationRoute />);
    expect(await screen.findByText("Conversation not found.")).toBeTruthy();
    expect(screen.queryByText("Hi! The export stops at 500 rows.")).toBeNull();
  });
});
