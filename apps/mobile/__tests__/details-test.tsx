import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, BackHandler } from "react-native";

import Details from "@/app/conversation/[number]/details";
import { type Assignee, getTriage, type Person, screenKey, showTriage, type Triage } from "@/lib/details";

const mockBack = jest.fn();
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { back: () => mockBack(), push: (href: string) => mockPush(href) },
  useLocalSearchParams: () => ({ number: mockNumber }),
}));

let mockNumber = "12";
const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const mockApi = jest.fn<(path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>>();
jest.mock("@/lib/session", () => ({
  useApi: () => mockApi,
  useSession: () => ({ session: mockSession }),
}));

const KEY = screenKey(mockSession, 12);

const SAM: Person = {
  id: "user-42",
  name: "Sam Lee",
  email: "e2e-sam@example.com",
  verified: true,
  account: true,
  blocked: false,
  maybe: null,
  properties: [
    { key: "plan", label: "Plan", text: "Business" },
    { key: "mrr", label: "MRR", text: "$1,200" },
  ],
  groups: [{ key: "enterprise", name: "Enterprise" }],
  posts: [{ number: 7, title: "Export to CSV", status: "planned" }],
  postCount: 3,
  votes: [],
  voteCount: 0,
  conversations: [{ number: 9, subject: "Invoices", status: "closed", lastMessageAt: "2026-11-12T09:30:00.000Z", line: "Where do I find last month's invoice?" }],
  conversationCount: 1,
};

const EMAIL_ONLY: Person = {
  ...SAM,
  id: null,
  name: null,
  email: "e2e-visitor@example.com",
  verified: false,
  account: false,
  blocked: true,
  maybe: { name: "Sam Lee", id: "user-42" },
  properties: [],
  groups: [],
  posts: [],
  postCount: 0,
  conversations: [],
  conversationCount: 0,
};

const TEAM: Assignee[] = [
  { name: "Olive Owner", email: "e2e-olive@example.com", image: null, you: false },
  { name: "Ravi Kumar", email: "e2e-ravi@example.com", image: null, you: true },
];

const OPEN: Triage = { status: "open", assignee: null, spam: false, snoozedUntil: null };

/** The server: the person and the team, and each update answered with the conversation as it is then. */
function serve(person: Person, triage: Triage = OPEN) {
  let now = triage;
  mockApi.mockImplementation((path, init) => {
    if (path === "/conversations/12/person") {
      return Promise.resolve(person);
    }
    if (path === "/inbox/assignees") {
      return Promise.resolve({ assignees: TEAM });
    }
    if (path === "/conversations/12" && !init) {
      return Promise.resolve(now);
    }
    if (path === "/conversations/12" && init?.method === "PATCH") {
      const body = init.body as Record<string, unknown>;
      const assignee = "assignee" in body ? (TEAM.find((a) => a.email === body.assignee) ?? null) : now.assignee;
      now = { ...now, ...body, assignee: assignee && { name: assignee.name, email: assignee.email } } as Triage;
      return Promise.resolve(now);
    }
    return new Promise(() => {});
  });
  showTriage(KEY, triage);
}

const patches = () => mockApi.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => init!.body);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-25T14:00:00") });
  mockNumber = "12";
});
afterEach(() => {
  jest.useRealTimers();
  mockApi.mockReset();
  mockBack.mockReset();
  mockPush.mockReset();
});

