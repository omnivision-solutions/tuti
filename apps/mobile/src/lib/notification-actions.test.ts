import type { NotificationResponse } from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone: its stored session, its files, the system's notifications and the server, all faked.
const phone = vi.hoisted(() => ({
  os: "ios" as "ios" | "android",
  version: 33 as number | string,
  /** How long after it's asked for a notification is shown. */
  postMs: 200,
  appState: "active",
  stored: new Map<string, string>(),
  files: new Map<string, string>(),
  dismissed: [] as string[],
  shown: [] as { identifier?: string; content: { title: string; body: string; data: unknown; categoryIdentifier?: string; sound?: unknown }; trigger: unknown }[],
  categories: [] as { id: string; actions: { identifier: string; options?: object; textInput?: object }[] }[],
  listener: null as ((response: unknown) => unknown) | null,
  last: null as unknown,
  task: null as ((body: { data: unknown }) => Promise<unknown>) | null,
  registered: [] as string[],
  presented: [] as { request: { identifier?: string; content: { data?: unknown } } }[],
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return phone.os;
    },
    get Version() {
      return phone.version;
    },
  },
  AppState: {
    get currentState() {
      return phone.appState;
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => phone.stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void phone.stored.set(key, value),
}));
vi.mock("expo-web-browser", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, text: string) => Buffer.from(text).toString("hex").padEnd(64, "0"),
  randomUUID: () => "a-new-id",
}));
vi.mock("expo-file-system", () => {
  const path = (parts: unknown[]) => parts.map((part) => (typeof part === "string" ? part : (part as { uri: string }).uri)).join("/");
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return phone.files.has(this.uri);
    }
    textSync() {
      return phone.files.get(this.uri)!;
    }
    writeSync(text: string) {
      phone.files.set(this.uri, text);
    }
  }
  class Directory extends File {
    create() {}
    override get exists() {
      return [...phone.files.keys()].some((key) => key.startsWith(`${this.uri}/`));
    }
    delete() {
      [...phone.files.keys()].filter((key) => key.startsWith(`${this.uri}/`)).forEach((key) => phone.files.delete(key));
    }
  }
  return { File, Directory, Paths: { document: "documents", cache: "cache" } };
});
vi.mock("expo-task-manager", () => ({ defineTask: (_: string, task: typeof phone.task) => void (phone.task = task) }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  setNotificationCategoryAsync: async (id: string, actions: (typeof phone.categories)[number]["actions"]) => void phone.categories.push({ id, actions }),
  registerTaskAsync: async (name: string) => void phone.registered.push(name),
  addNotificationResponseReceivedListener: (listener: typeof phone.listener) => {
    phone.listener = listener;
    return { remove: () => {} };
  },
  getLastNotificationResponse: () => phone.last,
  clearLastNotificationResponse: () => void (phone.last = null),
  dismissNotificationAsync: async (id: string) => void phone.dismissed.push(id),
  // What the system shows: the last one posted with each identifier, posted a little after it's asked for.
  getPresentedNotificationsAsync: async () => phone.presented,
  scheduleNotificationAsync: async (request: (typeof phone.shown)[number]) => {
    phone.shown.push(request);
    setTimeout(() => {
      phone.presented = [...phone.presented.filter((one) => one.request.identifier !== request.identifier), { request: { identifier: request.identifier, content: request.content } }];
    }, phone.postMs);
  },
}));

type Call = { url: string; method: string; project?: string; body?: unknown };
const calls: Call[] = [];
let answer: (call: Call) => Response = () => Response.json({});
/** A request the network leaves hanging: answered only by its abort. */
let hang = false;
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  const call = { url, method: init.method ?? "GET", project: headers["tuti-project"], ...(init.body ? { body: JSON.parse(init.body as string) } : {}) };
  calls.push(call);
  if (hang) {
    return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  }
  return answer(call);
});

const SERVER = "https://tuti.example";
/** The id this phone registered under (notifications.ts `deviceId`), which pushes to it name as `device`. */
const DEVICE = "phone-1";
/** When the notification's message was sent. */
const AT = "2026-11-25T10:00:00.000Z";
const signIn = (project = "acme") => phone.stored.set("session", JSON.stringify({ server: SERVER, token: "token-1", cookie: "c", project }));
const response = (
  actionIdentifier: string,
  { userText, project = "acme", id = "push-1", device = DEVICE }: { userText?: string; project?: string; id?: string; device?: string | null } = {},
) =>
  ({
    actionIdentifier,
    ...(userText !== undefined && { userText }),
    notification: {
      date: 0,
      request: { identifier: id, trigger: null, content: { title: "Ada · Acme", body: "Hi", data: { project, conversation: 7, at: AT, ...(device && { device }) } } },
    },
  }) as unknown as NotificationResponse;
