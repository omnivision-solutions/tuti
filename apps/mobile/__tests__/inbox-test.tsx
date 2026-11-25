import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, ActionSheetIOS, Alert, AppState } from "react-native";

import Inbox from "@/app/index";
import { type Conversation, markRead } from "@/lib/conversation";
import { type InboxView, type Page, type Row, rowPath } from "@/lib/inbox";
import { cached, cacheGeneration, forgetCached, inboxKey, keep, projectsKey } from "@/lib/offline";

// The native header as plain views: the switcher's items as buttons, the search bar as a field.
jest.mock("expo-router", () => {
  const React = require("react");
  const { Pressable, Text, TextInput } = require("react-native");
  const Pass = ({ children }: { children?: unknown }) => React.createElement(React.Fragment, null, children);
  const Toolbar = Object.assign(Pass, {
    Menu: Pass,
    Icon: () => null,
    Label: ({ children }: { children?: unknown }) => React.createElement(Text, { testID: "switcher-label" }, children),
    MenuAction: ({ children, onPress }: { children?: unknown; onPress: () => void }) =>
      React.createElement(Pressable, { accessibilityRole: "menuitem", onPress }, React.createElement(Text, null, children)),
  });
  const SearchBar = ({ placeholder, onChangeText }: { placeholder: string; onChangeText: (event: unknown) => void }) =>
    React.createElement(TextInput, { placeholder, onChangeText: (text: string) => onChangeText({ nativeEvent: { text } }) });
  // The screen's focus: on rendering, and again when the test says it came back (`mockFocus`).
  const useFocusEffect = (effect: () => void) => {
    mockFocus = effect;
    React.useEffect(() => effect(), [effect]);
  };
  return { Stack: { Toolbar, SearchBar }, router: { push: jest.fn() }, useFocusEffect };
});
// Notifications are tested on their own (__tests__/notifications-test.tsx): here, only when the Inbox offers them.
const mockOffer = jest.fn(async () => {});
jest.mock("@/components/notifications", () => ({ offerNotifications: () => mockOffer() }));
let mockFocus: (() => void) | null = null;

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockSessions = new Map<string, typeof mockSession>();
const mockApi = jest.fn<(path: string, init?: unknown) => Promise<unknown>>();
const mockSetProject = jest.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const mockSignOut = jest.fn<() => Promise<void>>(() => Promise.resolve());
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  // A session object per project, as the app has one when the project changes: what a load started for one keeps.
  useSession: () => {
    const key = String(mockSession.project);
    if (!mockSessions.has(key)) {
      mockSessions.set(key, { ...mockSession });
    }
    return { session: mockSessions.get(key)!, setProject: mockSetProject, signOut: mockSignOut };
  },
}));
// The stream is tested on its own (src/lib/live.test.ts): here the test sends its updates.
let mockLive: ((update: { kind: "all" } | { kind: "conversation"; number: number }) => void) | null = null;
let mockOpened = 0;
jest.mock("@/lib/live", () => ({
  openLive: (_session: unknown, onUpdate: typeof mockLive) => {
    mockLive = onUpdate;
    mockOpened++;
    return () => (mockLive = null);
  },
}));

const VIEWS: InboxView[] = [
  { view: "open", title: "Needs reply", count: 4 },
  { view: "mine", title: "Mine", count: 2 },
  { view: "unassigned", title: "Unassigned", count: 0 },
  { view: "waiting", title: "Waiting on user", count: 0 },
  { view: "snoozed", title: "Snoozed", count: 0 },
  { view: "closed", title: "Closed", count: 9 },
  { view: "spam", title: "Spam", count: 0 },
];
const PROJECTS = [
  { slug: "acme", name: "Acme", role: "OWNER", openConversations: 4 },
  { slug: "kite", name: "Kite Labs", role: "MEMBER", openConversations: 1 },
];

let numbers = 0;
const row = (subject: string, more: Partial<Row> = {}): Row => ({
  number: ++numbers,
  subject,
  status: "open",
  user: { name: "Maya Chen", email: "e2e-maya@example.com" },
  assignee: null,
  lastMessageAt: new Date(Date.now() - numbers * 60_000).toISOString(),
  company: "Northwind",
  unread: false,
  latestMessage: { author: "user", name: null, fromYou: false, fromAddress: null, line: `About ${subject}` },
  match: null,
  ...more,
});
const page = (rows: Row[], more: Partial<Page> = {}): Page => ({ conversations: rows, nextCursor: null, total: rows.length, ...more });

