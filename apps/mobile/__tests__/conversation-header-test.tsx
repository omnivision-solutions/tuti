import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import ConversationRoute from "@/app/conversation/[number]";
import type { Conversation } from "@/lib/conversation";
import { screenKey, showTriage } from "@/lib/details";

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
const mockApi = jest.fn<(path: string) => Promise<unknown>>();
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: mockSession }),
}));
jest.mock("@/lib/live", () => ({ openLive: () => () => {} }));

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
  });
});
