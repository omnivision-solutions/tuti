import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, BackHandler } from "react-native";

import Details, { ActivitySection } from "@/app/conversation/[number]/details";
import { behaviourFor, lookAt } from "@/lib/notifications";
import { startCache } from "@/lib/offline";
import { useColors } from "@/lib/theme";
import { ApiError } from "@/lib/api";
import { type Activity, type Assignee, getTriage, holdTriage, type Person, screenKey, showTriage, type Triage, triageChanges } from "@/lib/details";

const mockBack = jest.fn();
const mockPush = jest.fn();
// The sheet's focus as the test says (`mockSetFocused`): a screen opened over it takes it.
jest.mock("expo-router", () => {
  const React = require("react");
  const useFocusEffect = (effect: () => (() => void) | void) => {
    const [focused, setFocused] = React.useState(true);
    mockSetFocused = setFocused;
    React.useEffect(() => (focused ? effect() : undefined), [focused, effect]);
  };
  return {
    router: { back: () => mockBack(), push: (href: string) => mockPush(href) },
    useLocalSearchParams: () => ({ number: mockNumber }),
    useFocusEffect,
  };
});
let mockSetFocused: (focused: boolean) => void = () => {};

let mockNumber = "12";
const mockSession = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme", owner: "owner-1" };
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
      // As conversations.update answers: without conversations.get's `handBack`.
      const { handBack: _handBack, ...answer } = now;
      return Promise.resolve(answer);
    }
    return new Promise(() => {});
  });
  // The conversation screen under the sheet, which holds its status and has fetched it.
  screenUnder = holdTriage(KEY);
  showTriage(KEY, triage);
}

/** The person, for the tests' servers that answer only the team and the conversation; the Activity never answers. */
const elsewhere = (path: string) => (path.includes("/activity") ? new Promise(() => {}) : Promise.resolve(EMAIL_ONLY));

const patches = () => mockApi.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => init!.body);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-25T14:00:00") });
  mockNumber = "12";
});
let screenUnder: (() => void) | null = null;

afterEach(() => {
  screenUnder?.();
  screenUnder = null;
  jest.useRealTimers();
  mockApi.mockReset();
  mockBack.mockReset();
  mockPush.mockReset();
});

