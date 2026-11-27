import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import ConversationRoute, { ConversationPane } from "@/app/conversation/[number]";
import { onForgetChosen } from "@/lib/layout";
import { ApiError } from "@/lib/api";
import { cached, cacheGeneration, conversationKey, forgetCached, keep, startCache } from "@/lib/offline";
import { CLOSE_LEFT, type Conversation, FIRST_SENT, forgetDrafts, getDraft, type Message, type Unsent, updateDraft } from "@/lib/conversation";
import { getTriage, showTriage } from "@/lib/details";

jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("expo-router", () => {
  const React = require("react");
  return {
    Stack: { Screen: () => null },
    useLocalSearchParams: () => ({ number: "12" }),
    router: { back: jest.fn(), canGoBack: () => true, dismissTo: jest.fn() },
    // Focused once it's on screen, and again when the test says it came back (`mockFocus`).
    useFocusEffect: (effect: () => void) => {
      mockFocus = effect;
      // Not run while something is over the screen (`mockCovered`: the details sheet).
      React.useEffect(() => (mockCovered ? undefined : effect()), [effect, mockCovered]);
    },
  };
});
let mockFocus: (() => void) | null = null;
let mockCovered = false;
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 120 }));
// A plain view with its props, so a test reads the offset it was given.
jest.mock("react-native/Libraries/Components/Keyboard/KeyboardAvoidingView", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { __esModule: true, default: (props: object) => React.createElement(View, { ...props, testID: "keyboard-avoiding" }) };
});
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

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme", owner: "owner-1" };
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
    // A signed-in session's own cache, empty.
    startCache(mockSession.owner);
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
    keep(conversationKey(mockSession, 12), conversation([message({ body: "An older copy." })]), cacheGeneration(), mockSession.owner);

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
    expect(cached(conversationKey(mockSession, 12), mockSession.owner)).toBeNull();
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