describe("the details sheet", () => {
  it("shows one of the project's users as the web's panel does, and opens another of their conversations", async () => {
    serve(SAM);
    await render(<Details />);

    expect(await screen.findByText("Sam Lee")).toBeTruthy();
    expect(screen.getByText("e2e-sam@example.com")).toBeTruthy();
    expect(screen.getByText("id user-42")).toBeTruthy();
    expect(screen.getByText("Enterprise")).toBeTruthy();
    expect(screen.getByLabelText("MRR, $1,200")).toBeTruthy();
    expect(screen.getByText("Posts · 3")).toBeTruthy();
    expect(screen.getByLabelText("Export to CSV, Planned")).toBeTruthy();
    expect(screen.getByText("No votes on others' posts.")).toBeTruthy();
    expect(screen.queryByText("Known only by this address.")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: /^Invoices, #9, Closed/ }));
    expect(mockBack).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/conversation/9");
  });

  it("shows someone known only by email with the web's notices, and none of a user's posts or votes", async () => {
    serve(EMAIL_ONLY);
    await render(<Details />);

    expect(await screen.findByText("Known only by this address.")).toBeTruthy();
    // Named by their address, as the web does, and it's not verified.
    expect(screen.getByRole("header", { name: "e2e-visitor@example.com" })).toBeTruthy();
    expect(screen.getByText("e2e-visitor@example.com (not verified)")).toBeTruthy();
    expect(screen.getByText("Marked your email as spam, so replies aren't emailed to them any more.")).toBeTruthy();
    expect(screen.getByText("Maybe Sam Lee (not signed in), id user-42")).toBeTruthy();
    expect(screen.queryByText(/^Posts/)).toBeNull();
    expect(screen.queryByText(/^Votes/)).toBeNull();
    expect(screen.getByText("None.")).toBeTruthy();
  });

  it("assigns from the team, you first, and unassigns", async () => {
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Assignee, Unassigned" }));
    const choices = screen.getAllByRole("button").filter((button) => button.props.accessibilityLabel !== "Back");
    expect(choices.map((choice) => choice.props.accessibilityLabel)).toEqual(["You, Ravi Kumar", "Olive Owner", "Unassigned"]);
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeSelected();

    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await fireEvent.press(screen.getByRole("button", { name: "Olive Owner" }));
    expect(patches()).toEqual([{ assignee: "e2e-olive@example.com" }]);
    expect(announce).toHaveBeenLastCalledWith("Assigned to Olive Owner");
    // Back on the details, and on the conversation's header (the same store).
    expect(await screen.findByRole("button", { name: "Assignee, Olive Owner" })).toBeTruthy();
    expect(getTriage(KEY)?.assignee?.name).toBe("Olive Owner");

    await fireEvent.press(screen.getByRole("button", { name: "Assignee, Olive Owner" }));
    await fireEvent.press(screen.getByRole("button", { name: "You, Ravi Kumar" }));
    expect(await screen.findByRole("button", { name: "Assignee, Ravi Kumar (you)" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Assignee, Ravi Kumar (you)" }));
    await fireEvent.press(screen.getByRole("button", { name: "Unassigned" }));
    expect(patches().at(-1)).toEqual({ assignee: null });
    expect(await screen.findByRole("button", { name: "Assignee, Unassigned" })).toBeTruthy();
  });

  it("snoozes with the web's choices, and wakes it", async () => {
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Snooze, Not snoozed" }));
    expect(screen.getByRole("button", { name: "In 3 hours" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Monday, 9:00" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Wake now" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Tomorrow, 9:00" }));
    expect(patches()).toEqual([{ snoozedUntil: new Date("2026-11-26T09:00:00").toISOString() }]);
    expect(await screen.findByRole("button", { name: "Snooze, Snoozed till Thu 26 Nov, 09:00" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: /^Snooze, Snoozed till/ }));
    await fireEvent.press(screen.getByRole("button", { name: "Wake now" }));
    expect(patches().at(-1)).toEqual({ snoozedUntil: null });
    expect(await screen.findByRole("button", { name: "Snooze, Not snoozed" })).toBeTruthy();
  });

  it("closes and reopens, and says so to screen readers", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    expect(patches()).toEqual([{ status: "closed" }]);
    expect(await screen.findByLabelText("Status, Closed")).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Closed");
    // Closed: nothing to snooze.
    expect(screen.queryByRole("button", { name: /^Snooze/ })).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Reopen" }));
    expect(patches().at(-1)).toEqual({ status: "open" });
    expect(await screen.findByLabelText("Status, Needs reply")).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Reopened");
  });

  it("keeps a change made here when the status fetched on opening answers after it", async () => {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    let opened: (value: unknown) => void = () => {};
    mockApi.mockImplementation((path, init) => (path === "/conversations/12" && !init ? new Promise((resolve) => (opened = resolve)) : answer(path, init)));
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    expect(await screen.findByLabelText("Status, Closed")).toBeTruthy();
    // The fetch from before the close answers: open, as it was then.
    await act(async () => opened(OPEN));
    expect(screen.getByLabelText("Status, Closed")).toBeTruthy();
  });

  it("marks it as spam and back", async () => {
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Mark as spam" }));
    expect(patches()).toEqual([{ spam: true }]);
    await fireEvent.press(await screen.findByRole("button", { name: "Not spam" }));
    expect(patches().at(-1)).toEqual({ spam: false });
    expect(await screen.findByRole("button", { name: "Mark as spam" })).toBeTruthy();
  });

  it("says why a change didn't happen, in the server's words", async () => {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (init?.method === "PATCH" ? Promise.reject(new Error("A closed conversation isn't snoozed")) : answer(path, init)));
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    expect(await screen.findByText("A closed conversation isn't snoozed")).toBeTruthy();
    expect(getTriage(KEY)?.status).toBe("open");
    await act(() => jest.advanceTimersByTimeAsync(0));
  });

  it("says when the team didn't load, and Try again loads it", async () => {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    let down = true;
    mockApi.mockImplementation((path, init) => (path === "/inbox/assignees" && down ? Promise.reject(new Error("Couldn't reach tuti.example.com.")) : answer(path, init)));
    await render(<Details />);

    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();
    // No team to choose from: Assignee opens nothing.
    expect(screen.queryByRole("button", { name: /^Assignee/ })).toBeNull();
    down = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Assignee, Unassigned" })).toBeTruthy();
    expect(screen.queryByText("Couldn't reach tuti.example.com.")).toBeNull();
  });

  it("says when who it's with didn't load, and Try again loads them", async () => {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    let down = true;
    mockApi.mockImplementation((path, init) => (path === "/conversations/12/person" && down ? Promise.reject(new Error("Conversation not found")) : answer(path, init)));
    await render(<Details />);

    expect(await screen.findByText("Conversation not found")).toBeTruthy();
    down = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sam Lee")).toBeTruthy();
  });

  it("opened by a link, fetches the conversation's status, and says when it can't", async () => {
    mockNumber = "13";
    let down = true;
    mockApi.mockImplementation((path) => {
      if (path === "/conversations/13") {
        return down ? Promise.reject(new Error("Couldn't reach tuti.example.com.")) : Promise.resolve({ ...OPEN, status: "closed", number: 13 });
      }
      return path === "/inbox/assignees" ? Promise.resolve({ assignees: TEAM }) : Promise.resolve(EMAIL_ONLY);
    });
    await render(<Details />);

    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    down = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(getTriage(screenKey(mockSession, 13))?.status).toBe("closed");
  });

  it("goes back from a list to the details on Android's back", async () => {
    type Handler = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: Handler[] = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: () => void handlers.splice(handlers.indexOf(handler), 1) };
    });
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Assignee, Unassigned" }));
    expect(screen.getByText("Assign")).toBeTruthy();
    let handled = false;
    await act(async () => void (handled = !!handlers.at(-1)?.({} as Parameters<Handler>[0])));
    expect(handled).toBe(true);
    expect(await screen.findByRole("button", { name: "Assignee, Unassigned" })).toBeTruthy();
  });

  it("shows the status as it is now, not one kept from an earlier visit", async () => {
    serve(SAM, { status: "closed", assignee: { name: "Olive Owner", email: "e2e-olive@example.com" }, spam: false, snoozedUntil: null });
    // Kept from an earlier visit: open and nobody's.
    showTriage(KEY, OPEN);
    await render(<Details />);

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assignee, Olive Owner" })).toBeTruthy();
  });
});
