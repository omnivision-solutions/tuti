import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import ConversationRoute from "@/app/conversation/[number]";
import Details from "@/app/conversation/[number]/details";
import type { Conversation } from "@/lib/conversation";
import { getTriage, screenKey, showTriage } from "@/lib/details";

// The native header as plain views: its title and right side drawn where the screen sets them.
jest.mock("expo-router", () => {
  const React = require("react");
  const { View } = require("react-native");
  const Screen = ({ options }: { options: { headerTitle?: unknown; headerRight?: () => unknown } }) =>
    React.createElement(View, null, typeof options.headerTitle === "function" ? options.headerTitle() : null, options.headerRight?.());
  return {
    Stack: { Screen },
    router: { push: (href: string) => mockPush(href), back: jest.fn(), canGoBack: () => true },
    useLocalSearchParams: () => ({ number: "12" }),
    useFocusEffect: (effect: () => void) => React.useEffect(() => effect(), [effect]),
  };
});
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockPush = jest.fn();

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockApi = jest.fn<(path: string, init?: { method?: string }) => Promise<unknown>>();
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: mockSession }),
}));
// The screen's stream (watchLive) is tested on its own: here it never opens.
jest.mock("@/lib/conversation", () => ({ ...jest.requireActual<object>("@/lib/conversation"), watchLive: () => () => {} }));

const CONVERSATION: Conversation = {
  number: 12,
  subject: "CSV export stops at 500 rows",
  status: "open",
  assignee: null,
  spam: false,
  snoozedUntil: null,
  user: { id: null, name: "Maya Chen", email: "e2e-maya@example.com", verified: true },
  company: "Northwind",
  unread: false,
  onlineUntil: null,
  messages: [],
};

afterEach(() => {
  mockApi.mockReset();
});

