import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "./api";

const stored = new Map<string, string>();
/** Writes to secure storage that fail (a keystore that won't take them). */
const writes = vi.hoisted(() => ({ fail: false }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (writes.fail) {
      throw new Error("Keystore unavailable");
    }
    stored.set(key, value);
  },
}));
vi.mock("expo-web-browser", () => ({}));
const files = new Map<string, string>();
vi.mock("expo-file-system", () => ({
  Paths: { document: "documents", cache: "cache" },
  File: class {
    constructor(
      readonly dir: string,
      readonly name: string,
    ) {}
    get exists() {
      return files.has(`${this.dir}/${this.name}`);
    }
    writeSync(text: string) {
      files.set(`${this.dir}/${this.name}`, text);
    }
  },
}));
let ids = 0;
vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${++ids}` }));
const config = vi.hoisted(() => ({ projectId: "eas-project" as string | undefined }));
vi.mock("expo-constants", () => ({ default: { get expoConfig() { return { extra: { eas: { projectId: config.projectId } } }; }, easConfig: null } }));

// The system: what it's allowed, and the token it gives (a device token passed in stands for a new one).
const system = vi.hoisted(() => ({
  permissions: { granted: true, status: "granted", canAskAgain: true } as { granted: boolean; status: string; canAskAgain: boolean; ios?: { status: number } },
  token: "ExponentPushToken[one]",
  channels: [] as string[],
  asked: 0,
  unregistered: 0,
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  PermissionStatus: { UNDETERMINED: "undetermined" },
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  getPermissionsAsync: async () => system.permissions,
  unregisterForNotificationsAsync: async () => void system.unregistered++,
  requestPermissionsAsync: async () => {
    system.asked++;
    system.permissions = { granted: true, status: "granted", canAskAgain: true };
  },
  setNotificationChannelAsync: async (id: string) => void system.channels.push(id),
  getExpoPushTokenAsync: async ({ devicePushToken }: { devicePushToken?: { data: string } }) => {
    await system.gate;
    return { data: devicePushToken ? `ExponentPushToken[${devicePushToken.data}]` : system.token };
  },
}));

// Each test gets the module afresh: what it keeps in memory (the id read, the token registered) starts empty.
const load = () => import("./notifications");
const session = { token: "token-1" };
const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
  calls.push({ path, init });
  return {};
}) as Api;

beforeEach(() => {
  vi.resetModules();
  writes.fail = false;
  stored.clear();
  files.clear();
  calls.length = 0;
  ids = 0;
  config.projectId = "eas-project";
  system.permissions = { granted: true, status: "granted", canAskAgain: true };
  system.token = "ExponentPushToken[one]";
  system.channels = [];
  system.asked = 0;
  system.unregistered = 0;
  system.gate = undefined;
});

describe("the device's id", () => {
  it("is made up once and kept, across launches", async () => {
    const first = await (await load()).deviceId();
    expect(await (await load()).deviceId()).toBe(first);

    vi.resetModules();
    expect(await (await load()).deviceId()).toBe(first);
    expect(ids).toBe(1);
  });
});

describe("asking for permission", () => {
  it("is offered once, while the system would still ask", async () => {
    system.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    const { shouldOffer } = await load();
    expect(await shouldOffer()).toBe(true);
    expect(await shouldOffer()).toBe(false);
    // Marked in the cache, which backups leave out: a new Android phone restores its documents, not the permission.
    expect([...files.keys()]).toEqual(["cache/notifications-asked"]);
    vi.resetModules();
    expect(await (await load()).shouldOffer()).toBe(false);
  });

  it("is offered again after a reinstall, which forgets the app's files (not its keychain) and the permission alike", async () => {
    system.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    const { shouldOffer } = await load();
    expect(await shouldOffer()).toBe(true);
    files.clear();
    expect(stored.size).toBe(0);
    expect(await shouldOffer()).toBe(true);
  });

  it("is offered on Android, which calls a permission it never asked for denied, but can ask", async () => {
    system.permissions = { granted: false, status: "denied", canAskAgain: true };
    expect(await (await load()).shouldOffer()).toBe(true);
  });

  it("isn't offered once allowed or refused", async () => {
    expect(await (await load()).shouldOffer()).toBe(false);
    files.clear();
    system.permissions = { granted: false, status: "denied", canAskAgain: false };
    expect(await (await load()).shouldOffer()).toBe(false);
  });

  it("makes Android's channel before the system asks", async () => {
    system.permissions = { granted: false, status: "undetermined", canAskAgain: true };
    expect(await (await load()).askPermission("android")).toBe(true);
    expect(system.channels).toEqual(["default"]);
    expect(system.asked).toBe(1);
  });

  it("says whether they're allowed, and whether the system would still ask", async () => {
    const { permission } = await load();
    expect(await permission()).toEqual({ allowed: true, canAsk: false });
    system.permissions = { granted: false, status: "denied", canAskAgain: false };
    expect(await permission()).toEqual({ allowed: false, canAsk: false });
    system.permissions = { granted: false, status: "undetermined", canAskAgain: true, ios: { status: 3 } };
    expect(await permission()).toEqual({ allowed: true, canAsk: false });
  });
});

describe("registering the device", () => {
  it("sends its id, token and platform, and again only when the token changes", async () => {
    const { registerDevice, deviceId } = await load();
    await registerDevice(api, session, "ios");
    await registerDevice(api, session, "ios");
    expect(calls).toEqual([{ path: "/devices", init: { method: "POST", body: { deviceId: await deviceId(), token: "ExponentPushToken[one]", platform: "ios" } } }]);

    await registerDevice(api, session, "ios", { type: "ios", data: "two" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init!.body).toMatchObject({ token: "ExponentPushToken[two]" });
  });

  it("registers again for another session, and after a registration that failed", async () => {
    const { registerDevice } = await load();
    const failing = (async () => {
      throw new Error("offline");
    }) as Api;
    await expect(registerDevice(failing, session, "android")).rejects.toThrow("offline");
    await registerDevice(api, session, "android");
    await registerDevice(api, { token: "token-2" }, "android");
    expect(calls).toHaveLength(2);
    expect(system.channels).toContain("default");
  });

  it("registers nothing while notifications aren't allowed, or without an Expo project", async () => {
    system.permissions = { granted: false, status: "denied", canAskAgain: false };
    const { registerDevice } = await load();
    await registerDevice(api, session, "ios");
    system.permissions = { granted: true, status: "granted", canAskAgain: true };
    config.projectId = undefined;
    await registerDevice(api, session, "ios");
    expect(calls).toEqual([]);
  });

  it("is removed on signing out without waiting for the server, and registered again on signing back in", async () => {
    const { registerDevice, removeDevice, deviceId } = await load();
    await registerDevice(api, session, "ios");
    const registeredAs = await deviceId();
    const hanging = vi.fn(() => new Promise<never>(() => {})) as unknown as Api;
    await removeDevice(hanging);
    expect(hanging).toHaveBeenCalledWith(`/devices/${encodeURIComponent(registeredAs)}`, { method: "DELETE" });
    // A removal that fails throws nowhere.
    await removeDevice((async () => {
      throw new Error("offline");
    }) as Api);
    await registerDevice(api, session, "ios");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init!.body).toMatchObject({ deviceId: await deviceId() });
  });

  it("gives up the phone's push token when the removal can't reach the server, which may not have heard the sign-out either", async () => {
    const { removeDevice } = await load();
    // The same module the one under test has (each test loads them afresh).
    const { ApiError } = await import("./api");
    const failing = (error: Error) =>
      (async () => {
        throw error;
      }) as Api;
    await removeDevice(failing(new ApiError(401, "unauthorized", "Signed out")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(system.unregistered).toBe(0);

    await removeDevice(failing(new ApiError(0, "unreachable", "Couldn't reach tuti.example.com.")));
    await vi.waitFor(() => expect(system.unregistered).toBe(1));
    // Something other than the server answered (a Wi-Fi login page).
    await removeDevice(failing(new ApiError(200, "not_tuti", "wifi.example.com didn't answer like a Tuti server (200).")));
    await vi.waitFor(() => expect(system.unregistered).toBe(2));
  });

  it("registers a sign-in after a slow removal under a new id, so the removal can only reach the old registration", async () => {
    const { registerDevice, removeDevice, deviceId } = await load();
    await registerDevice(api, session, "ios");
    const old = await deviceId();
    const slow = vi.fn(() => new Promise<never>(() => {})) as unknown as Api;
    await removeDevice(slow);

    // Signed in again to the same account, the removal still on its way.
    await registerDevice(api, session, "ios");
    const fresh = await deviceId();
    expect(fresh).not.toBe(old);
    expect(slow).toHaveBeenCalledWith(`/devices/${old}`, { method: "DELETE" });
    expect(calls.at(-1)!.init!.body).toMatchObject({ deviceId: fresh });
    // And it's the one kept on the phone for the next launch.
    vi.resetModules();
    expect(await (await load()).deviceId()).toBe(fresh);
  });

  it("doesn't register a session signed out while its token was still being read", async () => {
    const { registerDevice, removeDevice } = await load();
    let release: () => void = () => {};
    system.gate = new Promise((resolve) => (release = resolve));
    const registering = registerDevice(api, session, "ios");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await removeDevice(api);
    release();
    await registering;
    expect(calls.filter((call) => call.init?.method === "POST")).toEqual([]);
  });

  it("keeps the token of a sign-in that registered while the removal before it was still failing", async () => {
    const { registerDevice, removeDevice } = await load();
    const { ApiError } = await import("./api");
    let fail: () => void = () => {};
    const hanging = (() => new Promise((_, reject) => (fail = () => reject(new ApiError(0, "unreachable", "Offline"))))) as Api;
    await removeDevice(hanging);
    await registerDevice(api, { token: "token-2" }, "ios");
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(system.unregistered).toBe(0);
  });
});

const notification = (data: unknown) => ({ request: { content: { title: "Ada · Acme", data } } }) as never;
const response = (data: unknown, actionIdentifier = "expo.modules.notifications.actions.DEFAULT") => ({ actionIdentifier, notification: notification(data) }) as never;

describe("a notification's conversation", () => {
  it("is read from the server's data, checked", async () => {
    const { targetOf, tapped } = await load();
    expect(targetOf({ project: "acme", conversation: 12 })).toEqual({ project: "acme", number: 12 });
    expect(targetOf({ project: "acme", conversation: 12, device: "phone-1" })).toEqual({ project: "acme", number: 12, device: "phone-1" });
    for (const bad of [null, {}, { project: "acme" }, { project: "Acme\nx", conversation: 1 }, { project: "acme", conversation: "12" }, { project: "acme", conversation: 0 }, { project: "acme", conversation: 1.5 }]) {
      expect(targetOf(bad)).toBeNull();
    }
    expect(tapped(response({ project: "acme", conversation: 3 }))).toEqual({ project: "acme", number: 3 });
    expect(tapped(response({ project: "acme", conversation: 3 }, "expo.modules.notifications.actions.DISMISS"))).toBeNull();
    expect(tapped(null)).toBeNull();
  });
});

describe("a notification while the app is in front", () => {
  it("shows a reply's silent update in the list only, whatever is on screen, so Android's reply spinner goes", async () => {
    const { behaviourFor, lookAt } = await load();
    const update = { project: "acme", conversation: 12, sent: true };
    const quiet = { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
    expect(behaviourFor(notification(update))).toEqual(quiet);
    const away = lookAt({ project: "acme", number: 12 });
    expect(behaviourFor(notification(update))).toEqual(quiet);
    away();
  });

  it("shows no banner over its own conversation, and one anywhere else", async () => {
    const { behaviourFor, lookAt } = await load();
    const shown = (data: unknown) => behaviourFor(notification(data)).shouldShowBanner;
    const twelve = { project: "acme", conversation: 12 };
    expect(shown(twelve)).toBe(true);

    const away = lookAt({ project: "acme", number: 12 });
    expect(behaviourFor(notification(twelve))).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
    expect(shown({ project: "acme", conversation: 13 })).toBe(true);
    expect(shown({ project: "kite", conversation: 12 })).toBe(true);
    expect(shown({})).toBe(true);
    // Untitled (Android's pushes, data only, which the app shows itself), nothing.
    expect(behaviourFor({ request: { content: { title: null, data: { project: "acme", conversation: 13 } } } } as never).shouldShowBanner).toBe(false);
    // Signed out, nothing shows in front.
    expect(behaviourFor(notification({ project: "acme", conversation: 13 }), true).shouldShowBanner).toBe(false);

    // Its details sheet focusing as the conversation's screen blurs: the screen's release leaves the sheet's mark.
    const sheet = lookAt({ project: "acme", number: 12 });
    away();
    expect(shown(twelve)).toBe(false);
    sheet();
    expect(shown(twelve)).toBe(true);
    const again = lookAt({ project: "acme", number: 12 });

    // Another conversation opened over it, then that one closed: the first one's leaving doesn't unmark the second.
    const other = lookAt({ project: "acme", number: 13 });
    again();
    expect(shown({ project: "acme", conversation: 13 })).toBe(false);
    other();
    expect(shown({ project: "acme", conversation: 13 })).toBe(true);
  });
});

describe("whether a notification is for this sign-in", () => {
  it("is when it names the id the phone registered under, which a sign-out changes", async () => {
    const { deviceId, forThisSignIn, removeDevice } = await load();
    const id = await deviceId();
    expect(await forThisSignIn({ project: "acme", number: 7, device: id })).toBe(true);
    // A push for a sign-in since left (on any server), or one that names no registration, isn't.
    await removeDevice(api);
    expect(await forThisSignIn({ project: "acme", number: 7, device: id })).toBe(false);
    expect(await forThisSignIn({ project: "acme", number: 7, device: await deviceId() })).toBe(true);
    expect(await forThisSignIn({ project: "acme", number: 7 })).toBe(false);
  });

  it("reads the id as stored now: a sign-out in the app's other JavaScript changes it there, not in this one's memory", async () => {
    const { deviceId, forThisSignIn } = await load();
    const old = await deviceId();
    // The other JavaScript signed out and in again: a new id stored, this one's cached id still the old one.
    stored.set("device-id", "id-from-the-other-javascript");
    expect(await deviceId()).toBe(old);
    expect(await forThisSignIn({ project: "acme", number: 7, device: old })).toBe(false);
    expect(await forThisSignIn({ project: "acme", number: 7, device: "id-from-the-other-javascript" })).toBe(true);
  });

  it("goes by this JavaScript's own sign-out while its new id isn't stored (the write not landed, or failed)", async () => {
    const { deviceId, forThisSignIn, removeDevice } = await load();
    const old = await deviceId();
    writes.fail = true;
    try {
      await removeDevice(api);
    } finally {
      writes.fail = false;
    }
    // Storage still has the old id: the session signed out of isn't this one's any more, the new one is.
    expect(stored.get("device-id")).toBe(old);
    const now = await deviceId();
    expect(await forThisSignIn({ project: "acme", number: 7, device: old })).toBe(false);
    expect(await forThisSignIn({ project: "acme", number: 7, device: now })).toBe(true);
    // Then the other JavaScript signs out and in again: its id, stored, wins over this one's.
    stored.set("device-id", "id-from-the-other-javascript");
    expect(await forThisSignIn({ project: "acme", number: 7, device: now })).toBe(false);
    expect(await forThisSignIn({ project: "acme", number: 7, device: "id-from-the-other-javascript" })).toBe(true);
  });
});

describe("opening a tapped notification", () => {
  const signedIn = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
  const projects = async () => ["acme", "kite"];

  it("opens the conversation in the project chosen", async () => {
    const { openTarget } = await load();
    const setProject = vi.fn(async () => {});
    const open = vi.fn();
    const leave = vi.fn();
    await openTarget({ project: "acme", number: 7 }, signedIn, setProject, { leave, open, projects });
    expect(setProject).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/conversation/7");
    // Back to the Inbox first, so it never opens over a sheet.
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
  });

  it("leaves the screens open, then switches to its project", async () => {
    const { openTarget } = await load();
    const order: string[] = [];
    await openTarget({ project: "kite", number: 7 }, signedIn, async (slug) => void order.push(`project ${slug}`), {
      leave: () => order.push("leave"),
      open: (path) => order.push(path),
      projects,
    });
    expect(order).toEqual(["leave", "project kite", "/conversation/7"]);
  });

  it("opens nothing signed out, for a sign-in since left, or when the project can't be switched", async () => {
    const { deviceId, openTarget } = await load();
    const open = vi.fn();
    await openTarget({ project: "acme", number: 7 }, null, async () => {}, { leave: () => {}, open, projects });
    // For a sign-in since left (its registration's id isn't the phone's now): nothing.
    await openTarget({ project: "acme", number: 7, device: "an-id-since-left" }, signedIn, async () => {}, { leave: () => {}, open, projects });
    expect(open).not.toHaveBeenCalled();
    // For this one, or naming none (a tap only opens, in the teammate's own projects): opened.
    await openTarget({ project: "acme", number: 7, device: await deviceId() }, signedIn, async () => {}, { leave: () => {}, open, projects });
    await openTarget({ project: "acme", number: 7 }, signedIn, async () => {}, { leave: () => {}, open, projects });
    expect(open).toHaveBeenCalledTimes(2);
    open.mockClear();
    await expect(
      openTarget({ project: "kite", number: 7 }, signedIn, () => Promise.reject(new Error("Keychain unavailable")), { leave: () => {}, open, projects }),
    ).rejects.toThrow("Keychain unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens nothing for a project that isn't one of the teammate's, or when their projects can't be read", async () => {
    const { openTarget } = await load();
    const open = vi.fn();
    const leave = vi.fn();
    const setProject = vi.fn(async () => {});
    await openTarget({ project: "orbit", number: 7 }, signedIn, setProject, { leave, open, projects });
    await openTarget({ project: "kite", number: 7 }, signedIn, setProject, { leave, open, projects: () => Promise.reject(new Error("Offline")) });
    expect(leave).not.toHaveBeenCalled();
    expect(setProject).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
