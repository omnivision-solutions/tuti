import { describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";

import ConversationRoute from "@/app/conversation/[number]";
import { behaviourFor } from "@/lib/notifications";

// The native header as nothing, and the screen's focus as the test says (`mockFocus`).
jest.mock("expo-router", () => {
  const React = require("react");
  const Screen = () => null;
  const useFocusEffect = (effect: () => (() => void) | void) => {
    const [focused, setFocused] = React.useState(true);
    mockSetFocused = setFocused;
    React.useEffect(() => (focused ? effect() : undefined), [focused, effect]);
  };
  return { Stack: { Screen }, router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true }, useFocusEffect, useLocalSearchParams: () => ({ number: "12" }) };
});
let mockSetFocused: (focused: boolean) => void = () => {};
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@/lib/live", () => ({ openLive: () => () => {} }));

const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockApi = jest.fn(async () => ({
  number: 12,
  subject: "CSV export stops at 500 rows",
  status: "open",
  user: { id: "u1", name: "Maya Chen", email: "e2e-maya@example.com", verified: true },
  company: null,
  unread: false,
  onlineUntil: null,
  messages: [],
}));
jest.mock("@/lib/session", () => ({ useApi: () => mockApi, useSession: () => ({ session: mockSession }) }));

const banner = (project: string, conversation: number) => behaviourFor({ request: { content: { data: { project, conversation } } } } as never).shouldShowBanner;

describe("a conversation on screen", () => {
  it("shows no banner for its own notifications while it's in focus, and does again once left", async () => {
    await render(<ConversationRoute />);
    expect(await screen.findByText("CSV export stops at 500 rows")).toBeTruthy();

    expect(banner("acme", 12)).toBe(false);
    expect(banner("acme", 13)).toBe(true);
    expect(banner("kite", 12)).toBe(true);

    // Another screen over it.
    await act(async () => mockSetFocused(false));
    expect(banner("acme", 12)).toBe(true);
    await act(async () => mockSetFocused(true));
    expect(banner("acme", 12)).toBe(false);

    await screen.unmount();
    expect(banner("acme", 12)).toBe(true);
  });
});
