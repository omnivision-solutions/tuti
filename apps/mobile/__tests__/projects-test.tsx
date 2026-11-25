import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";

import Projects from "@/app/inbox/projects";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({ router: { back: () => mockBack() } }));

const mockSetProject = jest.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const mockSignOut = jest.fn<() => Promise<void>>(() => Promise.resolve());
const mockApi = async () => ({
  projects: [
    { slug: "acme", name: "Acme", role: "OWNER", openConversations: 14 },
    { slug: "kite", name: "Kite Labs", role: "MEMBER", openConversations: 1 },
  ],
});
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: { project: "acme" }, setProject: mockSetProject, signOut: mockSignOut }),
}));

describe("the project switcher's sheet (Android)", () => {
  it("lists the projects with the chosen one marked, and switches to the one tapped", async () => {
    await render(<Projects />);

    expect(await screen.findByText("1 open conversation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Acme/ })).toBeSelected();
    await fireEvent.press(screen.getByRole("button", { name: /^Kite Labs/ }));
    expect(mockBack).toHaveBeenCalled();
    expect(mockSetProject).toHaveBeenCalledWith("kite");
  });

  it("signs out once confirmed", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await render(<Projects />);

    await fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));
    expect(mockSignOut).not.toHaveBeenCalled();
    await act(async () => alert.mock.calls[0]![2]!.find((button) => button.text === "Sign out")!.onPress!());
    expect(mockSignOut).toHaveBeenCalled();
  });
});
