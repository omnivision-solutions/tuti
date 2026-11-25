import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, Alert, AppState, Linking, Platform } from "react-native";

import NotificationSettings from "@/app/notifications";
import { offerNotifications, useNotifications } from "@/components/notifications";
import type { Session } from "@/lib/session";
import { onForgetChosen } from "@/lib/layout";

// The system's notifications: what's allowed, the token it gives, and the taps and token changes the test sends.
type Response = { actionIdentifier: string; notification: { request: { content: { data: unknown } } } };
const mockSystem = {
  permissions: { granted: true, status: "granted", canAskAgain: true },
  last: null as Response | null,
  onTap: null as ((response: Response) => void) | null,
  onToken: null as ((token: { type: string; data: string }) => void) | null,
  asked: 0,
  tokenReads: 0,
  handler: null as { handleNotification: (notification: unknown) => Promise<{ shouldShowBanner: boolean }> } | null,
};
jest.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  PermissionStatus: { UNDETERMINED: "undetermined" },
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  setNotificationHandler: (handler: typeof mockSystem.handler) => (mockSystem.handler = handler),
  getPermissionsAsync: async () => mockSystem.permissions,
  requestPermissionsAsync: async () => {
    mockSystem.asked++;
    mockSystem.permissions = { granted: true, status: "granted", canAskAgain: true };
  },
  setNotificationChannelAsync: async () => {},
  getExpoPushTokenAsync: async ({ devicePushToken }: { devicePushToken?: { data: string } }) => {
    mockSystem.tokenReads++;
    return { data: `ExponentPushToken[${devicePushToken?.data ?? "one"}]` };
  },
  getLastNotificationResponse: () => mockSystem.last,
  clearLastNotificationResponse: () => (mockSystem.last = null),
  addNotificationResponseReceivedListener: (listener: (response: Response) => void) => {
    mockSystem.onTap = listener;
    return { remove: () => (mockSystem.onTap = null) };
  },
  addPushTokenListener: (listener: (token: { type: string; data: string }) => void) => {
    mockSystem.onToken = listener;
    return { remove: () => (mockSystem.onToken = null) };
  },
}));
jest.mock("expo-constants", () => ({ expoConfig: { extra: { eas: { projectId: "eas-project" } } } }));
const mockStored = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => mockStored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockStored.set(key, value),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "phone-1" }));
// The app's own files: whether it has asked.
const mockFiles = new Set<string>();
jest.mock("expo-file-system", () => ({
  Paths: { document: "documents", cache: "cache" },
  File: class {
    mockName: string;
    constructor(_dir: unknown, mockName: string) {
      this.mockName = mockName;
    }
    get exists() {
      return mockFiles.has(this.mockName);
    }
    writeSync() {
      mockFiles.add(this.mockName);
    }
  },
}));
// The navigation: a conversation may be open over the Inbox (`mockOpen`).
const mockPush = jest.fn<(path: string) => void>();
const mockDismissAll = jest.fn();
let mockOpen = false;
jest.mock("expo-router", () => ({
  router: { push: (path: string) => mockPush(path), canDismiss: () => mockOpen, dismissAll: () => mockDismissAll() },
}));