describe("the conversation's header", () => {
  it("shows its status and assignee, follows the details sheet's changes, and opens it", async () => {
    mockApi.mockResolvedValue(CONVERSATION);
    await render(<ConversationRoute />);

    const standing = await screen.findByRole("button", { name: "Open, unassigned, details" });
    await act(async () => showTriage(screenKey(mockSession, 12), { status: "closed", assignee: { name: "Olive Owner", email: "e2e-olive@example.com" }, spam: false, snoozedUntil: null }));
    expect(screen.getByRole("button", { name: "Closed, assigned to Olive Owner, details" })).toBeTruthy();

    await fireEvent.press(standing);
    expect(mockPush).toHaveBeenCalledWith("/conversation/12/details");
    mockPush.mockClear();
    // Their name opens it too.
    await fireEvent.press(screen.getByRole("header", { name: "Maya Chen, Northwind" }));
    expect(mockPush).toHaveBeenCalledWith("/conversation/12/details");
  });

  it("shows its status only once this visit's fetch has answered, never one kept from an earlier visit", async () => {
    // Kept from an earlier visit: closed, and Olive's.
    showTriage(screenKey(mockSession, 12), { status: "closed", assignee: { name: "Olive Owner", email: "e2e-olive@example.com" }, spam: false, snoozedUntil: null });
    let answer: (value: unknown) => void = () => {};
    mockApi.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await render(<ConversationRoute />);

    expect(screen.queryByRole("button", { name: /details$/ })).toBeNull();
    await act(async () => answer(CONVERSATION));
    expect(await screen.findByRole("button", { name: "Open, unassigned, details" })).toBeTruthy();
  });

  it("forgets its status on leaving, so a sheet opened later by a link fetches the status as it is then", async () => {
    mockApi.mockResolvedValue(CONVERSATION);
    const opened = await render(<ConversationRoute />);
    await screen.findByRole("button", { name: "Open, unassigned, details" });
    await opened.unmount();
    expect(getTriage(screenKey(mockSession, 12))).toBeNull();

    // Closed on the web meanwhile; then `tuti://conversation/12/details`, with no screen under it.
    mockApi.mockImplementation((path) =>
      Promise.resolve(path === "/inbox/assignees" ? { assignees: [] } : path === "/conversations/12" ? { ...CONVERSATION, status: "closed" } : { name: "Maya Chen", email: null, verified: true, account: false, blocked: false, maybe: null, id: null, properties: [], groups: [], posts: [], postCount: 0, votes: [], voteCount: 0, conversations: [], conversationCount: 0 }),
    );
    const sheet = await render(<Details />);
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    await sheet.unmount();
    expect(getTriage(screenKey(mockSession, 12))).toBeNull();
  });

  it("keeps its status when the details sheet over it closes", async () => {
    mockApi.mockImplementation((path) =>
      Promise.resolve(path === "/inbox/assignees" ? { assignees: [] } : path === "/conversations/12" ? CONVERSATION : { name: "Maya Chen", email: null, verified: true, account: false, blocked: false, maybe: null, id: null, properties: [], groups: [], posts: [], postCount: 0, votes: [], voteCount: 0, conversations: [], conversationCount: 0 }),
    );
    await render(<ConversationRoute />);
    await screen.findByRole("button", { name: "Open, unassigned, details" });

    const sheet = await render(<Details />);
    await screen.findByRole("button", { name: "Close" });
    await sheet.unmount();
    expect(getTriage(screenKey(mockSession, 12))).not.toBeNull();
  });

  it("keeps its status when a sheet opened before its fetch answered closes", async () => {
    const asked: ((value: unknown) => void)[] = [];
    mockApi.mockImplementation((path) =>
      path === "/conversations/12"
        ? new Promise((resolve) => asked.push(resolve))
        : Promise.resolve(path === "/inbox/assignees" ? { assignees: [] } : { name: "Maya Chen", email: null, verified: true, account: false, blocked: false, maybe: null, id: null, properties: [], groups: [], posts: [], postCount: 0, votes: [], voteCount: 0, conversations: [], conversationCount: 0 }),
    );
    const opened = await render(<ConversationRoute />);
    // The sheet opens over it (a link) while the screen's fetch is out, so it fetches too; both answer.
    const sheet = await render(<Details />);
    expect(asked).toHaveLength(2);
    await act(async () => asked.forEach((answer) => answer(CONVERSATION)));
    await sheet.unmount();

    expect(getTriage(screenKey(mockSession, 12))).not.toBeNull();
    expect(opened.getByRole("button", { name: "Open, unassigned, details" })).toBeTruthy();
  });

  it("takes a change that answers after the sheet closed, while the screen is still open", async () => {
    let patched: (value: unknown) => void = () => {};
    mockApi.mockImplementation((path, init?: { method?: string }) =>
      init?.method === "PATCH"
        ? new Promise((resolve) => (patched = resolve))
        : Promise.resolve(path === "/inbox/assignees" ? { assignees: [] } : path === "/conversations/12" ? CONVERSATION : { name: "Maya Chen", email: null, verified: true, account: false, blocked: false, maybe: null, id: null, properties: [], groups: [], posts: [], postCount: 0, votes: [], voteCount: 0, conversations: [], conversationCount: 0 }),
    );
    const opened = await render(<ConversationRoute />);
    await screen.findByRole("button", { name: "Open, unassigned, details" });
    const sheet = await render(<Details />);
    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    await sheet.unmount();

    // The close answers once the sheet has gone: the header, still open, shows it.
    await act(async () => patched({ ...CONVERSATION, status: "closed" }));
    expect(opened.getByRole("button", { name: "Closed, unassigned, details" })).toBeTruthy();
  });

  it("doesn't put back what the details sheet changed while its fetch was on its way", async () => {
    let answer: (value: unknown) => void = () => {};
    mockApi.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await render(<ConversationRoute />);

    // The sheet closes it while the screen's fetch, from before, is still out.
    await act(async () => showTriage(screenKey(mockSession, 12), { status: "closed", assignee: null, spam: false, snoozedUntil: null }));
    await act(async () => answer(CONVERSATION));
    expect(await screen.findByRole("button", { name: "Closed, unassigned, details" })).toBeTruthy();
  });
});