describe("the details sheet", () => {
  it("shows no banner for its conversation's notifications while it's open", async () => {
    serve(SAM);
    const banner = () => behaviourFor({ request: { content: { title: "Ada · Acme", data: { project: "acme", conversation: 12 } } } } as never).shouldShowBanner;
    await render(<Details />);
    expect(await screen.findByText("Sam Lee")).toBeTruthy();
    expect(banner()).toBe(false);
    await screen.unmount();
    expect(banner()).toBe(true);
  });

  it("marks its conversation while in focus, also again after a conversation opened over it closes", async () => {
    serve(SAM);
    const banner = () => behaviourFor({ request: { content: { title: "Ada · Acme", data: { project: "acme", conversation: 12 } } } } as never).shouldShowBanner;
    // The conversation's screen under it had marked it, and blurs as the sheet focuses: its release leaves the sheet's mark.
    const conversation = lookAt({ project: "acme", number: 12 });
    await render(<Details />);
    await screen.findByText("Sam Lee");
    conversation();
    expect(banner()).toBe(false);

    // A notification's conversation opened over the sheet, then closed.
    await act(async () => mockSetFocused(false));
    const over = lookAt({ project: "acme", number: 30 });
    over();
    expect(banner()).toBe(true);
    await act(async () => mockSetFocused(true));
    expect(banner()).toBe(false);
  });

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


  it("marks it as spam and back", async () => {
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Mark as spam" }));
    expect(patches()).toEqual([{ spam: true }]);
    await fireEvent.press(await screen.findByRole("button", { name: "Not spam" }));
    expect(patches().at(-1)).toEqual({ spam: false });
    expect(await screen.findByRole("button", { name: "Mark as spam" })).toBeTruthy();
  });

  it("marks it priority and back, and says so to screen readers", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    serve(SAM, { ...OPEN, priority: false });
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Mark priority" }));
    expect(patches()).toEqual([{ priority: true }]);
    expect(getTriage(KEY)?.priority).toBe(true);
    expect(announce).toHaveBeenLastCalledWith("Marked priority");
    await fireEvent.press(await screen.findByRole("button", { name: "Not priority" }));
    expect(patches().at(-1)).toEqual({ priority: false });
    expect(announce).toHaveBeenLastCalledWith("No longer priority");
    expect(await screen.findByRole("button", { name: "Mark priority" })).toBeTruthy();
  });

  it("offers no priority on a server from before it, which would refuse the change", async () => {
    // Its answer has no `priority`.
    serve(SAM);
    await render(<Details />);
    expect(await screen.findByRole("button", { name: "Mark as spam" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /priority/i })).toBeNull();
  });

  it("says With AI as the status of one the AI has, never Needs reply, and offers no hand back on it", async () => {
    serve(SAM, { ...OPEN, handledBy: "ai", handBack: false });
    await render(<Details />);
    expect(await screen.findByLabelText("Status, With AI")).toBeTruthy();
    expect(screen.queryByLabelText("Status, Needs reply")).toBeNull();
    expect(screen.queryByRole("button", { name: /hand back/i })).toBeNull();

    // The team's, where the server doesn't offer it (someone waits, or the AI wouldn't answer), or a server from before
    // it (no `handBack`): not offered.
    await act(async () => showTriage(KEY, { ...OPEN, handledBy: "team", handBack: false }));
    expect(screen.getByLabelText("Status, Needs reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /hand back/i })).toBeNull();
    await act(async () => showTriage(KEY, { ...OPEN, handledBy: "team" }));
    expect(screen.queryByRole("button", { name: /hand back/i })).toBeNull();
  });

  it("hands one back to the AI where the server offers it, asking it to refuse if the user waits, and says so to screen readers", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    serve(SAM, { ...OPEN, handledBy: "team", handBack: true });
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Hand back to the AI" }));
    expect(patches()).toEqual([{ handledBy: "ai", ifNobodyWaits: true }]);
    expect(getTriage(KEY)?.handledBy).toBe("ai");
    expect(announce).toHaveBeenLastCalledWith("Handed back to the AI");
    expect(await screen.findByLabelText("Status, With AI")).toBeTruthy();
    // The AI's now (the update's answer doesn't offer it): nothing more to hand back.
    await act(async () => showTriage(KEY, { ...getTriage(KEY)!, handBack: false }));
    expect(screen.queryByRole("button", { name: /hand back/i })).toBeNull();
  });

  it("keeps Hand back offered through another change, whose answer doesn't say", async () => {
    serve(SAM, { ...OPEN, handledBy: "team", priority: false, handBack: true });
    await render(<Details />);
    await fireEvent.press(await screen.findByRole("button", { name: "Mark priority" }));
    expect(patches()).toEqual([{ priority: true }]);
    expect(await screen.findByRole("button", { name: "Hand back to the AI" })).toBeTruthy();
  });

  it("offers no Hand back once it's marked as spam, which the AI never answers", async () => {
    serve(SAM, { ...OPEN, handledBy: "team", handBack: true });
    await render(<Details />);
    await fireEvent.press(await screen.findByRole("button", { name: "Mark as spam" }));
    expect(await screen.findByRole("button", { name: "Not spam" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hand back to the AI" })).toBeNull();
  });

  it("says why it wasn't handed back, in the server's words, where the user wrote meanwhile", async () => {
    serve(SAM, { ...OPEN, handledBy: "team", handBack: true });
    const answer = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => (init?.method === "PATCH" ? Promise.reject(new Error("Reply first: they're waiting on your team.")) : answer(path, init)));
    await render(<Details />);
    await fireEvent.press(await screen.findByRole("button", { name: "Hand back to the AI" }));
    expect(await screen.findByText("Reply first: they're waiting on your team.")).toBeTruthy();
    expect(getTriage(KEY)?.handledBy).toBe("team");
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
      return path === "/inbox/assignees" ? Promise.resolve({ assignees: TEAM }) : elsewhere(path);
    });
    await render(<Details />);

    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    // Who has it isn't known: no list that would mark someone.
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("button", { name: /^Assignee/ })).toBeNull();
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

  it("takes the status the screen under it keeps, without fetching the whole conversation", async () => {
    serve(SAM, { ...OPEN, status: "closed" });
    // What the screen under it fetched on this visit.
    showTriage(KEY, { ...OPEN, status: "waiting" });
    await render(<Details />);

    expect(await screen.findByLabelText("Status, Waiting on user")).toBeTruthy();
    expect(mockApi.mock.calls.map(([path]) => path)).not.toContain("/conversations/12");
  });

  it("puts a screen reader back on the row a list was opened from: after a choice, Back, and Android's back", async () => {
    type Handler = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: Handler[] = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: () => void handlers.splice(handlers.indexOf(handler), 1) };
    });
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
    const focused = () => {
      const [[row, kind]] = focus.mock.calls.slice(-1) as unknown as [[{ props: { accessibilityLabel: string } }, string]];
      return `${kind}: ${row.props.accessibilityLabel}`;
    };
    serve(SAM);
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Assignee, Unassigned" }));
    await fireEvent.press(screen.getByRole("button", { name: "Olive Owner" }));
    await screen.findByRole("button", { name: "Assignee, Olive Owner" });
    expect(focused()).toBe("focus: Assignee, Olive Owner");

    await fireEvent.press(screen.getByRole("button", { name: "Snooze, Not snoozed" }));
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(focused()).toBe("focus: Snooze, Not snoozed");

    focus.mockClear();
    await fireEvent.press(screen.getByRole("button", { name: "Assignee, Olive Owner" }));
    await act(async () => void handlers.at(-1)?.({} as Parameters<Handler>[0]));
    expect(focused()).toBe("focus: Assignee, Olive Owner");
  });

  it("opened by a link and closed before its fetch answers, fetches again the next time", async () => {
    mockNumber = "13";
    const asked: ((value: unknown) => void)[] = [];
    mockApi.mockImplementation((path) => {
      if (path === "/conversations/13") {
        return new Promise((resolve) => asked.push(resolve));
      }
      return path === "/inbox/assignees" ? Promise.resolve({ assignees: TEAM }) : elsewhere(path);
    });
    const first = await render(<Details />);
    await first.unmount();
    // The first opening's fetch answers after it closed: open, as it was then.
    await act(async () => asked[0]!({ ...OPEN, number: 13 }));
    expect(getTriage(screenKey(mockSession, 13))).toBeNull();

    // Closed on the web meanwhile: opened again, it fetches.
    await render(<Details />);
    expect(asked).toHaveLength(2);
    await act(async () => asked[1]!({ ...OPEN, status: "closed", number: 13 }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("drops a change that answers after the sheet closed, so a sheet opened later by a link fetches", async () => {
    mockNumber = "14";
    const gets: ((value: unknown) => void)[] = [];
    let patched: (value: unknown) => void = () => {};
    mockApi.mockImplementation((path, init) => {
      if (path === "/conversations/14") {
        return init?.method === "PATCH" ? new Promise((resolve) => (patched = resolve)) : new Promise((resolve) => gets.push(resolve));
      }
      return path === "/inbox/assignees" ? Promise.resolve({ assignees: TEAM }) : elsewhere(path);
    });
    const first = await render(<Details />);
    await act(async () => gets[0]!({ ...OPEN, number: 14 }));
    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    await first.unmount();
    // The close answers after the sheet (and anything under it) has gone.
    await act(async () => patched({ ...OPEN, status: "closed", number: 14 }));
    expect(getTriage(screenKey(mockSession, 14))).toBeNull();

    // Reopened on the web meanwhile: opened again by a link, it fetches.
    await render(<Details />);
    expect(gets).toHaveLength(2);
    await act(async () => gets[1]!({ ...OPEN, status: "waiting", number: 14 }));
    expect(await screen.findByLabelText("Status, Waiting on user")).toBeTruthy();
  });

  it("drops its own fetch's failure once the status comes from the screen under it", async () => {
    mockNumber = "15";
    const key = screenKey(mockSession, 15);
    // The screen under it, its fetch still out: nothing stored yet, so the sheet fetches too.
    const under = holdTriage(key);
    const since = triageChanges(key);
    mockApi.mockImplementation((path) =>
      path === "/conversations/15" ? Promise.reject(new Error("Couldn't reach tuti.example.com.")) : path === "/inbox/assignees" ? Promise.resolve({ assignees: TEAM }) : elsewhere(path),
    );
    await render(<Details />);
    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();

    // The screen's fetch answers.
    await act(async () => showTriage(key, OPEN, since));
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByText("Couldn't reach tuti.example.com.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    under();
  });

  it("turns the actions off, still focusable, while a change runs", async () => {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    let patched: (value: unknown) => void = () => {};
    mockApi.mockImplementation((path, init) => (init?.method === "PATCH" ? new Promise((resolve) => (patched = resolve)) : answer(path, init)));
    await render(<Details />);

    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark as spam" })).toBeDisabled();
    // A press meanwhile is ignored: one change at a time.
    await fireEvent.press(screen.getByRole("button", { name: "Mark as spam" }));
    expect(patches()).toEqual([{ status: "closed" }]);
    await act(async () => patched({ ...OPEN, status: "closed" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeEnabled();

    await fireEvent.press(screen.getByRole("button", { name: "Assignee, Unassigned" }));
    await fireEvent.press(screen.getByRole("button", { name: "Olive Owner" }));
    expect(screen.getByRole("button", { name: "You, Ravi Kumar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Olive Owner" })).toBeDisabled();
    await act(async () => patched({ ...OPEN, status: "closed", assignee: { name: "Olive Owner", email: "e2e-olive@example.com" } }));
    expect(await screen.findByRole("button", { name: "Assignee, Olive Owner" })).toBeEnabled();
  });
});

const event = (id: string, at: string, fields: Partial<Activity["events"][number]> = {}): Activity["events"][number] => ({
  id,
  kind: "status",
  actor: "teammate",
  who: "Olive Owner",
  text: "closed it",
  detail: null,
  workflows: [],
  createdAt: at,
  ...fields,
});
const RUN = event("e3", "2026-11-25T10:02:00", {
  kind: "workflows_ran",
  actor: "workflow",
  who: "A conversation starts",
  text: "ran",
  detail: "2 workflows checked",
  workflows: [
    { name: "Priority for paying plans", what: "marked this priority" },
    { name: "Enterprise to Olive", what: "didn't match (not in Enterprise)" },
  ],
});
const CLOSED = event("e2", "2026-11-12T09:30:00");
const SPAM = event("e1", "2026-11-12T09:00:00", { kind: "spam_filter", actor: "spam_filter", who: "The spam filter", text: "let it through", detail: "a known user" });
const NETWORK = "Couldn't reach tuti.example.com.";

describe("the details sheet's Activity", () => {
  /** The sheet's server, its Activity answered by `activity` (the path's query as an object). */
  function serveActivity(activity: (query: Record<string, string>) => Promise<unknown>) {
    serve(SAM);
    const answer = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => {
      const [route, query] = path.split("?");
      return route === "/conversations/12/activity" ? activity(Object.fromEntries(new URLSearchParams(query))) : answer(path, init);
    });
  }
  const activityAsked = () => mockApi.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/conversations/12/activity"));

  beforeEach(() => {
    startCache(mockSession.owner);
  });

  it("shows each row in the server's words, newest first, with its time, detail and the workflows a run checked, and pages back", async () => {
    serveActivity(({ before }) => Promise.resolve(before === "e2" ? { events: [SPAM], next: null } : { events: [RUN, CLOSED], next: "e2" }));
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
    focus.mockClear();
    await render(<Details />);

    expect(await screen.findByText("A conversation starts")).toBeTruthy();
    expect(screen.getByText("10:02 · 2 workflows checked")).toBeTruthy();
    expect(screen.getByLabelText("A conversation starts ran, 10:02, 2 workflows checked, Priority for paying plans: marked this priority, Enterprise to Olive: didn't match (not in Enterprise)")).toBeTruthy();
    expect(screen.getByText("Priority for paying plans")).toBeTruthy();
    expect(screen.getByText("Enterprise to Olive")).toBeTruthy();
    expect(screen.getByText(/didn't match \(not in Enterprise\)/)).toBeTruthy();
    expect(screen.getByText("Olive Owner")).toBeTruthy();
    expect(screen.getByText("12 Nov, 09:30")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" })).toBeSelected();
    expect(activityAsked()).toEqual(["/conversations/12/activity?filter=all"]);

    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(activityAsked()).toContain("/conversations/12/activity?filter=all&before=e2");
    expect(await screen.findByText("The spam filter")).toBeTruthy();
    expect(screen.getByText("12 Nov, 09:00 · a known user")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
    // A screen reader goes on to the first of the earlier rows.
    expect(focus.mock.calls.map(([row, kind]) => `${kind}: ${(row as unknown as { props: { accessibilityLabel: string } }).props.accessibilityLabel}`)).toEqual([
      "focus: The spam filter let it through, 12 Nov, 09:00, a known user",
    ]);
  });

  it("filters by Workflows and People, each saying when it has none", async () => {
    serveActivity(({ filter }) => Promise.resolve(filter === "workflows" ? { events: [RUN], next: null } : filter === "people" ? { events: [], next: null } : { events: [RUN, CLOSED], next: null }));
    await render(<Details />);
    await screen.findByText("A conversation starts");

    await fireEvent.press(screen.getByRole("tab", { name: "Workflows" }));
    expect(await screen.findByRole("tab", { name: "Workflows", selected: true })).toBeTruthy();
    expect(screen.queryByText("Olive Owner")).toBeNull();
    expect(screen.getByText("A conversation starts")).toBeTruthy();

    await fireEvent.press(screen.getByRole("tab", { name: "People" }));
    expect(await screen.findByText("Nobody has changed anything yet.")).toBeTruthy();
    expect(activityAsked()).toEqual(["/conversations/12/activity?filter=all", "/conversations/12/activity?filter=workflows", "/conversations/12/activity?filter=people"]);
  });

  it("reads it again when a change is made, so the change's row is there", async () => {
    let closed = false;
    serveActivity(() => Promise.resolve({ events: closed ? [CLOSED, RUN] : [RUN], next: null }));
    const answer = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) => {
      if (init?.method === "PATCH") {
        closed = true;
      }
      return answer(path, init);
    });
    await render(<Details />);
    await screen.findByText("A conversation starts");
    expect(screen.queryByText("Olive Owner")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Olive Owner")).toBeTruthy();
  });

  it("offline, shows the newest page as it was kept, saying so", async () => {
    let online = true;
    serveActivity(() => (online ? Promise.resolve({ events: [RUN, CLOSED], next: "e2" }) : Promise.reject(new ApiError(0, "unreachable", NETWORK))));
    const first = await render(<Details />);
    await screen.findByText("A conversation starts");
    await first.unmount();

    online = false;
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await act(() => jest.advanceTimersByTimeAsync(5 * 60_000));
    await render(<Details />);
    expect(await screen.findByText("A conversation starts")).toBeTruthy();
    expect(screen.getByText("Olive Owner")).toBeTruthy();
    expect(screen.getByText("Offline · updated 5 minutes ago")).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("Offline · updated 5 minutes ago");
  });

  it("with nothing kept, says it couldn't load, and Try again loads it", async () => {
    let online = false;
    serveActivity(() => (online ? Promise.resolve({ events: [RUN], next: null }) : Promise.reject(new ApiError(0, "unreachable", NETWORK))));
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await render(<Details />);
    expect(await screen.findByText(NETWORK)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(NETWORK);

    online = true;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("A conversation starts")).toBeTruthy();
    expect(screen.queryByText(NETWORK)).toBeNull();
  });

  it("reads it again as far back as shown, up to 100, and keeps only the newest 20 for offline", async () => {
    let online = true;
    const all = Array.from({ length: 25 }, (_, i) => event(`r${25 - i}`, "2026-11-25T10:00:00", { text: `closed it ${25 - i}` }));
    serveActivity(({ before, limit }) => {
      if (!online) {
        return Promise.reject(new ApiError(0, "unreachable", NETWORK));
      }
      if (before) {
        return Promise.resolve({ events: all.slice(all.findIndex((one) => one.id === before) + 1), next: null });
      }
      // Closed meanwhile: its row on top.
      return Promise.resolve(limit ? { events: [CLOSED, ...all].slice(0, Number(limit)), next: null } : { events: all.slice(0, 20), next: "r6" });
    });
    const first = await render(<Details />);
    await screen.findByText(/ it 25$/);
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(await screen.findByText(/ it 1$/)).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await act(() => jest.advanceTimersByTimeAsync(0));
    // A page more than shown: the new row above, and every row shown still there.
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&limit=45");
    expect(screen.getAllByText(/closed it \d+$/)).toHaveLength(25);
    expect(screen.getByText(/closed it$/)).toBeTruthy();
    expect(screen.getByText(/ it 1$/)).toBeTruthy();
    await first.unmount();

    // Kept: the newest 20 (the new row and 19 more), and Show earlier from the 20th.
    online = false;
    await render(<Details />);
    expect(await screen.findByText(/ it 25$/)).toBeTruthy();
    expect(screen.getAllByText(/closed it( \d+)?$/)).toHaveLength(20);
    expect(screen.queryByText(/ it 6$/)).toBeNull();
    online = true;
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&before=r7");
    // The newest rows are still as kept: still said to be.
    expect(await screen.findByText(/ it 1$/)).toBeTruthy();
    expect(screen.getByText(/^Offline · updated/)).toBeTruthy();
  });

  it("keeps the rows shown when a reload finds no connection, saying it's offline since they loaded", async () => {
    let online = true;
    serveActivity(() => (online ? Promise.resolve({ events: [RUN], next: null }) : Promise.reject(new ApiError(0, "unreachable", NETWORK))));
    await render(<Details />);
    await screen.findByText("A conversation starts");

    online = false;
    await act(() => jest.advanceTimersByTimeAsync(2 * 60_000));
    await act(async () => showTriage(KEY, { ...OPEN, status: "waiting" }));
    expect(await screen.findByText("Offline · updated 2 minutes ago")).toBeTruthy();
    expect(screen.getByText("A conversation starts")).toBeTruthy();
    expect(screen.queryByText(NETWORK)).toBeNull();
  });

  it("keeps the tab chosen when the conversation changes while it loads", async () => {
    let answer: (value: unknown) => void = () => {};
    serveActivity(({ filter }) => (filter === "workflows" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ events: [RUN, CLOSED], next: null })));
    await render(<Details />);
    await screen.findByText("Olive Owner");

    await fireEvent.press(screen.getByRole("tab", { name: "Workflows" }));
    await act(async () => showTriage(KEY, { ...OPEN, status: "waiting" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=workflows");
    await act(async () => answer({ events: [RUN], next: null }));
    expect(await screen.findByRole("tab", { name: "Workflows", selected: true })).toBeTruthy();
    expect(screen.queryByText("Olive Owner")).toBeNull();
  });

  it("takes a tab chosen while it's loading, and reads Show earlier's page too in a reload meanwhile", async () => {
    let answer: (value: unknown) => void = () => {};
    serveActivity(({ filter, before }) =>
      filter === "all" && !before ? new Promise((resolve) => (answer = resolve)) : before ? new Promise(() => {}) : Promise.resolve({ events: [RUN], next: null }),
    );
    await render(<Details />);
    await act(async () => answer({ events: [RUN, CLOSED], next: "e2" }));
    await screen.findByText("Olive Owner");

    // Show earlier still out when the conversation changes: the reload reads that page too.
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    await act(async () => showTriage(KEY, { ...OPEN, status: "waiting" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&limit=22");

    // That reload still out: Workflows is taken.
    await fireEvent.press(screen.getByRole("tab", { name: "Workflows" }));
    expect(await screen.findByRole("tab", { name: "Workflows", selected: true })).toBeTruthy();
    expect(screen.queryByText("Olive Owner")).toBeNull();
  });

  it("keeps Show earlier while its page loads, off but focusable, a press meanwhile ignored", async () => {
    serveActivity(({ before }) => (before ? new Promise(() => {}) : Promise.resolve({ events: [RUN, CLOSED], next: "e2" })));
    await render(<Details />);
    await screen.findByText("Olive Owner");

    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(screen.getByRole("button", { name: "Show earlier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show earlier" }).props.accessibilityState).toMatchObject({ busy: true });
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(activityAsked().filter((path) => path.includes("before="))).toHaveLength(1);
  });

  it("is fetched once on opening, and again only when the conversation's status changes", async () => {
    serveActivity(() => Promise.resolve({ events: [RUN], next: null }));
    // Opened by a link: no screen under it, so the sheet fetches the status itself.
    screenUnder?.();
    screenUnder = null;
    await render(<Details />);
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
    await screen.findByText("A conversation starts");
    expect(activityAsked()).toEqual(["/conversations/12/activity?filter=all"]);

    // A fetch bringing it as it was: nothing to read again.
    await act(async () => showTriage(KEY, { ...OPEN }));
    expect(activityAsked()).toHaveLength(1);
    await act(async () => showTriage(KEY, { ...OPEN, priority: true }));
    expect(activityAsked()).toHaveLength(2);
  });

  it("keeps its tab and rows across Assign and back, asking nothing again", async () => {
    serveActivity(({ filter }) => Promise.resolve(filter === "people" ? { events: [CLOSED], next: null } : { events: [RUN, CLOSED], next: null }));
    await render(<Details />);
    await screen.findByText("A conversation starts");
    await fireEvent.press(screen.getByRole("tab", { name: "People" }));
    expect(await screen.findByRole("tab", { name: "People", selected: true })).toBeTruthy();
    const asked = activityAsked().length;

    await fireEvent.press(screen.getByRole("button", { name: "Assignee, Unassigned" }));
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("tab", { name: "People", selected: true })).toBeTruthy();
    expect(screen.getByText("Olive Owner")).toBeTruthy();
    expect(screen.queryByText("A conversation starts")).toBeNull();
    expect(activityAsked()).toHaveLength(asked);
  });

  it("drops a failed tab's error once All is shown offline, so Try again can't load the wrong tab", async () => {
    let online = true;
    serveActivity(() => (online ? Promise.resolve({ events: [RUN], next: null }) : Promise.reject(new ApiError(0, "unreachable", NETWORK))));
    await render(<Details />);
    await screen.findByText("A conversation starts");

    online = false;
    await fireEvent.press(screen.getByRole("tab", { name: "Workflows" }));
    expect(await screen.findByText(NETWORK)).toBeTruthy();
    await fireEvent.press(screen.getByRole("tab", { name: "All" }));
    expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
    expect(screen.queryByText(NETWORK)).toBeNull();
    expect(screen.getByRole("tab", { name: "All", selected: true })).toBeTruthy();
  });

  it("starts over for another conversation, even one whose status reads the same", async () => {
    serveActivity(() => Promise.resolve({ events: [RUN], next: null }));
    const answer = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, init) =>
      path.startsWith("/conversations/13/activity") ? Promise.resolve({ events: [SPAM], next: null }) : path === "/conversations/13/person" ? Promise.resolve(SAM) : answer(path, init),
    );
    // Conversation 13's screen holds the same status.
    const other = screenKey(mockSession, 13);
    const under = holdTriage(other);
    showTriage(other, OPEN);
    await render(<Details />);
    await screen.findByText("A conversation starts");

    mockNumber = "13";
    await screen.rerender(<Details />);
    expect(await screen.findByText("The spam filter")).toBeTruthy();
    expect(screen.queryByText("A conversation starts")).toBeNull();
    under();
  });

  it("reads it again when the status comes back changed after none, and not when it comes back the same", async () => {
    serveActivity(() => Promise.resolve({ events: [RUN], next: null }));
    function Section({ triage }: { triage: Triage | null }) {
      return <ActivitySection number={12} triage={triage} colors={useColors()} />;
    }
    await render(<Section triage={OPEN} />);
    await screen.findByText("A conversation starts");
    expect(activityAsked()).toHaveLength(1);

    await screen.rerender(<Section triage={null} />);
    await screen.rerender(<Section triage={{ ...OPEN }} />);
    expect(activityAsked()).toHaveLength(1);
    await screen.rerender(<Section triage={null} />);
    await screen.rerender(<Section triage={{ ...OPEN, status: "closed" }} />);
    expect(activityAsked()).toHaveLength(2);
  });

  it("cuts a reload at the oldest row shown, Show earlier going on from there", async () => {
    let closed = false;
    const all = Array.from({ length: 25 }, (_, i) => event(`r${25 - i}`, "2026-11-25T10:00:00", { text: `closed it ${25 - i}` }));
    serveActivity(({ limit }) => Promise.resolve(limit ? { events: [...(closed ? [CLOSED] : []), ...all].slice(0, Number(limit)), next: null } : { events: all.slice(0, 20), next: "r6" }));
    await render(<Details />);
    await screen.findByText(/ it 25$/);

    closed = true;
    await act(async () => showTriage(KEY, { ...OPEN, status: "closed" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&limit=40");
    expect(await screen.findByText(/closed it$/)).toBeTruthy();
    // The 20 shown and the new one: none of the older ones, which Show earlier reads from the oldest shown.
    expect(screen.getAllByText(/closed it( \d+)?$/)).toHaveLength(21);
    expect(screen.queryByText(/ it 5$/)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&before=r6");
  });

  it("shown offline, reads it again once the conversation is fetched again, or its tab is tapped", async () => {
    let online = true;
    serveActivity(() => (online ? Promise.resolve({ events: [RUN], next: null }) : Promise.reject(new ApiError(0, "unreachable", NETWORK))));
    const first = await render(<Details />);
    await screen.findByText("A conversation starts");
    await first.unmount();

    online = false;
    await render(<Details />);
    expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();
    // Tapping All, the tab shown, asks again: still offline.
    const asked = activityAsked().length;
    await fireEvent.press(screen.getByRole("tab", { name: "All" }));
    expect(activityAsked()).toHaveLength(asked + 1);
    expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();

    // Back online: the screen under it fetches the conversation, as it was.
    online = true;
    await act(async () => showTriage(KEY, { ...OPEN }));
    expect(activityAsked()).toHaveLength(asked + 2);
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(screen.queryByText(/^Offline · updated/)).toBeNull();
    expect(screen.getByText("A conversation starts")).toBeTruthy();
  });

  it("tapped offline, its tab reads again as far back as it's shown", async () => {
    let online = true;
    serveActivity(({ before, limit }) =>
      !online
        ? Promise.reject(new ApiError(0, "unreachable", NETWORK))
        : Promise.resolve(before ? { events: [SPAM], next: null } : limit ? { events: [RUN, CLOSED, SPAM], next: null } : { events: [RUN, CLOSED], next: "e2" }),
    );
    await render(<Details />);
    await screen.findByText("A conversation starts");
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    await screen.findByText("The spam filter");

    // Offline: a reload keeps what's shown, saying so.
    online = false;
    await act(async () => showTriage(KEY, { ...OPEN, status: "waiting" }));
    expect(await screen.findByText(/^Offline · updated/)).toBeTruthy();

    online = true;
    await fireEvent.press(screen.getByRole("tab", { name: "All" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&limit=23");
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(screen.queryByText(/^Offline · updated/)).toBeNull();
    expect(screen.getByText("The spam filter")).toBeTruthy();
  });

  it("reads again at most 100 rows, however many are shown", async () => {
    const all = Array.from({ length: 105 }, (_, i) => event(`m${105 - i}`, "2026-11-25T10:00:00", { text: `closed it ${105 - i}` }));
    serveActivity(({ before }) => Promise.resolve(before ? { events: all.slice(100), next: null } : { events: all.slice(0, 100), next: "m6" }));
    await render(<Details />);
    await screen.findByText(/ it 105$/);
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier" }));
    expect(await screen.findByText(/ it 1$/)).toBeTruthy();

    await act(async () => showTriage(KEY, { ...OPEN, status: "closed" }));
    expect(activityAsked().at(-1)).toBe("/conversations/12/activity?filter=all&limit=100");
  });

  it("isn't shown by a server from before it", async () => {
    serveActivity(() => Promise.reject(new ApiError(404, "not_found", "Not found")));
    await render(<Details />);
    await screen.findByText("Sam Lee");
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("header", { name: "Activity" })).toBeNull();
    expect(screen.queryByText("Not found")).toBeNull();
  });
});