describe("in a wide window (a tablet, a foldable opened)", () => {
  const window = globalThis as unknown as { mockWindow: { width: number; height: number } };
  const narrow = { ...window.mockWindow };
  const dismissTo = () => jest.requireMock<{ router: { dismissTo: jest.Mock } }>("expo-router").router.dismissTo;
  beforeEach(() => {
    forgetDrafts();
    dismissTo().mockClear();
    mockApi.mockImplementation(async (path) => (path === "/conversations/12" ? conversation([message({})]) : {}));
  });
  afterEach(() => void (window.mockWindow = narrow));

  it("hands the conversation to the Inbox, beside its list, however it was opened (a link, a notification)", async () => {
    window.mockWindow = { ...narrow, width: 1280, height: 800 };
    await render(<ConversationRoute />);
    expect(dismissTo()).toHaveBeenCalledWith({ pathname: "/", params: { c: "12", p: "acme" } });
    expect(screen.queryByText("Hi! The export stops at 500 rows.")).toBeNull();
  });

  it("hands it over when the window widens with it open (a foldable opened)", async () => {
    const view = await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    expect(dismissTo()).not.toHaveBeenCalled();

    window.mockWindow = { ...narrow, width: 900, height: 1280 };
    await view.rerender(<ConversationRoute />);
    expect(dismissTo()).toHaveBeenCalledWith({ pathname: "/", params: { c: "12", p: "acme" } });
  });

  it("empties the pane, rather than going back, once a Send and close has closed it", async () => {
    window.mockWindow = { ...narrow, width: 1280, height: 800 };
    const closing: Unsent = { id: "u1", body: "Thanks!", note: false, close: true, files: [], seen: "2026-11-25T09:00:00.000Z", error: NETWORK };
    updateDraft(key, (draft) => ({ ...draft, unsent: [closing] }));
    mockApi.mockImplementation((path) => (path === "/conversations/12" ? Promise.resolve(conversation([message({}), first], "waiting")) : Promise.resolve({})));
    const back = jest.requireMock<{ router: { back: jest.Mock } }>("expo-router").router.back;
    back.mockClear();
    const leave = jest.fn();
    await render(<ConversationPane number={12} onLeave={leave} />);
    await screen.findByText(CLOSE_LEFT);

    // Retry closes it (the reply had arrived): done with.
    await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(leave).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("shows the conversation again when the window narrows before the hand-off has taken it", async () => {
    const view = await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    window.mockWindow = { ...narrow, width: 900, height: 1280 };
    await view.rerender(<ConversationRoute />);
    expect(dismissTo()).toHaveBeenCalled();

    // Folded back before the Inbox came to the front (dismissTo hasn't popped it here).
    window.mockWindow = narrow;
    await view.rerender(<ConversationRoute />);
    expect(await screen.findByText("Hi! The export stops at 500 rows.")).toBeTruthy();
  });

  it("waits, when the window widens with the details sheet over it, till the sheet has closed to hand it over", async () => {
    const view = await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    mockCovered = true;
    try {
      window.mockWindow = { ...narrow, width: 1280, height: 800 };
      await view.rerender(<ConversationRoute />);
      expect(dismissTo()).not.toHaveBeenCalled();
      // Still under the sheet, and seen again as it closes: never blank meanwhile.
      expect(screen.getByText("Hi! The export stops at 500 rows.")).toBeTruthy();
    } finally {
      mockCovered = false;
    }
    await view.rerender(<ConversationRoute />);
    expect(dismissTo()).toHaveBeenCalledWith({ pathname: "/", params: { c: "12", p: "acme" } });
    expect(screen.queryByText("Hi! The export stops at 500 rows.")).toBeNull();
  });

  it("keeps the composer on the keyboard in the pane on iOS: the Inbox already put it under the header", async () => {
    window.mockWindow = { ...narrow, width: 1280, height: 800 };
    const view = await render(<ConversationPane number={12} onLeave={() => {}} />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    expect(screen.getByTestId("keyboard-avoiding").props.keyboardVerticalOffset).toBe(0);
    await view.unmount();

    // Its own screen still lifts it by the header it's under.
    window.mockWindow = narrow;
    await render(<ConversationRoute />);
    await screen.findByText("Hi! The export stops at 500 rows.");
    expect(screen.getByTestId("keyboard-avoiding").props.keyboardVerticalOffset).toBe(120);
  });

  it("forgets a conversation chosen beside the Inbox when it opens on its own (a narrow window)", async () => {
    const forgotten = jest.fn();
    const stop = onForgetChosen(forgotten);
    try {
      await render(<ConversationRoute />);
      await screen.findByText("Hi! The export stops at 500 rows.");
      expect(forgotten).toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("draws its own header beside the list: who it's with and where it stands, each opening the details", async () => {
    window.mockWindow = { ...narrow, width: 1280, height: 800 };
    await render(<ConversationPane number={12} onLeave={() => {}} />);
    expect(await screen.findByText("Hi! The export stops at 500 rows.")).toBeTruthy();
    expect(screen.getByRole("header", { name: /^Maya Chen/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Open, unassigned, details$/ })).toBeTruthy();
    expect(dismissTo()).not.toHaveBeenCalled();
  });
});

describe("a conversation the AI has", () => {
  const withAi: Conversation = { ...conversation([message({})]), handledBy: "ai", priority: false };
  /** The server: the conversation as it is, each change answered with it as it is then. */
  function serve(start: Conversation) {
    let now = start;
    mockApi.mockImplementation(async (path, init) => {
      if (path === "/conversations/12" && init?.method === "PATCH") {
        now = { ...now, ...(init.body as Partial<Conversation>) };
      }
      return path === "/conversations/12" ? now : {};
    });
  }
  const patches = () => mockApi.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => init!.body);
  beforeEach(() => {
    forgetDrafts();
    startCache(mockSession.owner);
  });

  it("says the AI has it in place of the reply box; Take over makes it the team's, and then the reply box is there", async () => {
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {}).mockClear();
    serve(withAi);
    await render(<ConversationRoute />);

    expect(await screen.findByText("The AI has this conversation.")).toBeTruthy();
    // No composer to type a reply or a note into: taking over comes before typing.
    expect(screen.queryByLabelText("Reply")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    await fireEvent.press(screen.getByRole("button", { name: "Take over" }));
    expect(patches()).toEqual([{ handledBy: "team" }]);
    expect(await screen.findByLabelText("Reply")).toBeTruthy();
    expect(screen.queryByText("The AI has this conversation.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(announce).toHaveBeenCalledWith("Taken over");
    // A screen reader's focus, on the button that's gone, is on the reply field.
    expect(focus).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ accessibilityLabel: "Reply" }) }), "focus");
    // Kept for reading offline as the team's.
    expect(cached<Conversation>(conversationKey(mockSession, 12), mockSession.owner)?.data.handledBy).toBe("team");
  });

  it("moves a screen reader to the reply field when a fetch brings it before Take over's own answer, and only then", async () => {
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {}).mockClear();
    serve(withAi);
    await render(<ConversationRoute />);
    await screen.findByText("The AI has this conversation.");
    // The change is made on the server, its answer still on its way, when the stream's fetch answers.
    let answer!: (conversation: Conversation) => void;
    const taken: Conversation = { ...withAi, handledBy: "team" };
    mockApi.mockImplementation((path, init) => (init?.method === "PATCH" ? new Promise((resolve) => (answer = resolve as never)) : Promise.resolve(path === "/conversations/12" ? taken : {})));

    await fireEvent.press(screen.getByRole("button", { name: "Take over" }));
    await act(async () => mockFocus!());
    expect(await screen.findByLabelText("Reply")).toBeTruthy();
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => answer(taken));

    // Later the AI gets it and a teammate elsewhere takes it over: focus stays where it is.
    serve(withAi);
    await act(async () => mockFocus!());
    await screen.findByText("The AI has this conversation.");
    serve(taken);
    await act(async () => mockFocus!());
    await screen.findByLabelText("Reply");
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  });

  it("shows the reply box for the team's own, with no Take over", async () => {
    serve({ ...withAi, handledBy: "team" });
    await render(<ConversationRoute />);
    expect(await screen.findByLabelText("Reply")).toBeTruthy();
    expect(screen.queryByText("The AI has this conversation.")).toBeNull();
  });

  it("puts the reply box back when a teammate elsewhere takes it over, and takes it away when the AI gets one", async () => {
    serve(withAi);
    await render(<ConversationRoute />);
    await screen.findByText("The AI has this conversation.");

    // Fetched again (the stream said it changed): the team's now.
    serve({ ...withAi, handledBy: "team" });
    await act(async () => mockFocus!());
    expect(await screen.findByLabelText("Reply")).toBeTruthy();
    serve(withAi);
    await act(async () => mockFocus!());
    expect(await screen.findByText("The AI has this conversation.")).toBeTruthy();
    expect(screen.queryByLabelText("Reply")).toBeNull();
  });

  it("says why Take over didn't happen, in the server's words, and offers it still", async () => {
    serve(withAi);
    await render(<ConversationRoute />);
    await screen.findByText("The AI has this conversation.");
    mockApi.mockImplementation((path, init) =>
      init?.method === "PATCH" ? Promise.reject(new ApiError(403, "forbidden", "You can't change this conversation.")) : Promise.resolve(path === "/conversations/12" ? withAi : {}),
    );

    await fireEvent.press(screen.getByRole("button", { name: "Take over" }));
    expect(await screen.findByText("You can't change this conversation.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    expect(screen.queryByLabelText("Reply")).toBeNull();
  });

  it("puts no unsent reply back into a composer that isn't there: Edit says to take over first", async () => {
    updateDraft(key, (draft) => ({ ...draft, unsent: [edit] }));
    serve(withAi);
    await render(<ConversationRoute />);

    await fireEvent.press(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Take over first, then Edit.")).toBeTruthy();
    expect(getDraft(key).unsent).toEqual([edit]);
    expect(getDraft(key).reply).toBe("");
  });

  it("says Priority on its page while it's marked, as the details sheet changes it", async () => {
    serve({ ...withAi, handledBy: "team", priority: true });
    await render(<ConversationRoute />);
    expect(await screen.findByText("Priority")).toBeTruthy();

    await act(async () => showTriage(key, { status: "open", assignee: null, spam: false, snoozedUntil: null, handledBy: "team", priority: false }));
    expect(screen.queryByText("Priority")).toBeNull();
  });

  describe("read offline", () => {
    const offline = () => mockApi.mockImplementation(() => Promise.reject(new ApiError(0, "unreachable", NETWORK)));

    it("is shown as it was kept, the AI's and priority, and Take over says why it can't", async () => {
      serve({ ...withAi, priority: true });
      const opened = await render(<ConversationRoute />);
      await screen.findByText("The AI has this conversation.");
      await opened.unmount();

      offline();
      await render(<ConversationRoute />);
      expect(await screen.findByText("The AI has this conversation.")).toBeTruthy();
      expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
      expect(screen.getByText("Priority")).toBeTruthy();
      expect(screen.queryByLabelText("Reply")).toBeNull();

      await fireEvent.press(screen.getByRole("button", { name: "Take over" }));
      expect(await screen.findByText(NETWORK)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    });

    it("never offers Hand back from a kept copy: whether it's offered is the server's to say now", async () => {
      // Kept as the server answered it, offered then.
      keep(conversationKey(mockSession, 12), { ...conversation([message({})]), handledBy: "team", handBack: true }, cacheGeneration(), mockSession.owner);
      offline();
      await render(<ConversationRoute />);
      expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
      expect(getTriage(key)).toMatchObject({ handledBy: "team" });
      expect(getTriage(key)?.handBack).toBeUndefined();
    });

    it("reads one kept before the app knew who has it as the team's, and not priority", async () => {
      // As a version of the app from before kept it (or a server from before answered): neither field.
      keep(conversationKey(mockSession, 12), conversation([message({})]), cacheGeneration(), mockSession.owner);
      offline();
      await render(<ConversationRoute />);

      expect(await screen.findByText("Hi! The export stops at 500 rows.")).toBeTruthy();
      expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
      expect(screen.getByLabelText("Reply")).toBeTruthy();
      expect(screen.queryByText("The AI has this conversation.")).toBeNull();
      expect(screen.queryByText("Priority")).toBeNull();
    });
  });
});