/** The reply kept in the conversation's draft, by its body. */
const kept = async (project = "acme") => {
  const { getDraft } = await import("./conversation");
  const { screenKey } = await import("./details");
  return getDraft(screenKey({ server: SERVER, project }, 7)).unsent.map((one) => ({ body: one.body, error: one.error }));
};

const load = () => import("./notification-actions");

beforeEach(() => {
  vi.resetModules();
  Object.assign(phone, { os: "ios", version: 33, postMs: 200, appState: "active", dismissed: [], shown: [], categories: [], listener: null, last: null, task: null, registered: [], presented: [] });
  phone.stored.clear();
  phone.files.clear();
  calls.length = 0;
  answer = () => Response.json({});
  hang = false;
  signIn();
  phone.stored.set("device-id", DEVICE);
});

describe("the notification's actions", () => {
  it("are Reply, with text, and Close, neither opening the app, both only on an unlocked phone", async () => {
    (await load()).startNotificationActions();
    expect(phone.categories).toEqual([
      {
        id: "conversation",
        actions: [
          { identifier: "reply", buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Reply" }, options: { opensAppToForeground: false, isAuthenticationRequired: true } },
          { identifier: "close", buttonTitle: "Close", options: { opensAppToForeground: false, isAuthenticationRequired: true } },
        ],
      },
    ]);
  });

  it("are Reply only before Android 12, which can't ask to unlock for Close", async () => {
    phone.os = "android";
    phone.version = 30;
    await (await load()).setCategory();
    expect(phone.categories[0]!.actions.map((action) => action.identifier)).toEqual(["reply"]);
  });
});

describe("Reply", () => {
  it("sends the reply in the notification's project, with an id from the notification and the text, then dismisses it", async () => {
    await (await load()).act(response("reply", { userText: "  On it!  " }));
    expect(calls).toEqual([
      {
        url: `${SERVER}/api/v1/conversations/7/messages`,
        method: "POST",
        project: "acme",
        // Seen: up to the notification's message, so one that came after it keeps the conversation waiting on the team.
        body: { body: "On it!", seen: AT, requestId: `notification-${Buffer.from("push-1\nOn it!").toString("hex").padEnd(64, "0").slice(0, 40)}` },
      },
    ]);
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown).toEqual([]);
    // Saved: not left in the draft.
    expect(await kept()).toEqual([]);
  });

  it("is sent once when the listener and the last response both tell of it", async () => {
    phone.last = response("reply", { userText: "On it!" });
    await (await load()).startNotificationActions();
    await phone.listener!(response("reply", { userText: "On it!" }));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("taken from the last response isn't acted on again by a later start (a reload, a launch)", async () => {
    phone.last = response("close");
    await (await load()).startNotificationActions();
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
    expect(phone.last).toBeNull();
    vi.resetModules();
    await (await load()).startNotificationActions();
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });

  it("leaves a newer last response for its own start", async () => {
    phone.last = response("close", { id: "push-2" });
    await (await load()).act(response("close"));
    expect(phone.last).not.toBeNull();
  });

  it("is in the conversation's draft while it's being sent, so a process ended meanwhile loses nothing", async () => {
    vi.useFakeTimers();
    try {
      hang = true;
      const acting = (await load()).act(response("reply", { userText: "On it!" }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.map((call) => call.method)).toEqual(["POST"]);
      expect(await kept()).toEqual([{ body: "On it!", error: undefined }]);
      // Shown as sending, not as "Not sent" with Delete, on a screen open meanwhile.
      const { getDraft, isSending } = await import("./conversation");
      const { screenKey } = await import("./details");
      expect(isSending(getDraft(screenKey({ server: SERVER, project: "acme" }, 7)).unsent[0]!.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      await acting;
    } finally {
      vi.useRealTimers();
    }
    expect(await kept()).toEqual([{ body: "On it!", error: expect.stringContaining("Couldn't reach") }]);
    const { getDraft, isSending } = await import("./conversation");
    const { screenKey } = await import("./details");
    expect(isSending(getDraft(screenKey({ server: SERVER, project: "acme" }, 7)).unsent[0]!.id)).toBe(false);
  });

  it("for an account signed out of since (the phone's registration has a new id), sends nothing and says so", async () => {
    await (await load()).act(response("reply", { userText: "On it!", device: "an-id-since-left" }));
    expect(calls).toEqual([]);
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: It's for an account you've since signed out of."]);
    // With that id, so a tap on it opens nothing either (openTarget).
    expect(phone.shown[0]!.content.data).toEqual({ project: "acme", conversation: 7, device: "an-id-since-left" });
    expect(await kept()).toEqual([]);

    // A push that names no registration: nothing either.
    phone.shown = [];
    await (await load()).act(response("reply", { userText: "On it!", device: null, id: "push-2" }));
    expect(calls).toEqual([]);
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: It's for an account you've since signed out of."]);
  });

  it("is sent whichever of the server's addresses the teammate signed in with (a custom domain, an alias)", async () => {
    phone.stored.set("session", JSON.stringify({ server: "https://help.acme.example", token: "token-1", cookie: "c", project: "acme" }));
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(calls.map((call) => [call.method, call.url])).toEqual([["POST", "https://help.acme.example/api/v1/conversations/7/messages"]]);
  });

  it("whose answer's body never comes is given up on too, and kept", async () => {
    vi.useFakeTimers();
    try {
      // Headers, then the network gone before the body.
      answer = () => ({ status: 200, statusText: "OK", headers: new Headers(), ok: true, text: () => new Promise<string>(() => {}) }) as unknown as Response;
      const acting = (await load()).act(response("reply", { userText: "On it!" }));
      await vi.advanceTimersByTimeAsync(15_000);
      await acting;
    } finally {
      vi.useRealTimers();
    }
    expect(phone.shown.map((shown) => shown.content.title)).toEqual(["Your reply didn't send"]);
    expect(await kept()).toEqual([{ body: "On it!", error: expect.stringContaining("Couldn't reach") }]);
  });

  it("goes to another of the teammate's projects, never to one that isn't theirs", async () => {
    answer = (call) => (call.url.endsWith("/projects") ? Response.json({ projects: [{ slug: "acme" }, { slug: "globex" }] }) : Response.json({}));
    await (await load()).act(response("reply", { userText: "On it!", project: "globex" }));
    expect(calls.map((call) => [call.method, call.url, call.project])).toEqual([
      ["GET", `${SERVER}/api/v1/projects`, undefined],
      ["POST", `${SERVER}/api/v1/conversations/7/messages`, "globex"],
    ]);

    calls.length = 0;
    phone.dismissed = [];
    await (await load()).act(response("reply", { userText: "On it!", project: "initech", id: "push-2" }));
    expect(calls.map((call) => call.url)).toEqual([`${SERVER}/api/v1/projects`]);
    // Not sent, and said so, rather than left spinning.
    expect(phone.dismissed).toEqual(["push-2"]);
    expect(phone.shown.map((shown) => shown.content)).toEqual([
      { title: "Your reply didn't send", body: "Ada · Acme: It's in a project you're not on.", data: { project: "initech", conversation: 7, device: DEVICE } },
    ]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    expect(getDraft(screenKey({ server: SERVER, project: "initech" }, 7)).unsent).toEqual([]);
  });

  it("that can't check the project (offline) is kept too, never lost", async () => {
    answer = () => {
      throw new TypeError("Network request failed");
    };
    await (await load()).act(response("reply", { userText: "On it!", project: "globex" }));
    expect(phone.shown.map((shown) => shown.content.body)).toEqual([
      "Ada · Acme: Couldn't reach tuti.example. Check the address and your connection. It's kept in the conversation, with Retry.",
    ]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    expect(getDraft(screenKey({ server: SERVER, project: "globex" }, 7)).unsent.map((one) => one.body)).toEqual(["On it!"]);
  });

  it("whose session the server ended (401) is signed out: nothing kept, as the next launch forgets drafts", async () => {
    answer = () => Response.json({ error: { code: "unauthorized", message: "Sign in again." } }, { status: 401 });
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: You're signed out of Tuti."]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    expect(getDraft(screenKey({ server: SERVER, project: "acme" }, 7)).unsent).toEqual([]);
  });

  const drafts = () => [...phone.files.keys()].filter((key) => key.startsWith("documents/drafts/"));
  // A sign-out in the app's other JavaScript (Android's task runs in one of its own when the app was killed): the drafts'
  // files deleted and the session gone, while this one still has the draft in memory.
  const signOutElsewhere = () => {
    drafts().forEach((key) => phone.files.delete(key));
    phone.stored.set("session", JSON.stringify({ server: SERVER, token: "token-2", cookie: "c", project: "acme" }));
  };

  it("that fails after a sign-out isn't kept for whoever signs in next", async () => {
    answer = () => {
      signOutElsewhere();
      throw new TypeError("Network request failed");
    };
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: Couldn't reach tuti.example. Check the address and your connection."]);
    expect(drafts()).toEqual([]);
  });

  it("that's saved after a sign-out writes nothing back, not even what was typed in the conversation", async () => {
    const { screenKey } = await import("./details");
    phone.files.set(`documents/drafts/${encodeURIComponent(screenKey({ server: SERVER, project: "acme" }, 7))}.json`, JSON.stringify({ reply: "half-written" }));
    answer = () => {
      signOutElsewhere();
      return Response.json({});
    };
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(drafts()).toEqual([]);
  });

  it("that fails as a sign-out forgets the drafts, before the session goes, isn't said to be kept", async () => {
    const { forgetDrafts, getDraft } = await import("./conversation");
    answer = () => {
      forgetDrafts();
      throw new TypeError("Network request failed");
    };
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: Couldn't reach tuti.example. Check the address and your connection."]);
    const { screenKey } = await import("./details");
    expect(getDraft(screenKey({ server: SERVER, project: "acme" }, 7)).unsent).toEqual([]);
  });

  it("whose answer never comes is given up on, kept and said not to have gone", async () => {
    vi.useFakeTimers();
    try {
      hang = true;
      const acting = (await load()).act(response("reply", { userText: "On it!" }));
      await vi.advanceTimersByTimeAsync(15_000);
      await acting;
    } finally {
      vi.useRealTimers();
    }
    expect(phone.shown.map((shown) => shown.content.body)).toEqual([
      "Ada · Acme: Couldn't reach tuti.example. Check the address and your connection. It's kept in the conversation, with Retry.",
    ]);
  });

  it("of only spaces sends nothing, and the notification goes", async () => {
    await (await load()).act(response("reply", { userText: "   " }));
    expect(calls).toEqual([]);
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown).toEqual([]);
  });

  it("signed out, sends nothing and says so", async () => {
    phone.stored.clear();
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(calls).toEqual([]);
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown.map((shown) => [shown.content.title, shown.content.body])).toEqual([["Your reply didn't send", "Ada · Acme: You're signed out of Tuti."]]);
  });

  it("that didn't send is kept in the conversation with Retry, and a notification says so and opens it", async () => {
    answer = () => {
      throw new TypeError("Network request failed");
    };
    const { act } = await load();
    await act(response("reply", { userText: "On it!" }));
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown).toEqual([
      {
        content: {
          title: "Your reply didn't send",
          body: "Ada · Acme: Couldn't reach tuti.example. Check the address and your connection. It's kept in the conversation, with Retry.",
          data: { project: "acme", conversation: 7, device: DEVICE },
        },
        trigger: null,
      },
    ]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    const draft = getDraft(screenKey({ server: SERVER, project: "acme" }, 7));
    expect(draft.unsent).toEqual([
      expect.objectContaining({ id: calls[0]!.body && (calls[0]!.body as { requestId: string }).requestId, body: "On it!", note: false, error: expect.stringContaining("Couldn't reach") }),
    ]);
  });
});

describe("Close", () => {
  it("closes the conversation and dismisses the notification", async () => {
    await (await load()).act(response("close"));
    expect(calls).toEqual([{ url: `${SERVER}/api/v1/conversations/7`, method: "PATCH", project: "acme", body: { status: "closed" } }]);
    expect(phone.dismissed).toEqual(["push-1"]);
  });

  it("that failed leaves a notification in the server's words, on Android's channel", async () => {
    phone.os = "android";
    answer = () => Response.json({ error: { code: "forbidden", message: "You can't change this conversation." } }, { status: 403 });
    await (await load()).act(response("close"));
    expect(phone.shown).toEqual([
      {
        content: { title: "Couldn't close the conversation", body: "Ada · Acme: You can't change this conversation.", data: { project: "acme", conversation: 7, device: DEVICE } },
        trigger: { channelId: "default" },
      },
    ]);
  });
});

describe("on Android", () => {
  // A push as the task is given it: Firebase's data, the server's in `body` as JSON.
  const push = (data: object) => ({ messageId: "0:fcm-1", notification: null, data: { categoryId: "conversation", body: JSON.stringify(data), dataString: JSON.stringify(data) } });
  const pushed = { project: "acme", conversation: 7, at: AT, title: "Ada · Acme", text: "Hi", device: DEVICE };

  it("shows a push itself, with Reply and Close, on the app's channel", async () => {
    phone.os = "android";
    (await load()).startNotificationActions();
    await phone.task!({ data: push({ ...pushed, device: DEVICE }) });
    expect(phone.shown).toEqual([
      {
        identifier: "0:fcm-1",
        // The registration's id kept, for its actions to check.
        content: { title: "Ada · Acme", body: "Hi", data: { project: "acme", conversation: 7, at: AT, device: DEVICE }, categoryIdentifier: "conversation", sound: "default" },
        trigger: { channelId: "default" },
      },
    ]);
  });

  it("shows nothing signed out, for a sign-in since left, or for a push that isn't a server's", async () => {
    phone.os = "android";
    const { present } = await load();
    phone.stored.clear();
    await present(push(pushed));
    signIn();
    await present(push({ ...pushed, project: "Not a slug" }));
    await present(push({ project: "acme", conversation: 7 }));
    await present(push({ ...pushed, device: "an-id-since-left" }));
    await present(push({ ...pushed, device: undefined }));
    await present({ data: { body: "not JSON" } });
    await present(null);
    expect(phone.shown).toEqual([]);
  });

  it("after a reply, updates the notification before taking it away, or the system keeps it for the reply's history", async () => {
    phone.os = "android";
    phone.presented = [{ request: { identifier: "push-1", content: { data: { project: "acme", conversation: 7 } } } }];
    // The update shown late, past the wait for the system to redraw it.
    phone.postMs = 2500;
    vi.useFakeTimers();
    try {
      const acting = (await load()).act(response("reply", { userText: "On it!" }));
      await vi.advanceTimersByTimeAsync(2400);
      // Not taken away until the update shows: a cancel before it would leave the update behind for good.
      expect(phone.dismissed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(phone.dismissed).toEqual([]);
      // Then a moment for the system to take the reply's spinner off.
      await vi.advanceTimersByTimeAsync(1000);
      await acting;
    } finally {
      vi.useRealTimers();
    }
    expect(phone.shown).toEqual([{ identifier: "push-1", content: { title: "Ada · Acme", body: "Hi", data: { project: "acme", conversation: 7, at: AT, device: DEVICE, sent: true }, sound: false }, trigger: { channelId: "default" } }]);
    expect(phone.dismissed).toEqual(["push-1"]);
  });

  it("after a reply, waits for the update even when the original is already gone", async () => {
    phone.os = "android";
    // Swiped away meanwhile: nothing shown, and the update posted late.
    phone.presented = [];
    phone.postMs = 2500;
    vi.useFakeTimers();
    try {
      const acting = (await load()).act(response("reply", { userText: "On it!" }));
      await vi.advanceTimersByTimeAsync(2400);
      expect(phone.dismissed).toEqual([]);
      await vi.advanceTimersByTimeAsync(2500);
      await acting;
    } finally {
      vi.useRealTimers();
    }
    expect(phone.dismissed).toEqual(["push-1"]);
  });

  it("acts from the background task when the app isn't in front, and not from the listener as well", async () => {
    phone.os = "android";
    phone.appState = "background";
    (await load()).startNotificationActions();
    expect(phone.registered).toEqual(["notification-action"]);
    await phone.listener!(response("close"));
    expect(calls).toEqual([]);
    // Also run for every push received: only an action is acted on.
    await phone.task!({ data: { notification: {}, data: {} } });
    expect(calls).toEqual([]);
    // As the system gives it, the data still JSON.
    const raw = response("close") as unknown as { notification: { request: { content: { data?: unknown; dataString?: string } } } };
    raw.notification.request.content.dataString = JSON.stringify(raw.notification.request.content.data);
    delete raw.notification.request.content.data;
    await phone.task!({ data: raw });
    expect(calls.map((call) => [call.method, call.url])).toEqual([["PATCH", `${SERVER}/api/v1/conversations/7`]]);
  });

  it("acts from the listener while the app is in front", async () => {
    phone.os = "android";
    (await load()).startNotificationActions();
    await phone.listener!(response("close"));
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });
});
