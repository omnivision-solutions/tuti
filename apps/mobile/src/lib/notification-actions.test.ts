import type { NotificationResponse } from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone: its stored session, its files, the system's notifications and the server, all faked.
const phone = vi.hoisted(() => ({
  os: "ios" as "ios" | "android",
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
  },
  AppState: {
    get currentState() {
      return phone.appState;
    },
  },
}));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0, getItemAsync: async (key: string) => phone.stored.get(key) ?? null }));
vi.mock("expo-web-browser", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, text: string) => Buffer.from(text).toString("hex").padEnd(64, "0"),
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
  dismissNotificationAsync: async (id: string) => void phone.dismissed.push(id),
  // What the system shows: the last one posted with each identifier, posted a little after it's asked for.
  getPresentedNotificationsAsync: async () => phone.presented,
  scheduleNotificationAsync: async (request: (typeof phone.shown)[number]) => {
    phone.shown.push(request);
    setTimeout(() => {
      phone.presented = [...phone.presented.filter((one) => one.request.identifier !== request.identifier), { request: { identifier: request.identifier, content: request.content } }];
    }, 200);
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
/** When the notification's message was sent. */
const AT = "2026-11-25T10:00:00.000Z";
const signIn = (project = "acme") => phone.stored.set("session", JSON.stringify({ server: SERVER, token: "token-1", cookie: "c", project }));
const response = (actionIdentifier: string, { userText, project = "acme", id = "push-1" }: { userText?: string; project?: string; id?: string } = {}) =>
  ({
    actionIdentifier,
    ...(userText !== undefined && { userText }),
    notification: { date: 0, request: { identifier: id, trigger: null, content: { title: "Ada · Acme", body: "Hi", data: { project, conversation: 7, at: AT } } } },
  }) as unknown as NotificationResponse;

const load = () => import("./notification-actions");

beforeEach(() => {
  vi.resetModules();
  Object.assign(phone, { os: "ios", appState: "active", dismissed: [], shown: [], categories: [], listener: null, last: null, task: null, registered: [], presented: [] });
  phone.stored.clear();
  phone.files.clear();
  calls.length = 0;
  answer = () => Response.json({});
  hang = false;
  signIn();
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
  });

  it("is sent once when the listener and the last response both tell of it", async () => {
    phone.last = response("reply", { userText: "On it!" });
    await (await load()).startNotificationActions();
    await phone.listener!(response("reply", { userText: "On it!" }));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
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
      { title: "Your reply didn't send", body: "Ada · Acme: It's in a project you're not on.", data: { project: "initech", conversation: 7 } },
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

  it("that fails after a sign-out isn't kept for whoever signs in next", async () => {
    answer = () => {
      // Signed out, and another teammate in, while the send is on its way.
      phone.stored.set("session", JSON.stringify({ server: SERVER, token: "token-2", cookie: "c", project: "acme" }));
      throw new TypeError("Network request failed");
    };
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(phone.shown.map((shown) => shown.content.body)).toEqual(["Ada · Acme: Couldn't reach tuti.example. Check the address and your connection."]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    expect(getDraft(screenKey({ server: SERVER, project: "acme" }, 7)).unsent).toEqual([]);
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
          data: { project: "acme", conversation: 7 },
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
        content: { title: "Couldn't close the conversation", body: "Ada · Acme: You can't change this conversation.", data: { project: "acme", conversation: 7 } },
        trigger: { channelId: "default" },
      },
    ]);
  });
});

describe("on Android", () => {
  // A push as the task is given it: Firebase's data, the server's in `body` as JSON.
  const push = (data: object) => ({ messageId: "0:fcm-1", notification: null, data: { categoryId: "conversation", body: JSON.stringify(data), dataString: JSON.stringify(data) } });
  const pushed = { project: "acme", conversation: 7, at: AT, title: "Ada · Acme", text: "Hi" };

  it("shows a push itself, with Reply and Close, on the app's channel", async () => {
    phone.os = "android";
    (await load()).startNotificationActions();
    await phone.task!({ data: push(pushed) });
    expect(phone.shown).toEqual([
      {
        identifier: "0:fcm-1",
        content: { title: "Ada · Acme", body: "Hi", data: { project: "acme", conversation: 7, at: AT }, categoryIdentifier: "conversation", sound: "default" },
        trigger: { channelId: "default" },
      },
    ]);
  });

  it("shows nothing signed out, or for a push that isn't the server's", async () => {
    phone.os = "android";
    const { present } = await load();
    phone.stored.clear();
    await present(push(pushed));
    signIn();
    await present(push({ ...pushed, project: "Not a slug" }));
    await present(push({ project: "acme", conversation: 7 }));
    await present({ data: { body: "not JSON" } });
    await present(null);
    expect(phone.shown).toEqual([]);
  });

  it("after a reply, updates the notification before taking it away, or the system keeps it for the reply's history", async () => {
    phone.os = "android";
    phone.presented = [{ request: { identifier: "push-1", content: { data: { project: "acme", conversation: 7 } } } }];
    const { act } = await load();
    const acting = act(response("reply", { userText: "On it!" }));
    // Not taken away until the update is shown: a cancel before it would leave the update behind.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(phone.dismissed).toEqual([]);
    await acting;
    expect(phone.shown).toEqual([{ identifier: "push-1", content: { title: "Ada · Acme", body: "Hi", data: { project: "acme", conversation: 7, at: AT, sent: true }, sound: false }, trigger: { channelId: "default" } }]);
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