/** Answers by path; a path with no answer waits until the test gives one. */
function serve(answers: Record<string, unknown>) {
  mockApi.mockImplementation((path) => {
    if (path === "/projects") {
      return Promise.resolve({ projects: PROJECTS });
    }
    if (path === "/inbox/views") {
      return Promise.resolve({ views: VIEWS });
    }
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    return key ? Promise.resolve(answers[key]) : new Promise(() => {});
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  numbers = 0;
});
afterEach(() => {
  jest.useRealTimers();
  mockApi.mockReset();
});

describe("the Inbox", () => {
  it("shows the views as chips in the server's order and titles, with their counts, and lists the one tapped", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]), "/conversations?view=mine": page([row("Invite link expired")]) });
    await render(<Inbox />);

    const chips = await screen.findAllByRole("tab");
    expect(chips.map((chip) => chip.props.accessibilityLabel)).toEqual(["Needs reply, 4", "Mine, 2", "Unassigned", "Waiting on user", "Snoozed", "Closed, 9", "Spam"]);
    expect(await screen.findByText("CSV export stops at 500 rows")).toBeTruthy();

    await fireEvent.press(screen.getByRole("tab", { name: "Mine, 2" }));
    expect(await screen.findByText("Invite link expired")).toBeTruthy();
    expect(screen.queryByText("CSV export stops at 500 rows")).toBeNull();
    expect(mockApi).toHaveBeenCalledWith("/conversations?view=mine&limit=25&cursor=0");
  });

  it("says who wrote the latest message when it isn't the person", async () => {
    serve({ "/conversations?view=open": page([row("Invoice", { latestMessage: { author: "team", name: "Olive Park", fromYou: true, fromAddress: null, line: "Reissued it." } })]) });
    await render(<Inbox />);
    expect(await screen.findByText("You: Reissued it.")).toBeTruthy();
  });

  it("loads the next page with the cursor as the list scrolls to its end", async () => {
    // Fewer rows than the list draws at first, so the last is drawn (its cells aren't measured here).
    const first = Array.from({ length: 5 }, (_, i) => row(`First page ${i}`));
    serve({
      "/conversations?view=open&limit=25&cursor=0": page(first, { nextCursor: "25", total: 26 }),
      "/conversations?view=open&limit=25&cursor=25": page([row("Second page")], { total: 26 }),
    });
    await render(<Inbox />);
    await screen.findByText("First page 0");

    const list = screen.getByTestId("inbox-list");
    await fireEvent(list, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
    await fireEvent(list, "contentSizeChange", 400, 2400);
    await act(() => jest.advanceTimersByTimeAsync(100));
    await fireEvent.scroll(list, {
      nativeEvent: { contentOffset: { x: 0, y: 2000 }, contentSize: { width: 400, height: 2400 }, layoutMeasurement: { width: 400, height: 800 } },
    });
    expect(mockApi).toHaveBeenCalledWith("/conversations?view=open&limit=25&cursor=25");
    expect(await screen.findByText("Second page")).toBeTruthy();
  });

  it("searches every view once typing pauses, with the line that matched and how many it found", async () => {
    serve({
      "/conversations?view=open": page([row("CSV export stops at 500 rows")]),
      "/conversations?q=export": page([row("Invoices as PDF", { status: "closed", match: { note: false, snippet: "We export them for our accountant" } })], { total: 4 }),
    });
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");

    await fireEvent.changeText(screen.getByPlaceholderText("Search"), "export");
    await act(() => jest.advanceTimersByTimeAsync(300));
    expect(await screen.findByText("4 conversations")).toBeTruthy();
    expect(screen.getByText("We export them for our accountant")).toBeTruthy();
    expect(screen.getByText(/^Closed · /)).toBeTruthy();
    // The chips are the views', not the search's.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("drops a load that a newer one replaced", async () => {
    let answerOpen!: (page: Page) => void;
    serve({ "/conversations?view=mine": page([row("Mine, newer")]) });
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path.startsWith("/conversations?view=open") ? new Promise((resolve) => (answerOpen = resolve)) : served(path)));
    await render(<Inbox />);

    // Needs reply is still loading when Mine is chosen, and answers after it.
    await fireEvent.press(screen.getByRole("tab", { name: "Mine, 2" }));
    await screen.findByText("Mine, newer");
    await act(async () => answerOpen(page([row("Needs reply, older")])));

    expect(screen.getByText("Mine, newer")).toBeTruthy();
    expect(screen.queryByText("Needs reply, older")).toBeNull();
  });

  it("fetches a changed conversation's row and the counts when the stream says it changed", async () => {
    const changed = row("Invite link expired");
    const other = row("CSV export stops at 500 rows");
    serve({ "/conversations?view=open&limit": page([other, changed]) });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    expect(mockLive).not.toBeNull();

    // A new message moves it up, and it's unread now.
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) =>
      path === rowPath("open", changed.number) ? Promise.resolve(page([{ ...changed, unread: true, lastMessageAt: new Date().toISOString() }])) : served(path),
    );
    await act(async () => mockLive!({ kind: "conversation", number: changed.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));

    const rows = screen.getAllByRole("button", { name: /\(#\d+\)/ });
    expect(rows[0]).toHaveAccessibleName(/^Unread, Maya Chen, Northwind: Invite link expired/);
    expect(mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length).toBe(2);
  });

  it("fetches an opened conversation's row and the counts again when the Inbox is back in focus: it may have been read", async () => {
    const opened = row("Invite link expired", { unread: true });
    serve({ "/conversations?view=open&limit": page([opened]) });
    await render(<Inbox />);
    await fireEvent.press(await screen.findByRole("button", { name: /^Unread, Maya Chen, Northwind: Invite link expired/ }));
    expect(jest.requireMock<{ router: { push: jest.Mock } }>("expo-router").router.push).toHaveBeenCalledWith(`/conversation/${opened.number}`);

    // Read there: the server says so now.
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path === rowPath("open", opened.number) ? Promise.resolve(page([{ ...opened, unread: false }])) : served(path)));
    const counted = mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length;
    await act(async () => mockFocus!());

    expect(mockApi).toHaveBeenCalledWith(rowPath("open", opened.number));
    expect(mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length).toBe(counted + 1);
    expect(screen.getByRole("button", { name: /\(#\d+\)/ })).toHaveAccessibleName(/^Maya Chen, Northwind: Invite link expired/);
    // Focus coming back without a conversation opened since fetches nothing more.
    const calls = mockApi.mock.calls.length;
    await act(async () => mockFocus!());
    expect(mockApi.mock.calls.length).toBe(calls);
  });

  it("fetches a conversation's row and the counts again once its read is saved, after a fetch on coming back that beat it", async () => {
    const opened = row("Invite link expired", { unread: true });
    serve({ "/conversations?view=open&limit": page([opened]) });
    await render(<Inbox />);
    await fireEvent.press(await screen.findByRole("button", { name: /^Unread, Maya Chen, Northwind: Invite link expired/ }));

    // The conversation's screen marks it read; the request is slow, and the server says unread till it's saved.
    let read = false;
    let saveRead!: () => void;
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path === rowPath("open", opened.number) ? Promise.resolve(page([{ ...opened, unread: !read }])) : served(path)));
    const reading = markRead(
      () =>
        new Promise((resolve) => {
          saveRead = () => {
            read = true;
            resolve({});
          };
        }) as never,
      { number: opened.number, messages: [] } as unknown as Conversation,
    );
    // Back in the Inbox before the read is saved: that fetch still says unread.
    await act(async () => mockFocus!());
    expect(screen.getByRole("button", { name: /\(#\d+\)/ })).toHaveAccessibleName(/^Unread, /);
    const fetched = mockApi.mock.calls.filter(([path]) => path === rowPath("open", opened.number)).length;
    const counted = mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length;

    await act(async () => {
      saveRead();
      await reading;
    });
    expect(mockApi.mock.calls.filter(([path]) => path === rowPath("open", opened.number)).length).toBe(fetched + 1);
    expect(mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length).toBe(counted + 1);
    expect(screen.getByRole("button", { name: /\(#\d+\)/ })).toHaveAccessibleName(/^Maya Chen, Northwind: Invite link expired/);
  });

  it("starts the next page one earlier once a conversation shown leaves the view", async () => {
    const first = Array.from({ length: 5 }, (_, i) => row(`First page ${i}`));
    serve({ "/conversations?view=open&limit=25&cursor=0": page(first, { nextCursor: "25", total: 30 }), "/conversations?view=open&limit=25&cursor=24": page([row("Next page")]) });
    await render(<Inbox />);
    await screen.findByText("First page 0");

    // Closed on the web: it's in the view no longer.
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path === rowPath("open", first[2]!.number) ? Promise.resolve(page([])) : served(path)));
    await act(async () => mockLive!({ kind: "conversation", number: first[2]!.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.queryByText("First page 2")).toBeNull();

    const list = screen.getByTestId("inbox-list");
    await fireEvent(list, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
    await fireEvent(list, "contentSizeChange", 400, 2400);
    await act(() => jest.advanceTimersByTimeAsync(100));
    await fireEvent.scroll(list, {
      nativeEvent: { contentOffset: { x: 0, y: 2000 }, contentSize: { width: 400, height: 2400 }, layoutMeasurement: { width: 400, height: 800 } },
    });
    expect(await screen.findByText("Next page")).toBeTruthy();
  });

  it("takes the later of two fetches of one row, whichever answers last", async () => {
    const changed = row("Invite link expired");
    serve({ "/conversations?view=open&limit": page([changed]) });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    const answers: ((page: Page) => void)[] = [];
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path === rowPath("open", changed.number) ? new Promise((resolve) => answers.push(resolve)) : served(path)));
    await act(async () => mockLive!({ kind: "conversation", number: changed.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    await act(async () => mockLive!({ kind: "conversation", number: changed.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(answers).toHaveLength(2);

    // The later fetch finds it closed (out of Needs reply); the earlier one, unread, answers after it.
    await act(async () => answers[1]!(page([])));
    await act(async () => answers[0]!(page([{ ...changed, unread: true }])));
    expect(screen.queryByText("Invite link expired")).toBeNull();
  });

  it("offers to try a failed page again", async () => {
    const first = Array.from({ length: 5 }, (_, i) => row(`First page ${i}`));
    let fail = true;
    serve({ "/conversations?view=open&limit=25&cursor=0": page(first, { nextCursor: "25", total: 6 }) });
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) =>
      path.includes("cursor=25") ? (fail ? Promise.reject(new Error("Couldn't reach tuti.example.com.")) : Promise.resolve(page([row("Next page")]))) : served(path),
    );
    await render(<Inbox />);
    await screen.findByText("First page 0");

    const list = screen.getByTestId("inbox-list");
    await fireEvent(list, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
    await fireEvent(list, "contentSizeChange", 400, 2400);
    await act(() => jest.advanceTimersByTimeAsync(100));
    await fireEvent.scroll(list, {
      nativeEvent: { contentOffset: { x: 0, y: 2000 }, contentSize: { width: 400, height: 2400 }, layoutMeasurement: { width: 400, height: 800 } },
    });
    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();

    fail = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Next page")).toBeTruthy();
    expect(screen.queryByText("Couldn't reach tuti.example.com.")).toBeNull();
  });

  it("moves the rows' ages on while nothing else changes", async () => {
    serve({ "/conversations?view=open": page([row("Invite link expired", { lastMessageAt: new Date(Date.now() - 2 * 60_000).toISOString() })]) });
    await render(<Inbox />);
    expect(await screen.findByText("2m")).toBeTruthy();
    await act(() => jest.advanceTimersByTimeAsync(3 * 60_000));
    expect(screen.getByText("5m")).toBeTruthy();
  });

  it("reopens the stream on coming back to the foreground", async () => {
    let onChange!: (state: string) => void;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      onChange = listener as (state: string) => void;
      return { remove: () => {} };
    });
    serve({ "/conversations?view=open": page([row("Invite link expired")]) });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    const opened = mockOpened;

    await act(async () => onChange("background"));
    expect(mockOpened).toBe(opened);
    await act(async () => onChange("active"));
    expect(mockOpened).toBe(opened + 1);
  });

  it("searches again when a conversation changes during a search", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]), "/conversations?q=export": page([row("Invoices as PDF")]) });
    await render(<Inbox />);
    await fireEvent.changeText(screen.getByPlaceholderText("Search"), "export");
    await act(() => jest.advanceTimersByTimeAsync(300));
    await screen.findByText("Invoices as PDF");
    const searches = () => mockApi.mock.calls.filter(([path]) => path.startsWith("/conversations?q=export")).length;
    const before = searches();

    await act(async () => mockLive!({ kind: "conversation", number: 99 }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(searches()).toBe(before + 1);
    expect(mockApi).not.toHaveBeenCalledWith(rowPath("open", 99));
  });

  it("fetches the counts once for several conversations changed together", async () => {
    const [a, b] = [row("Invite link expired"), row("CSV export stops at 500 rows")];
    serve({ "/conversations?view=open&limit": page([a, b]) });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    const counts = () => mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length;
    const before = counts();
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => (path.includes("q=%23") ? Promise.resolve(page([])) : served(path)));

    await act(async () => {
      mockLive!({ kind: "conversation", number: a.number });
      mockLive!({ kind: "conversation", number: b.number });
    });
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(mockApi).toHaveBeenCalledWith(rowPath("open", a.number));
    expect(mockApi).toHaveBeenCalledWith(rowPath("open", b.number));
    expect(counts()).toBe(before + 1);
  });

  it("keeps as many rows as are shown when pulled to refresh", async () => {
    const first = Array.from({ length: 25 }, (_, i) => row(`First page ${i}`));
    const added = row("New conversation", { lastMessageAt: new Date().toISOString() });
    serve({ "/conversations?view=open&limit=25&cursor=0": page(first, { nextCursor: "25", total: 30 }) });
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) =>
      path === rowPath("open", added.number) ? Promise.resolve(page([added])) : path.includes("limit=26&cursor=0") ? Promise.resolve(page([added, ...first], { nextCursor: "26" })) : served(path),
    );
    await render(<Inbox />);
    await screen.findByText("First page 0");
    // A new conversation makes 26 shown.
    await act(async () => mockLive!({ kind: "conversation", number: added.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    await screen.findByText("New conversation");

    const refreshControl = screen.getByTestId("inbox-list").children[0]!;
    await fireEvent(refreshControl as never, "refresh");
    expect(mockApi).toHaveBeenCalledWith("/conversations?view=open&limit=26&cursor=0");
  });

  it("fetches every row shown on reloading a list longer than the server's page", async () => {
    const many = Array.from({ length: 130 }, (_, i) => row(`Row ${i}`));
    serve({
      "/conversations?view=open&limit=25&cursor=0": page(many, { nextCursor: "130", total: 140 }),
      "/conversations?view=open&limit=100&cursor=0": page(many.slice(0, 100), { nextCursor: "100", total: 140 }),
      "/conversations?view=open&limit=30&cursor=100": page(many.slice(100), { nextCursor: "130", total: 140 }),
    });
    await render(<Inbox />);
    await screen.findByText("Row 0");

    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(mockApi).toHaveBeenCalledWith("/conversations?view=open&limit=100&cursor=0");
    expect(mockApi).toHaveBeenCalledWith("/conversations?view=open&limit=30&cursor=100");
  });

  it("asks again for a page that a reload of the same list dropped", async () => {
    const first = Array.from({ length: 5 }, (_, i) => row(`First page ${i}`));
    let answerPage!: (page: Page) => void;
    serve({ "/conversations?view=open&limit=25&cursor=0": page(first, { nextCursor: "25", total: 6 }) });
    const served = mockApi.getMockImplementation()!;
    let pages = 0;
    mockApi.mockImplementation((path) => {
      if (!path.includes("cursor=25")) {
        return served(path);
      }
      pages++;
      return pages === 1 ? new Promise((resolve) => (answerPage = resolve)) : Promise.resolve(page([row("Next page")]));
    });
    await render(<Inbox />);
    await screen.findByText("First page 0");

    const list = screen.getByTestId("inbox-list");
    await fireEvent(list, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
    await fireEvent(list, "contentSizeChange", 400, 2400);
    await act(() => jest.advanceTimersByTimeAsync(100));
    await fireEvent.scroll(list, {
      nativeEvent: { contentOffset: { x: 0, y: 2000 }, contentSize: { width: 400, height: 2400 }, layoutMeasurement: { width: 400, height: 800 } },
    });
    expect(pages).toBe(1);

    // The stream reopens while the page loads: everything is fetched again, then the page answers, too late.
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    await act(async () => answerPage(page([row("Stale page")])));
    expect(await screen.findByText("Next page")).toBeTruthy();
    expect(pages).toBe(2);
    expect(screen.queryByText("Stale page")).toBeNull();
  });

  it.each(["fails", "answers while two reloads run, one after the other"])("asks again for a page that %s as the same list reloads", async (how) => {
    const first = Array.from({ length: 5 }, (_, i) => row(`First page ${i}`));
    let answerPage!: (page: Page) => void;
    let failPage!: (error: Error) => void;
    const reloads: (() => void)[] = [];
    let loadsOfFirst = 0;
    let pages = 0;
    serve({});
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path) => {
      if (path.includes("limit=25&cursor=0")) {
        // The first load answers at once; reloads wait for the test.
        loadsOfFirst++;
        const answer = page(first, { nextCursor: "25", total: 6 });
        return loadsOfFirst === 1 ? Promise.resolve(answer) : new Promise((resolve) => reloads.push(() => resolve(answer)));
      }
      if (!path.includes("cursor=25")) {
        return served(path);
      }
      pages++;
      return pages === 1
        ? new Promise((resolve, reject) => {
            answerPage = resolve;
            failPage = reject;
          })
        : Promise.resolve(page([row("Next page")]));
    });
    await render(<Inbox />);
    await screen.findByText("First page 0");

    const list = screen.getByTestId("inbox-list");
    await fireEvent(list, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
    await fireEvent(list, "contentSizeChange", 400, 2400);
    await act(() => jest.advanceTimersByTimeAsync(100));
    await fireEvent.scroll(list, {
      nativeEvent: { contentOffset: { x: 0, y: 2000 }, contentSize: { width: 400, height: 2400 }, layoutMeasurement: { width: 400, height: 800 } },
    });
    expect(pages).toBe(1);

    const reload = async () => {
      await act(async () => mockLive!({ kind: "all" }));
      await act(() => jest.advanceTimersByTimeAsync(200));
    };
    await reload();
    if (how === "fails") {
      await act(async () => failPage(new Error("Couldn't reach tuti.example.com.")));
      await act(async () => reloads.shift()!());
    } else {
      // The page answers while the first reload runs; a second starts before the first is in.
      await act(async () => answerPage(page([row("Stale page")])));
      await reload();
      await act(async () => reloads.shift()!());
      expect(pages).toBe(1);
      await act(async () => reloads.shift()!());
    }
    expect(await screen.findByText("Next page")).toBeTruthy();
    expect(pages).toBe(2);
    expect(screen.queryByText("Couldn't reach tuti.example.com.")).toBeNull();
  });

  it("opens the teammate's first project when none is chosen yet", async () => {
    serve({ "/conversations?view=open": page([]) });
    mockSession.project = "gone";
    try {
      await render(<Inbox />);
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(mockSetProject).toHaveBeenCalledWith("acme");
    } finally {
      mockSession.project = "acme";
    }
  });

  it("switches project from the switcher, and signs out from it once confirmed", async () => {
    serve({ "/conversations?view=open": page([]) });
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await render(<Inbox />);

    expect(await screen.findByTestId("switcher-label")).toHaveTextContent("Acme");
    await fireEvent.press(screen.getByRole("menuitem", { name: "Kite Labs" }));
    expect(mockSetProject).toHaveBeenCalledWith("kite");

    await fireEvent.press(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mockSignOut).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2]!;
    await act(async () => buttons.find((button) => button.text === "Sign out")!.onPress!());
    expect(mockSignOut).toHaveBeenCalled();
  });

  it("offers notifications as it first shows, and opens their settings from the switcher", async () => {
    serve({ "/conversations?view=open": page([]) });
    mockOffer.mockClear();
    await render(<Inbox />);
    expect(mockOffer).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole("menuitem", { name: "Notifications" }));
    expect(jest.requireMock<{ router: { push: jest.Mock } }>("expo-router").router.push).toHaveBeenCalledWith("/notifications");
  });
});

describe("swiping a row", () => {
  afterEach(() => void jest.restoreAllMocks());

  type Held = { path: string; body: unknown; answer: (ok: boolean, why?: string) => void };
  /**
   * A small server for one or more projects: each conversation's status and snooze, the views and searches listed from
   * them as the server does, by offset. A change (PATCH) waits till the test answers it, and is made only if taken. A
   * request `hold` matches is answered as the server had it when asked, but only once the test lets it go.
   */
  function fakeServer(byProject: Record<string, Row[]>, { snoozed = [] as number[], spam = [] as number[] } = {}) {
    const state = new Map(Object.entries(byProject).map(([slug, rows]) => [slug, rows.map((r) => ({ row: r, snoozed: snoozed.includes(r.number), spam: spam.includes(r.number) }))]));
    const changes: Held[] = [];
    const held: { path: string; release: () => void }[] = [];
    let hold: (path: string) => boolean = () => false;
    let fail: (path: string) => boolean = () => false;
    const inView = (c: { row: Row; snoozed: boolean; spam: boolean }, view: string) =>
      view === "spam"
        ? c.spam
        : !c.spam &&
          (view === "closed" ? c.row.status === "closed" : view === "snoozed" ? c.snoozed && c.row.status !== "closed" : c.row.status !== "closed" && !c.snoozed);
    const list = (path: string): Page => {
      const url = new URL(path, "https://tuti.example.com");
      const q = url.searchParams.get("q");
      const view = url.searchParams.get("view");
      const all = state.get(mockSession.project!) ?? [];
      const found = all.filter((c) =>
        q?.startsWith("#") ? c.row.number === Number(q.slice(1)) && inView(c, view!) : q ? !c.spam && c.row.subject.toLowerCase().includes(q.toLowerCase()) : inView(c, view!),
      );
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      const rows = found.slice(cursor, cursor + limit).map((c) => c.row);
      return { conversations: rows, nextCursor: found.length > cursor + limit ? String(cursor + limit) : null, total: found.length };
    };
    mockApi.mockImplementation((path, init) => {
      const { method, body } = (init ?? {}) as { method?: string; body?: Record<string, unknown> };
      if (method === "PATCH") {
        const one = state.get(mockSession.project!)!.find((c) => c.row.number === Number(path.split("/").pop()));
        return new Promise((resolve, reject) =>
          changes.push({
            path,
            body,
            answer: (ok, why) => {
              if (!ok) {
                return reject(new Error(why));
              }
              if (one && body && "status" in body) {
                one.row = { ...one.row, status: body.status as Row["status"] };
              }
              if (one && body && "snoozedUntil" in body) {
                one.snoozed = body.snoozedUntil !== null;
              }
              resolve({});
            },
          }),
        );
      }
      if (fail(path)) {
        return Promise.reject(new Error("Something went wrong on the server."));
      }
      if (path === "/projects") {
        return Promise.resolve({ projects: PROJECTS });
      }
      if (path === "/inbox/views") {
        return Promise.resolve({ views: VIEWS });
      }
      const answer = list(path);
      return hold(path) ? new Promise((resolve) => held.push({ path, release: () => resolve(answer) })) : Promise.resolve(answer);
    });
    /** A change made elsewhere (the web, a customer's message). */
    const change = (number: number, status: Row["status"]) => {
      const one = state.get(mockSession.project!)!.find((c) => c.row.number === number)!;
      one.row = { ...one.row, status };
    };
    return { changes, held, change, holdWhen: (when: (path: string) => boolean) => (hold = when), failWhen: (when: (path: string) => boolean) => (fail = when) };
  }
  const subjects = () => (screen.getByTestId("inbox-list").props.data as Row[]).map((r) => r.subject);
  const rowNamed = (subject: string) => screen.getByRole("button", { name: new RegExp(`: ${subject} \\(#`) });
  // The actions behind a row (drawn beside it under Jest), hidden from screen readers: the row has them as its actions.
  const pressAction = (label: string, i = 0) => fireEvent.press(screen.getAllByText(label, { includeHiddenElements: true })[i]!);
  const chooseView = async (name: RegExp) => fireEvent.press(screen.getByRole("tab", { name }));
  // What's said to a screen reader when a change is made, in the details sheet's words.
  // (React Native's own Jest setup mocks it already: cleared of earlier tests' calls.)
  const announced = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {}).mockClear();

  it("hides it at once, and once the server has it loads the list and the counts again", async () => {
    const closing = row("Invite link expired");
    const { changes } = fakeServer({ acme: [row("CSV export stops at 500 rows"), closing] });
    const announce = announced();
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    await pressAction("Close", 1);
    expect(screen.queryByText("Invite link expired")).toBeNull();
    expect(changes.map(({ path, body }) => ({ path, body }))).toEqual([{ path: `/conversations/${closing.number}`, body: { status: "closed" } }]);

    const counted = mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length;
    await act(async () => changes[0]!.answer(true));
    expect(announce).toHaveBeenCalledWith("Closed");
    expect(mockApi).toHaveBeenLastCalledWith("/conversations?view=open&limit=25&cursor=0");
    expect(subjects()).toEqual(["CSV export stops at 500 rows"]);
    expect(mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length).toBe(counted + 1);
  });

  it("puts it back, saying why in an alert (it may be far down the list), when the server refuses", async () => {
    const { changes } = fakeServer({ acme: [row("Invite link expired")] });
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const announce = announced();
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    await pressAction("Close");
    expect(screen.queryByText("Invite link expired")).toBeNull();
    await act(async () => changes[0]!.answer(false, "You can't change this conversation."));
    expect(screen.getByText("Invite link expired")).toBeTruthy();
    expect(alert).toHaveBeenCalledWith(`Couldn't close "Invite link expired"`, "You can't change this conversation.");
    // Said by the alert, never as done.
    expect(announce).not.toHaveBeenCalled();
  });

  it("ignores the row's own live changes while its swipe waits: the reload after the answer brings it", async () => {
    const closing = row("Invite link expired");
    const { changes } = fakeServer({ acme: [closing] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    await act(async () => mockLive!({ kind: "conversation", number: closing.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(mockApi.mock.calls.some(([path]) => path.includes("q=%23"))).toBe(false);
    await act(async () => changes[0]!.answer(true));
    expect(subjects()).toEqual([]);
  });

  it("loads the list again for a swiped row's live change once its reload has started: that reload may not have it", async () => {
    const closing = row("Invite link expired");
    const server = fakeServer({ acme: [closing, row("CSV export stops at 500 rows")] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    // The reload after the answer is slow; meanwhile the customer writes, and the server opens it again.
    server.holdWhen((path) => path.startsWith("/conversations?view=open&limit"));
    await act(async () => server.changes[0]!.answer(true));
    server.change(closing.number, "open");
    await act(async () => mockLive!({ kind: "conversation", number: closing.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(server.held).toHaveLength(2);

    server.holdWhen(() => false);
    await act(async () => server.held.forEach((one) => one.release()));
    expect(subjects()).toEqual(["Invite link expired", "CSV export stops at 500 rows"]);
  });

  it("reloads from Try again when the reload after a swipe failed, with no next page", async () => {
    const rows = [row("Invite link expired"), row("CSV export stops at 500 rows")];
    const server = fakeServer({ acme: rows });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    server.failWhen((path) => path.startsWith("/conversations?view=open"));
    await act(async () => server.changes[0]!.answer(true));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();

    server.failWhen(() => false);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(subjects()).toEqual(["CSV export stops at 500 rows"]);
    expect(screen.queryByText("Something went wrong on the server.")).toBeNull();
  });

  it("offers no Try again at the end while a swipe still waits: it would do nothing", async () => {
    const server = fakeServer({ acme: [row("Invite link expired"), row("CSV export stops at 500 rows")] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    // The counts fail meanwhile: the error shows, but the swipe's own reload is still to come.
    server.failWhen((path) => path === "/inbox/views");
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("leaves Try again to the empty view when the failed reload left no rows", async () => {
    const server = fakeServer({ acme: [row("Invite link expired")] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    server.failWhen((path) => path.startsWith("/conversations?view=open"));
    await act(async () => server.changes[0]!.answer(true));
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    // Said once, by the empty view: there are no rows for the line above them.
    expect(screen.getAllByText("Something went wrong on the server.")).toHaveLength(1);

    server.failWhen(() => false);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(await screen.findByText("No replies waiting. You're up to date.")).toBeTruthy();
  });

  it("reloads from the view's chip, tapped again, when the reload after a swipe failed, then pages on", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`Conversation ${i + 1}`));
    const server = fakeServer({ acme: rows });
    await render(<Inbox />);
    await screen.findByText("Conversation 1");
    await pressAction("Close", 2);

    server.failWhen((path) => path.startsWith("/conversations?view=open"));
    await act(async () => server.changes[0]!.answer(true));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();

    // The same search typed again changes nothing, and keeps the error.
    await fireEvent.changeText(screen.getByPlaceholderText("Search"), " ");
    await act(() => jest.advanceTimersByTimeAsync(300));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();

    server.failWhen(() => false);
    await fireEvent.press(screen.getByRole("tab", { name: /^Needs reply/ }));
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(screen.queryByText("Something went wrong on the server.")).toBeNull();
    await fireEvent(screen.getByTestId("inbox-list"), "endReached");
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(subjects()).toEqual(rows.filter((_, i) => i !== 2).map((r) => r.subject));
  });

  it("reloads from the end's Try again when the reload after a swipe failed, then pages on", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`Conversation ${i + 1}`));
    const server = fakeServer({ acme: rows });
    await render(<Inbox />);
    await screen.findByText("Conversation 1");
    await pressAction("Close", 2);

    server.failWhen((path) => path.startsWith("/conversations?view=open"));
    await act(async () => server.changes[0]!.answer(true));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();

    server.failWhen(() => false);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(subjects()).toEqual(rows.filter((_, i) => i !== 2).map((r) => r.subject));
  });

  it("drops a fetch of the row from before the server had it, answering after its reload (another view's too)", async () => {
    const closing = row("Invite link expired");
    const server = fakeServer({ acme: [closing, row("CSV export stops at 500 rows")] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    // A live change's fetch of the row starts, and is slow; the row is closed meanwhile.
    server.holdWhen((path) => path.includes("q=%23"));
    await act(async () => mockLive!({ kind: "conversation", number: closing.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    await pressAction("Close");
    await act(async () => server.changes[0]!.answer(true));
    expect(subjects()).toEqual(["CSV export stops at 500 rows"]);

    // It answers now, with the row as it was: open.
    await act(async () => server.held.forEach((one) => one.release()));
    expect(subjects()).toEqual(["CSV export stops at 500 rows"]);
  });

  it("shows a row closed from another view in Closed, chosen before the server answered, and pages Closed from its reload", async () => {
    // Closed has 30; the one closed now is the latest.
    const closing = row("Invite link expired");
    const older = Array.from({ length: 30 }, (_, i) => row(`Closed ${i + 1}`, { status: "closed" }));
    const { changes } = fakeServer({ acme: [closing, ...older] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    // Closed loads before the server has the close: 25 of its 30, the next page from 25.
    await chooseView(/^Closed/);
    await screen.findByText("Closed 1");
    await act(async () => changes[0]!.answer(true));
    expect(subjects()).toEqual(["Invite link expired", ...older.slice(0, 24).map((r) => r.subject)]);

    // Its next page starts where the reload says: no row skipped.
    await fireEvent(screen.getByTestId("inbox-list"), "endReached");
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(subjects()).toEqual(["Invite link expired", ...older.map((r) => r.subject)]);
  });

  it("asks for no next page while a swipe waits, then pages from the reload, so no row is skipped", async () => {
    // Needs reply has 30: 25 shown, and the third is closed, still on its way.
    const rows = Array.from({ length: 30 }, (_, i) => row(`Conversation ${i + 1}`));
    const { changes } = fakeServer({ acme: rows });
    await render(<Inbox />);
    await screen.findByText("Conversation 1");
    await pressAction("Close", 2);

    await fireEvent(screen.getByTestId("inbox-list"), "endReached");
    expect(mockApi.mock.calls.some(([path]) => path.includes("cursor=25"))).toBe(false);

    await act(async () => changes[0]!.answer(true));
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(subjects()).toEqual(rows.filter((_, i) => i !== 2).map((r) => r.subject));
  });

  it("snoozes it till the time chosen from the details sheet's choices", async () => {
    // A Wednesday afternoon, in the teammate's own time.
    jest.setSystemTime(new Date("2026-11-25T14:00:00"));
    const { changes } = fakeServer({ acme: [row("Invite link expired")] });
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    const announce = announced();
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    await pressAction("Snooze");
    const [options, choose] = sheet.mock.calls[0]!;
    expect(options.options).toEqual(["In 3 hours", "Tomorrow, 9:00", "Monday, 9:00", "Cancel"]);
    // Cancelled: nothing changes.
    await act(async () => choose(3));
    expect(changes).toHaveLength(0);

    await act(async () => choose(1));
    expect(screen.queryByText("Invite link expired")).toBeNull();
    expect(changes[0]!.body).toEqual({ snoozedUntil: new Date("2026-11-26T09:00:00").toISOString() });
    await act(async () => changes[0]!.answer(true));
    expect(announce).toHaveBeenCalledWith("Snoozed till Thu 26 Nov, 09:00");
    expect(subjects()).toEqual([]);
  });

  it("offers Wake now in Snoozed, and wakes one: the server's told, and it leaves the list", async () => {
    const waking = row("Invite link expired");
    const { changes } = fakeServer({ acme: [waking, row("Still asleep"), row("Old one", { status: "closed" })] }, { snoozed: [1, 2] });
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    const announce = announced();
    await render(<Inbox />);
    await chooseView(/^Snoozed/);
    await screen.findByText("Invite link expired");

    await pressAction("Snooze");
    const [options, choose] = sheet.mock.calls[0]!;
    expect(options.options).toEqual(["In 3 hours", "Tomorrow, 9:00", "Monday, 9:00", "Wake now", "Cancel"]);
    await act(async () => choose(3));
    expect(changes.map(({ path, body }) => ({ path, body }))).toEqual([{ path: `/conversations/${waking.number}`, body: { snoozedUntil: null } }]);
    await act(async () => changes[0]!.answer(true));
    expect(subjects()).toEqual(["Still asleep"]);
    expect(announce).toHaveBeenCalledWith("Back in the inbox");
  });

  it("says why a wake was refused", async () => {
    const { changes } = fakeServer({ acme: [row("Invite link expired")] }, { snoozed: [1] });
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await render(<Inbox />);
    await chooseView(/^Snoozed/);
    await screen.findByText("Invite link expired");

    await pressAction("Snooze");
    await act(async () => sheet.mock.calls[0]![1](3));
    await act(async () => changes[0]!.answer(false, "Spam isn't snoozed."));
    expect(alert).toHaveBeenCalledWith(`Couldn't wake "Invite link expired"`, "Spam isn't snoozed.");
    expect(screen.getByText("Invite link expired")).toBeTruthy();
  });

  it("has nothing for a closed one, and Close but not Snooze in Spam, as the details sheet", async () => {
    fakeServer({ acme: [row("Old one", { status: "closed" }), row("Win a prize")] }, { spam: [2] });
    await render(<Inbox />);
    await chooseView(/^Closed/);
    await screen.findByText("Old one");
    expect(rowNamed("Old one").props.accessibilityActions).toEqual([]);

    await chooseView(/^Spam/);
    await screen.findByText("Win a prize");
    expect(screen.queryAllByText("Snooze", { includeHiddenElements: true })).toHaveLength(0);
    expect(rowNamed("Win a prize").props.accessibilityActions).toEqual([{ name: "close", label: "Close" }]);
  });

  it("hides only its own project's row: another project's conversation with the same number stays", async () => {
    const closing = row("Invite link expired");
    const { changes } = fakeServer({ acme: [closing], kite: [{ ...closing, subject: "Kite's own" }] });
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");
    try {
      mockSession.project = "kite";
      await screen.rerender(<Inbox />);
      expect(await screen.findByText("Kite's own")).toBeTruthy();
      await act(async () => changes[0]!.answer(true));
      expect(subjects()).toEqual(["Kite's own"]);
    } finally {
      mockSession.project = "acme";
    }
  });

  describe("and reading offline", () => {
    const offline = () => Object.assign(new Error("Couldn't reach tuti.example.com. Check the address and your connection."), { code: "unreachable" });
    beforeEach(() => forgetCached());

    it("keeps the list as its reload after a swipe shows it", async () => {
      const closing = row("Invite link expired");
      const { changes } = fakeServer({ acme: [closing, row("CSV export stops at 500 rows")] });
      const first = await render(<Inbox />);
      await screen.findByText("Invite link expired");
      await pressAction("Close");
      await act(async () => changes[0]!.answer(true));
      await first.unmount();

      mockApi.mockImplementation(() => Promise.reject(offline()));
      await render(<Inbox />);
      expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
      expect(subjects()).toEqual(["CSV export stops at 500 rows"]);
    });

    it("keeps the list as the server last had it while a swipe waits for its answer", async () => {
      fakeServer({ acme: [row("Invite link expired"), row("CSV export stops at 500 rows")] });
      const first = await render(<Inbox />);
      await screen.findByText("Invite link expired");
      // Closed, and the app is gone before the server answers.
      await pressAction("Close");
      await first.unmount();

      mockApi.mockImplementation(() => Promise.reject(offline()));
      await render(<Inbox />);
      expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
      expect(subjects()).toEqual(["Invite link expired", "CSV export stops at 500 rows"]);
    });

    it("keeps a row whose swipe was refused after the list went offline while it waited", async () => {
      const { changes } = fakeServer({ acme: [row("Invite link expired"), row("CSV export stops at 500 rows")] });
      jest.spyOn(Alert, "alert").mockImplementation(() => {});
      await render(<Inbox />);
      await screen.findByText("Invite link expired");
      await pressAction("Close");

      // The connection goes while the close waits: a reload finds none, and the list shows it's offline.
      const served = mockApi.getMockImplementation()!;
      mockApi.mockImplementation((path, init) => ((init as { method?: string } | undefined)?.method === "PATCH" ? served(path, init) : Promise.reject(offline())));
      await act(async () => mockLive!({ kind: "all" }));
      await act(() => jest.advanceTimersByTimeAsync(200));
      expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
      // Then the close is refused: the row comes back.
      await act(async () => changes[0]!.answer(false, "You can't change this conversation."));
      expect(subjects()).toEqual(["Invite link expired", "CSV export stops at 500 rows"]);

      // Reopened, still offline: it's there.
      await screen.unmount();
      await render(<Inbox />);
      expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
      expect(subjects()).toEqual(["Invite link expired", "CSV export stops at 500 rows"]);
    });

    it("refuses a swipe made offline: its row comes back, with why, and the list says it's offline", async () => {
      fakeServer({ acme: [row("Invite link expired")] });
      const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      await render(<Inbox />);
      await screen.findByText("Invite link expired");

      mockApi.mockImplementation(() => Promise.reject(offline()));
      await pressAction("Close");
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(alert).toHaveBeenCalledWith(`Couldn't close "Invite link expired"`, "Couldn't reach tuti.example.com. Check the address and your connection.");
      expect(subjects()).toEqual(["Invite link expired"]);
      expect(screen.getByText(/^Offline · updated/)).toBeTruthy();

      // Reopened, still offline: the conversation whose change was refused is there.
      await screen.unmount();
      await render(<Inbox />);
      expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
      expect(subjects()).toEqual(["Invite link expired"]);
    });
  });

  it("gives a screen reader the same actions on the row", async () => {
    const { changes } = fakeServer({ acme: [row("Invite link expired")] });
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    const target = rowNamed("Invite link expired");
    expect(target.props.accessibilityActions).toEqual([
      { name: "snooze", label: "Snooze" },
      { name: "close", label: "Close" },
    ]);
    await fireEvent(target, "accessibilityAction", { nativeEvent: { actionName: "snooze" } });
    expect(sheet).toHaveBeenCalled();
    await fireEvent(target, "accessibilityAction", { nativeEvent: { actionName: "close" } });
    expect(changes[0]!.body).toEqual({ status: "closed" });
  });
});

describe("reading offline", () => {
  const offline = () => Object.assign(new Error("Couldn't reach tuti.example.com. Check the address and your connection."), { code: "unreachable" });
  beforeEach(() => forgetCached());

  it("shows a view as it was last loaded, saying it's offline and when, with no connection", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    const first = await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    await first.unmount();

    await act(() => jest.advanceTimersByTimeAsync(5 * 60_000));
    mockApi.mockImplementation(() => Promise.reject(offline()));
    await render(<Inbox />);
    expect(await screen.findByText("CSV export stops at 500 rows")).toBeTruthy();
    expect(screen.getByText("Offline · updated 5 minutes ago")).toBeTruthy();
    // Said to VoiceOver too, which has no live regions.
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith("Offline · updated 5 minutes ago");
    // The chips and the switcher as they were too.
    expect(screen.getByRole("tab", { name: "Needs reply, 4" })).toBeTruthy();
    expect(screen.getByTestId("switcher-label")).toHaveTextContent("Acme");
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  });

  it("dates a list on screen from its last load when a refresh finds no connection, kept or not", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    // Nothing kept of it (too big, or forgotten), and two hours pass.
    forgetCached();
    await act(() => jest.advanceTimersByTimeAsync(2 * 3_600_000));

    mockApi.mockImplementation(() => Promise.reject(offline()));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText("Offline · updated 2 hours ago")).toBeTruthy();
  });

  it("keeps a project's chips when an older load's counts fail offline after a switch", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByRole("tab", { name: "Needs reply, 4" });

    // Acme's counts are asked for again, and hang; Kite Labs is chosen, and its own answer.
    const served = mockApi.getMockImplementation()!;
    let failAcme!: () => void;
    mockApi.mockImplementation((path, init) =>
      path === "/inbox/views"
        ? mockSession.project === "acme"
          ? new Promise((_, reject) => (failAcme = () => reject(offline())))
          : Promise.resolve({ views: VIEWS.map((v) => (v.view === "open" ? { ...v, count: 1 } : v)) })
        : served(path, init),
    );
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    try {
      mockSession.project = "kite";
      await screen.rerender(<Inbox />);
      expect(await screen.findByRole("tab", { name: "Needs reply, 1" })).toBeTruthy();
      await act(async () => failAcme());
      expect(screen.getByRole("tab", { name: "Needs reply, 1" })).toBeTruthy();
    } finally {
      mockSession.project = "acme";
    }
  });

  it("keeps no projects from a load that answers after everything was forgotten (signed out)", async () => {
    let answer!: (value: unknown) => void;
    serve({});
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path === "/projects" ? new Promise((resolve) => (answer = resolve)) : served(path, init)));
    await render(<Inbox />);
    forgetCached();
    await act(async () => answer({ projects: PROJECTS }));
    expect(cached(projectsKey(mockSession))).toBeNull();
  });

  const slowProjectsOffline = (path: string) =>
    path === "/projects" ? new Promise((_, reject) => setTimeout(() => reject(offline()), 1_000)) : Promise.reject(offline());

  it("says nothing of the projects offline when the switcher has them already", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    expect(screen.getByTestId("switcher-label")).toHaveTextContent("Acme");
    // The projects weren't kept (forgotten since), but they're shown.
    forgetCached();

    // Only the projects' request finds no connection, after the list has loaded.
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path === "/projects" ? slowProjectsOffline(path) : served(path, init)));
    await fireEvent(screen.getByTestId("inbox-list"), "refresh");
    await act(() => jest.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("CSV export stops at 500 rows")).toBeTruthy();
    expect(screen.getByTestId("switcher-label")).toHaveTextContent("Acme");
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  });

  it("says nothing of the projects offline when the list shows what was kept", async () => {
    // Only the list was kept, not the projects.
    keep(inboxKey(mockSession, "open"), { rows: [row("CSV export stops at 500 rows")], total: 1 }, cacheGeneration());
    // The projects' request fails after the list's has.
    mockApi.mockImplementation(slowProjectsOffline);
    await render(<Inbox />);
    await act(() => jest.advanceTimersByTimeAsync(1_000));
    await screen.findByText(/^Offline · updated/);
    expect(screen.getByText("CSV export stops at 500 rows")).toBeTruthy();
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  });

  it("never shows another project's counts over a project's kept rows", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByRole("tab", { name: "Needs reply, 4" });
    // Kite Labs' list was kept once, its counts weren't.
    keep(inboxKey({ server: mockSession.server, project: "kite" }, "open"), { rows: [row("Kite's own")], total: 1 }, cacheGeneration());

    mockApi.mockImplementation(() => Promise.reject(offline()));
    try {
      mockSession.project = "kite";
      await screen.rerender(<Inbox />);
      expect(await screen.findByText("Kite's own")).toBeTruthy();
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    } finally {
      mockSession.project = "acme";
    }
  });

  it("says why when nothing was kept: a view never loaded", async () => {
    mockApi.mockImplementation(() => Promise.reject(offline()));
    await render(<Inbox />);
    expect(await screen.findByText(/Couldn't reach/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("never shows a view's kept rows as a search's results", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");

    mockApi.mockImplementation(() => Promise.reject(offline()));
    await fireEvent.changeText(screen.getByPlaceholderText("Search"), "invoice");
    await act(() => jest.advanceTimersByTimeAsync(300));
    expect(await screen.findByText(/Couldn't reach/)).toBeTruthy();
    expect(screen.queryByText("CSV export stops at 500 rows")).toBeNull();
    expect(screen.queryByText(/^Offline/)).toBeNull();
  });

  it("keeps every row shown when a reload fails offline, more than are kept, saying so", async () => {
    // As many as scrolling far shows: more than are kept.
    const rows = Array.from({ length: 130 }, (_, i) => row(`Conversation ${i + 1}`));
    serve({ "/conversations?view=open": page(rows) });
    await render(<Inbox />);
    await screen.findByText("Conversation 1");

    mockApi.mockImplementation(() => Promise.reject(offline()));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
    // Still there, past the 100 kept.
    expect(screen.getByTestId("inbox-list").props.data).toHaveLength(130);
  });

  it("asks for no next page while offline, with no spinner or Try again at its end", async () => {
    serve({ "/conversations?view=open&limit=25&cursor=0": page([row("First page")], { nextCursor: "25", total: 30 }) });
    await render(<Inbox />);
    await screen.findByText("First page");
    const footer = () => screen.getByTestId("inbox-list").props.ListFooterComponent;
    expect(footer()).toBeTruthy();

    mockApi.mockImplementation(() => Promise.reject(offline()));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
    expect(footer()).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    const asked = mockApi.mock.calls.length;
    await fireEvent(screen.getByTestId("inbox-list"), "endReached");
    expect(mockApi.mock.calls.length).toBe(asked);
  });

  it("says the server's own error beside the note, once it answers again", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    mockApi.mockImplementation(() => Promise.reject(offline()));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText(/^Offline · updated/)).toBeTruthy();

    mockApi.mockImplementation(() => Promise.reject(new Error("Something went wrong on the server.")));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText("Something went wrong on the server.")).toBeTruthy();
  });

  it("shows the chips as kept when only the counts fail offline, and the rows that loaded, not as offline", async () => {
    serve({ "/conversations?view=open": page([row("CSV export stops at 500 rows")]) });
    const first = await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    await first.unmount();

    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path === "/inbox/views" ? Promise.reject(offline()) : served(path, init)));
    await render(<Inbox />);
    await screen.findByText("CSV export stops at 500 rows");
    expect(screen.getByRole("tab", { name: "Needs reply, 4" })).toBeTruthy();
    expect(screen.queryByText(/^Offline/)).toBeNull();
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  });

  it("keeps nothing once forgotten (signed out) while a load was on its way", async () => {
    let answer!: (page: Page) => void;
    serve({});
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path.startsWith("/conversations?view=open") ? new Promise((resolve) => (answer = resolve)) : served(path, init)));
    const first = await render(<Inbox />);
    forgetCached();
    await act(async () => answer(page([row("Another account's customer")])));
    await first.unmount();

    mockApi.mockImplementation(() => Promise.reject(offline()));
    await render(<Inbox />);
    expect(await screen.findByText(/Couldn't reach/)).toBeTruthy();
    expect(screen.queryByText("Another account's customer")).toBeNull();
  });
});
