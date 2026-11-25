import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

import Snooze, { pickSnooze } from "@/app/inbox/snooze";

const mockBack = jest.fn();
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { back: () => mockBack(), push: (to: unknown) => mockPush(to) },
  useLocalSearchParams: () => mockParams,
}));

afterEach(() => void jest.restoreAllMocks());

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
    const [number, at] = chosen.mock.calls[0] as [number, Date];
    expect(number).toBe(12);
    expect(Math.abs(at.getTime() - (Date.now() + 3 * 3_600_000))).toBeLessThan(5_000);
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
});
