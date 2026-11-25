import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";

import Inbox from "@/app/index";
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
  return { Stack: { Toolbar, SearchBar }, router: { push: jest.fn() } };
});

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockApi = jest.fn<(path: string) => Promise<unknown>>();
const mockSetProject = jest.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const mockSignOut = jest.fn<() => Promise<void>>(() => Promise.resolve());
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: mockSession, setProject: mockSetProject, signOut: mockSignOut }),
}));
// The stream is tested on its own (src/lib/live.test.ts): here the test sends its updates.
let mockLive: ((update: { kind: "all" } | { kind: "conversation"; number: number }) => void) | null = null;
jest.mock("@/lib/live", () => ({
  openLive: (_session: unknown, onUpdate: typeof mockLive) => {
    mockLive = onUpdate;
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
});
