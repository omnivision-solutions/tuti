import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import ConversationRoute from "@/app/conversation/[number]";
import { ApiError } from "@/lib/api";
import { CLOSE_LEFT, type Conversation, FIRST_SENT, forgetDrafts, getDraft, type Message, type Unsent, updateDraft } from "@/lib/conversation";

jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("expo-router", () => {
  const React = require("react");
  return {
    Stack: { Screen: () => null },
    useLocalSearchParams: () => ({ number: "12" }),
    router: { back: jest.fn(), canGoBack: () => true },
    // Focused once it's on screen.
    useFocusEffect: (effect: () => void) => React.useEffect(() => effect(), [effect]),
  };
});
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
