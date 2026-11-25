import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ActionSheetIOS, Alert, AppState } from "react-native";

import Inbox from "@/app/index";
import { type Conversation, markRead } from "@/lib/conversation";
import { type InboxView, type Page, type Row, rowPath } from "@/lib/inbox";

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
const mockApi = jest.fn<(path: string, init?: unknown) => Promise<unknown>>();
const mockSetProject = jest.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const mockSignOut = jest.fn<() => Promise<void>>(() => Promise.resolve());
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: mockSession, setProject: mockSetProject, signOut: mockSignOut }),
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

  /** Serves the list, and holds each change (PATCH) until the test answers it. */
  function serveChanges(rows: Row[], view = "open") {
    serve({ [`/conversations?view=${view}&limit`]: page(rows) });
    const served = mockApi.getMockImplementation()!;
    const changes: { path: string; body: unknown; answer: (ok: boolean, why?: string) => void }[] = [];
    mockApi.mockImplementation((path, init) => {
      const { method, body } = (init ?? {}) as { method?: string; body?: unknown };
      if (method !== "PATCH") {
        return served(path);
      }
      return new Promise((resolve, reject) =>
        changes.push({ path, body, answer: (ok, why) => (ok ? resolve({ status: "closed", assignee: null, spam: false, snoozedUntil: null }) : reject(new Error(why))) }),
      );
    });
    return changes;
  }
  const rowNamed = (subject: string) => screen.getByRole("button", { name: new RegExp(`: ${subject} \\(#`) });
  // The actions behind a row (drawn beside it under Jest), hidden from screen readers: the row has them as its actions.
  const pressAction = (label: string, i = 0) => fireEvent.press(screen.getAllByText(label, { includeHiddenElements: true })[i]!);

  it("closes it: gone from the list at once, and the counts fetched again once the server has it", async () => {
    const closing = row("Invite link expired");
    const changes = serveChanges([row("CSV export stops at 500 rows"), closing]);
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    await pressAction("Close", 1);
    expect(screen.queryByText("Invite link expired")).toBeNull();
    expect(changes.map(({ path, body }) => ({ path, body }))).toEqual([{ path: `/conversations/${closing.number}`, body: { status: "closed" } }]);

    const counted = mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length;
    await act(async () => changes[0]!.answer(true));
    expect(screen.queryByText("Invite link expired")).toBeNull();
    expect(screen.getByText("CSV export stops at 500 rows")).toBeTruthy();
    expect(mockApi.mock.calls.filter(([path]) => path === "/inbox/views").length).toBe(counted + 1);
  });

  it("puts it back, saying why in an alert (it may be far down the list), when the server refuses", async () => {
    const changes = serveChanges([row("Invite link expired")]);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    await pressAction("Close");
    expect(screen.queryByText("Invite link expired")).toBeNull();
    await act(async () => changes[0]!.answer(false, "You can't change this conversation."));
    expect(screen.getByText("Invite link expired")).toBeTruthy();
    expect(alert).toHaveBeenCalledWith(`Couldn't close "Invite link expired"`, "You can't change this conversation.");
  });

  it("isn't undone by a reload that started before the server had it, nor kept over one that started after", async () => {
    const closing = row("Invite link expired");
    const changes = serveChanges([row("CSV export stops at 500 rows"), closing]);
    await render(<Inbox />);
    await screen.findByText("Invite link expired");

    // A reload (pull to refresh) starts, and answers only after the close: it still lists it, open.
    let answerReload!: (page: Page) => void;
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path.startsWith("/conversations?view=open&limit") ? new Promise((resolve) => (answerReload = resolve)) : served(path, init)));
    await pressAction("Close", 1);
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    await act(async () => changes[0]!.answer(true));
    await act(async () => answerReload(page([row("CSV export stops at 500 rows"), closing])));
    expect(screen.queryByText("Invite link expired")).toBeNull();

    // Reopened since (on the web): a reload started now lists it.
    mockApi.mockImplementation((path, init) => (path.startsWith("/conversations?view=open&limit") ? Promise.resolve(page([closing])) : served(path, init)));
    await act(async () => mockLive!({ kind: "all" }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.getByText("Invite link expired")).toBeTruthy();
  });

  it("isn't undone by a live update that fetched its row before the server had the change", async () => {
    const closing = row("Invite link expired");
    const changes = serveChanges([closing]);
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    // The stream says it changed; its row, fetched meanwhile, is still open.
    let answerRow!: (page: Page) => void;
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (path === rowPath("open", closing.number) ? new Promise((resolve) => (answerRow = resolve)) : served(path, init)));
    await act(async () => mockLive!({ kind: "conversation", number: closing.number }));
    await act(() => jest.advanceTimersByTimeAsync(200));
    expect(screen.queryByText("Invite link expired")).toBeNull();

    // The change answers, then the row fetched before it: it stays closed.
    await act(async () => changes[0]!.answer(true));
    await act(async () => answerRow(page([closing])));
    expect(screen.queryByText("Invite link expired")).toBeNull();
  });

  it("snoozes it till the time chosen from the details sheet's choices", async () => {
    const snoozing = row("Invite link expired");
    const changes = serveChanges([snoozing]);
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
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
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(changes[0]!.body).toEqual({ snoozedUntil: tomorrow.toISOString() });
  });

  it("offers Wake now in Snoozed, and nothing for a closed one", async () => {
    serveChanges([row("Invite link expired"), row("Old one", { status: "closed" })], "snoozed");
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
    await render(<Inbox />);
    await fireEvent.press(await screen.findByRole("tab", { name: "Snoozed" }));
    await screen.findByText("Old one");

    expect(screen.getAllByText("Close", { includeHiddenElements: true })).toHaveLength(1);
    expect(rowNamed("Old one").props.accessibilityActions).toEqual([]);
    await pressAction("Snooze");
    expect(sheet.mock.calls[0]![0].options).toEqual(["In 3 hours", "Tomorrow, 9:00", "Monday, 9:00", "Wake now", "Cancel"]);
  });

  it("keeps a swipe to its project: another project's conversation with the same number stays", async () => {
    const closing = row("Invite link expired");
    const changes = serveChanges([closing]);
    await render(<Inbox />);
    await screen.findByText("Invite link expired");
    await pressAction("Close");

    // Kite Labs is chosen before the server answers; its own conversation has the same number.
    const served = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) =>
      path.startsWith("/conversations?view=open&limit") && mockSession.project === "kite" ? Promise.resolve(page([{ ...closing, subject: "Kite's own" }])) : served(path, init),
    );
    try {
      mockSession.project = "kite";
      await screen.rerender(<Inbox />);
      expect(await screen.findByText("Kite's own")).toBeTruthy();
      await act(async () => changes[0]!.answer(true));
      expect(screen.getByText("Kite's own")).toBeTruthy();
    } finally {
      mockSession.project = "acme";
    }
  });

  it("offers Close but not Snooze in Spam, as the details sheet", async () => {
    serveChanges([row("Win a prize")], "spam");
    await render(<Inbox />);
    await fireEvent.press(await screen.findByRole("tab", { name: "Spam" }));
    await screen.findByText("Win a prize");

    expect(screen.queryAllByText("Snooze", { includeHiddenElements: true })).toHaveLength(0);
    expect(rowNamed("Win a prize").props.accessibilityActions).toEqual([{ name: "close", label: "Close" }]);
  });

  it("gives a screen reader the same actions on the row", async () => {
    const changes = serveChanges([row("Invite link expired")]);
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