const signedIn: Session = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
let mockSession: Session | null | undefined = signedIn;
const mockApi = jest.fn<(path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>>(async () => ({}));
const mockSetProject = jest.fn<(slug: string) => Promise<void>>(async (slug) => {
  mockSession = { ...mockSession!, project: slug };
});
jest.mock("@/lib/session", () => ({
  useSession: () => ({ session: mockSession, api: mockSession ? mockApi : null, setProject: mockSetProject }),
  useApi: () => mockApi,
}));

const tap = (data: unknown): Response => ({ actionIdentifier: "expo.modules.notifications.actions.DEFAULT", notification: { request: { content: { data } } } });

function Harness() {
  useNotifications();
  return null;
}

beforeEach(() => {
  mockSystem.permissions = { granted: true, status: "granted", canAskAgain: true };
  mockSystem.last = null;
  mockSystem.asked = 0;
  mockSession = signedIn;
  mockStored.clear();
  mockFiles.clear();
  mockOpen = false;
  mockDismissAll.mockReset();
  mockPush.mockReset();
  mockApi.mockReset().mockImplementation(async (path) => (path === "/projects" ? { projects: [{ slug: "acme" }, { slug: "kite" }] } : {}));
  mockSetProject.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

// The phone registered once per session and token (what the app keeps in memory): each test that registers has its own.
let sessions = 0;
const newSession = () => (mockSession = { ...signedIn, token: `token-new-${++sessions}` });

describe("a tapped notification", () => {
  it("opens its conversation while the app runs", async () => {
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "acme", conversation: 12 })));
    expect(mockPush).toHaveBeenCalledWith("/conversation/12");
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it("opens its conversation once, when it launched the app, once the session is read", async () => {
    mockSystem.last = tap({ project: "acme", conversation: 12 });
    mockSession = undefined;
    await render(<Harness />);
    expect(mockPush).not.toHaveBeenCalled();

    mockSession = signedIn;
    await screen.rerender(<Harness />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/conversation/12");
    expect(mockSystem.last).toBeNull();

    // The app's next launch doesn't open it again.
    await screen.unmount();
    await render(<Harness />);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("goes back to the Inbox and switches to its project first when another is chosen", async () => {
    mockOpen = true;
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "kite", conversation: 3 })));
    expect(mockSetProject).toHaveBeenCalledWith("kite");
    expect(mockPush).toHaveBeenCalledWith("/conversation/3");
    // The conversation open would otherwise turn into the other project's of its number.
    expect(mockDismissAll.mock.invocationCallOrder[0]).toBeLessThan(mockSetProject.mock.invocationCallOrder[0]!);
    expect(mockSetProject.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]!);
  });

  it("opens nothing for a project that isn't one of the teammate's (a notification left from another account)", async () => {
    mockOpen = true;
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "orbit", conversation: 3 })));
    expect(mockDismissAll).not.toHaveBeenCalled();
    expect(mockSetProject).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("goes back to the Inbox before opening a conversation of the same project: never over a sheet", async () => {
    mockOpen = true;
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "acme", conversation: 4 })));
    expect(mockSetProject).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/conversation/4");
    expect(mockDismissAll.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]!);
  });

  it("forgets a conversation chosen beside the Inbox before going back to it, so going back never pushes it", async () => {
    mockOpen = true;
    const forgotten = jest.fn();
    const stop = onForgetChosen(forgotten);
    try {
      await render(<Harness />);
      await act(async () => mockSystem.onTap!(tap({ project: "acme", conversation: 4 })));
      expect(forgotten).toHaveBeenCalled();
      expect(forgotten.mock.invocationCallOrder[0]).toBeLessThan(mockDismissAll.mock.invocationCallOrder.at(-1)!);
    } finally {
      stop();
    }
  });

  it("opens nothing signed out, where sign-in is all there is", async () => {
    mockSystem.last = tap({ project: "acme", conversation: 12 });
    mockSession = null;
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "acme", conversation: 13 })));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it("opens nothing for a notification that isn't the server's, or an action other than the tap", async () => {
    await render(<Harness />);
    await act(async () => mockSystem.onTap!(tap({ project: "acme" })));
    await act(async () => mockSystem.onTap!({ ...tap({ project: "acme", conversation: 1 }), actionIdentifier: "expo.modules.notifications.actions.DISMISS" }));
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("a notification while the app is in front", () => {
  it("shows a banner signed in, and nothing signed out", async () => {
    const arriving = { request: { content: { data: { project: "acme", conversation: 12 } } } };
    await render(<Harness />);
    expect((await mockSystem.handler!.handleNotification(arriving)).shouldShowBanner).toBe(true);

    mockSession = null;
    await screen.rerender(<Harness />);
    expect((await mockSystem.handler!.handleNotification(arriving)).shouldShowBanner).toBe(false);
  });
});

describe("registering the phone", () => {
  it("registers at launch while signed in, never asking, and again when the token changes", async () => {
    newSession();
    await render(<Harness />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/devices", { method: "POST", body: { deviceId: "phone-1", token: "ExponentPushToken[one]", platform: "ios" } }));
    expect(mockSystem.asked).toBe(0);

    await act(async () => mockSystem.onToken!({ type: "ios", data: "two" }));
    await waitFor(() => expect(mockApi).toHaveBeenLastCalledWith("/devices", { method: "POST", body: { deviceId: "phone-1", token: "ExponentPushToken[two]", platform: "ios" } }));
  });

  it("tries a registration that failed again on coming back to the foreground", async () => {
    newSession();
    const front: ((state: string) => void)[] = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      front.push(listener as (state: string) => void);
      return { remove: () => {} } as never;
    });
    mockApi.mockImplementation(async (path, init) => {
      if (init?.method === "POST") {
        throw new Error("Couldn't reach tuti.example.com.");
      }
      return {};
    });
    await render(<Harness />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));

    mockApi.mockImplementation(async () => ({}));
    await act(async () => front.forEach((listener) => listener("active")));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi).toHaveBeenLastCalledWith("/devices", expect.objectContaining({ method: "POST" }));
    // Registered: coming back again sends nothing more.
    await act(async () => front.forEach((listener) => listener("active")));
    await act(async () => {});
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  it("reads no token again on coming to the foreground once registered for the session", async () => {
    newSession();
    const front: ((state: string) => void)[] = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      front.push(listener as (state: string) => void);
      return { remove: () => {} } as never;
    });
    await render(<Harness />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/devices", expect.objectContaining({ method: "POST" })));
    const reads = mockSystem.tokenReads;

    await act(async () => front.forEach((listener) => listener("active")));
    await act(async () => {});
    expect(mockSystem.tokenReads).toBe(reads);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("registers nothing signed out, or before a project is chosen", async () => {
    mockSession = null;
    await render(<Harness />);
    mockSession = { ...newSession(), project: undefined };
    await screen.rerender(<Harness />);
    await act(async () => {});
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("offering notifications", () => {
  it("explains them, then asks the system, only once", async () => {
    mockSystem.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    newSession();
    await render(<Harness />);
    await act(async () => {});
    expect(mockApi).not.toHaveBeenCalled();

    await act(() => offerNotifications());
    expect(alert).toHaveBeenCalledTimes(1);
    expect(mockSystem.asked).toBe(0);
    await act(async () => alert.mock.calls[0]![2]!.find((button) => button.text === "Turn on")!.onPress!());
    expect(mockSystem.asked).toBe(1);
    // Allowed: registered then.
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/devices", expect.objectContaining({ method: "POST" })));

    await act(() => offerNotifications());
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("never asks again once declined", async () => {
    mockSystem.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await offerNotifications();
    await act(async () => alert.mock.calls[0]![2]!.find((button) => button.text === "Not now")!.onPress?.());
    await offerNotifications();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(mockSystem.asked).toBe(0);
  });
});

describe("the notifications' settings", () => {
  it("shows whether they're on and turns the message's text off", async () => {
    mockApi.mockImplementation(async (path, init) => (init?.method === "PATCH" ? init.body : { showMessageText: true }));
    await render(<NotificationSettings />);

    expect(await screen.findByRole("button", { name: "Notifications, on" })).toBeTruthy();
    const toggle = await screen.findByRole("switch", { name: "Show message text" });
    expect(toggle).toHaveProp("value", true);
    await fireEvent(toggle, "valueChange", false);
    expect(mockApi).toHaveBeenCalledWith("/notifications", { method: "PATCH", body: { showMessageText: false } });
    expect(screen.getByRole("switch", { name: "Show message text" })).toHaveProp("value", false);
  });

  it("puts the switch back, with why, when the server doesn't take it", async () => {
    mockApi.mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") {
        throw new Error("Couldn't reach tuti.example.com.");
      }
      return { showMessageText: true };
    });
    await render(<NotificationSettings />);
    await fireEvent(await screen.findByRole("switch", { name: "Show message text" }), "valueChange", false);
    expect(await screen.findByText("Couldn't reach tuti.example.com.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show message text" })).toHaveProp("value", true);
  });

  it("takes one change at a time: the switch waits for the server's answer", async () => {
    let answer: (settings: unknown) => void = () => {};
    mockApi.mockImplementation((path, init) => (init?.method === "PATCH" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ showMessageText: true })));
    await render(<NotificationSettings />);
    await fireEvent(await screen.findByRole("switch", { name: "Show message text" }), "valueChange", false);
    expect(screen.getByRole("switch", { name: "Show message text" })).toBeDisabled();
    await act(async () => answer({ showMessageText: false }));
    expect(screen.getByRole("switch", { name: "Show message text" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Show message text" })).toHaveProp("value", false);
  });

  it("moves a screen reader's focus to the switch once Try again has gone with its error", async () => {
    let fail = true;
    mockApi.mockImplementation(async () => {
      if (fail) {
        throw new Error("Couldn't reach tuti.example.com.");
      }
      return { showMessageText: true };
    });
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
    await render(<NotificationSettings />);
    fail = false;
    await fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show message text" })).toHaveProp("value", true));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(focus).toHaveBeenCalledWith(expect.objectContaining({ props: expect.anything() }), "focus");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("draws Android's switch in Tuti's colours, not the system's accent", async () => {
    const os = Platform.OS;
    Platform.OS = "android";
    try {
      mockApi.mockImplementation(async () => ({ showMessageText: true }));
      await render(<NotificationSettings />);
      // Android's host switch: found by its label, its thumb's colour a prop of its own.
      await waitFor(() => expect(screen.getByLabelText("Show message text")).toHaveProp("on", true));
      expect(screen.getByLabelText("Show message text")).toHaveProp("thumbTintColor", "#ffffff");
    } finally {
      Platform.OS = os;
    }
  });

  it("announces a failed change to VoiceOver, which has no live regions", async () => {
    const os = Platform.OS;
    Platform.OS = "ios";
    try {
      const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
      mockApi.mockImplementation(async (path, init) => {
        if (init?.method === "PATCH") {
          throw new Error("Couldn't reach tuti.example.com.");
        }
        return { showMessageText: true };
      });
      await render(<NotificationSettings />);
      await fireEvent(await screen.findByRole("switch", { name: "Show message text" }), "valueChange", false);
      await waitFor(() => expect(announce).toHaveBeenCalledWith("Couldn't reach tuti.example.com."));
    } finally {
      Platform.OS = os;
    }
  });

  it("opens the system's settings when they're off", async () => {
    mockSystem.permissions = { granted: false, status: "denied", canAskAgain: false };
    const settings = jest.spyOn(Linking, "openSettings").mockImplementation(async () => {});
    await render(<NotificationSettings />);
    await fireEvent.press(await screen.findByRole("button", { name: "Notifications, off" }));
    expect(settings).toHaveBeenCalled();
    expect(mockSystem.asked).toBe(0);
  });

  it("asks the system when it never was", async () => {
    mockSystem.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    await render(<NotificationSettings />);
    await fireEvent.press(await screen.findByRole("button", { name: "Notifications, off" }));
    expect(mockSystem.asked).toBe(1);
    expect(await screen.findByRole("button", { name: "Notifications, on" })).toBeTruthy();
  });
});
