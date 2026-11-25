import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

import Snooze, { pickSnooze } from "@/app/inbox/snooze";

const mockBack = jest.fn();
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { back: () => mockBack(), push: (to: unknown) => mockPush(to), canGoBack: () => true, replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));

beforeEach(() => void jest.useFakeTimers({ now: new Date("2026-11-25T14:00:00") }));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("a row's snooze choices on Android", () => {
  it("opens the sheet, which says the time chosen to whoever asked, and closes", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const chosen = jest.fn();
    pickSnooze(12, false, chosen);
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/inbox/snooze", params: { number: 12, snoozed: "" } });

    mockParams = { number: "12", snoozed: "" };
    await render(<Snooze />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText("Wake now")).toBeNull();
    await fireEvent.press(screen.getByText("In 3 hours"));
    expect(mockBack).toHaveBeenCalled();
    expect(chosen).toHaveBeenCalledWith(12, new Date("2026-11-25T17:00:00"));
  });

  it("offers Wake now for a snoozed one", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const chosen = jest.fn();
    pickSnooze(7, true, chosen);
    mockParams = { number: "7", snoozed: "1" };
    await render(<Snooze />);
    await fireEvent.press(screen.getByText("Wake now"));
    expect(chosen).toHaveBeenCalledWith(7, null);
  });

  it("lets the swipe go once it's closed without a choice: a link to it later snoozes nothing", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const chosen = jest.fn();
    pickSnooze(12, false, chosen);
    mockParams = { number: "12", snoozed: "" };
    const sheet = await render(<Snooze />);
    // Back.
    await sheet.unmount();

    // Even for the same conversation.
    mockBack.mockClear();
    await render(<Snooze />);
    expect(screen.queryByText("In 3 hours")).toBeNull();
    expect(mockBack).toHaveBeenCalled();
    expect(chosen).not.toHaveBeenCalled();
  });

  it("does nothing for a number other than the swipe's, and closes", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const chosen = jest.fn();
    pickSnooze(12, false, chosen);
    mockBack.mockClear();
    mockParams = { number: "99", snoozed: "" };
    await render(<Snooze />);
    expect(screen.queryByText("In 3 hours")).toBeNull();
    expect(mockBack).toHaveBeenCalled();
    expect(chosen).not.toHaveBeenCalled();
  });
});
