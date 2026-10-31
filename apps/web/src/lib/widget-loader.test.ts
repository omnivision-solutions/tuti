import { expect, test, vi } from "vitest";

import { WIDGET_ICONS } from "./widget-icons";
import { widgetLoader } from "./widget-loader";

test("the loader is valid JavaScript with the portal template and the slug check built in", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain('"https://{project}.tuti.example".replace("{project}", slug)');
  expect(script).toContain("/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)");
  // Text goes in with textContent; nothing builds HTML from strings.
  expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("sign-in tokens go to the panel only, on the portal's origin, when it asks", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  // postMessage to the frame names its origin; never "*" for a token.
  expect(script).toMatch(/target\.postMessage\(\{ type: "tuti:identify", token: token \}, origin\)/);
  expect(script).not.toMatch(/postMessage\([^)]*token[^)]*"\*"\)/);
  // Messages count only from the panel's own window and origin.
  expect(script).toContain("if (!event.source || event.origin !== origin) return;");
  expect(script).toContain("var from = frameOf(event.source);\n    if (!from) return;");
});

/** Just enough DOM to run the loader: elements with attributes, styles, children and bubbling clicks. */
class FakeElement {
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: unknown[] = [];
  parent: FakeElement | null = null;
  listeners: Record<string, ((event: object) => void)[]> = {};
  [property: string]: unknown;
  constructor(
    readonly tagName: string,
    private readonly page: FakePage,
  ) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  appendChild<T>(child: T) {
    if (child instanceof FakeElement) child.parent = this;
    this.children.push(child);
    return child;
  }
  replaceChild(child: FakeElement, old: FakeElement) {
    child.parent = this;
    this.children[this.children.indexOf(old)] = child;
    return old;
  }
  addEventListener(type: string, listener: (event: object) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  focus() {
    this.page.document.activeElement = this;
  }
  closest(selector: string) {
    const name = /^\[([\w-]+)\]$/.exec(selector)![1]!;
    return this.ancestors().find((element) => element.hasAttribute(name)) ?? null;
  }
  /** This element, its parent, and so on up. */
  ancestors(): FakeElement[] {
    return [this, ...(this.parent?.ancestors() ?? [])];
  }
  /** The launcher's name: what screen readers say, and its tooltip. */
  get accessibleName() {
    return { label: this.getAttribute("aria-label"), title: this.title };
  }
  /** The launcher's icon: a built-in one's paths, or an image's address. */
  get icon() {
    const icon = this.children[0] as FakeElement;
    return icon.tagName === "img" ? { src: icon.src } : (icon.children as FakeElement[]).map((path) => path.getAttribute("d"));
  }
  /** A click that bubbles up to the document (with modifier keys, or already cancelled, from `init`); says whether the default was prevented. */
  click(init: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean } = {}) {
    const event = { button: 0, ...init, target: this, defaultPrevented: init.defaultPrevented ?? false, preventDefault: () => (event.defaultPrevented = true) };
    for (const element of this.ancestors()) {
      element.listeners.click?.forEach((listener) => listener(event));
    }
    this.page.documentListeners.click?.forEach((listener) => listener(event));
    return event.defaultPrevented;
  }
}

type FakePage = ReturnType<typeof loadWidget>;

/**
 * Runs the loader on a fake page whose script tag has `attributes`, with /api/widget/latest answering
 * `latest`, /api/widget/seen answering `seen` and this browser having seen announcements up to `seenHere`.
 */
function loadWidget({ attributes = {}, settings, latest = { latest: null, launcher: null }, seen = null, messages = 0, seenAfter, seenHere, narrow = false, motion, before }: {
  attributes?: Record<string, string>;
  /** Whether the browser animates (elements have `animate`), and whether the visitor asked for less motion. */
  motion?: "full" | "reduced";
  settings?: object;
  /** Whether the screen is narrow (max-width: 640px). */
  narrow?: boolean;
  /** Builds the page's own elements before the script runs. */
  before?: (page: FakePage) => void;
  /** null: the request fails; "hang": it never answers. */
  latest?: object | null | "hang";
  /** What this person has seen on any device; "fail": the request fails. */
  seen?: string | null | "fail";
  /** How many of the team's messages (support inbox) this person hasn't seen. */
  messages?: number;
  /** /api/widget/seen answers once this settles (a slow request). */
  seenAfter?: Promise<void>;
  seenHere?: string;
}) {
  const documentListeners: Record<string, ((event: object) => void)[]> = {};
  const windowListeners: Record<string, ((event: object) => void)[]> = {};
  const stored = new Map<string, string>(seenHere ? [["tuti:seen:acme", seenHere]] : []);
  const mediaLists: { matches: boolean; onchange: (() => void) | null }[] = [];
  const observers: (() => void)[] = [];
  // What each observer watches (MutationObserver's options).
  const watching: { attributeFilter?: string[] }[] = [];
  const page = {
    documentListeners,
    windowListeners,
    mediaLists,
    /** What the script's MutationObservers watch. */
    watching,
    /** The page changed: what MutationObserver tells the script. */
    mutated() {
      observers.forEach((callback) => callback());
    },
    /** The screen becomes narrow or wide. */
    resize(narrow: boolean) {
      for (const list of mediaLists.filter((list) => list.onchange)) {
        list.matches = narrow;
        list.onchange!();
      }
    },
    /** Every animation run, as [keyframes, options, the animation]. */
    animations: [] as [object[], { duration: number }, { cancelled: boolean; reversed: number; onfinish: (() => void) | null; cancel(): void; reverse(): void }][],
    /** A key pressed on the page. */
    press(key: string) {
      documentListeners.keydown?.forEach((listener) => listener({ key }));
    },
    /** A message from `source` (a window) on `origin`. */
    message(source: unknown, data: unknown, origin = "https://acme.tuti.example") {
      windowListeners.message?.forEach((listener) => listener({ source, origin, data }));
    },
    get backdrop() {
      return page.body.children.find((child) => (child as FakeElement).tagName === "div" && (child as FakeElement).id !== "tuti-widget") as
        | FakeElement
        | undefined;
    },
    /** The page's inline panels. */
    get inlineFrames() {
      return page.document.querySelectorAll("[data-tuti-inline]").flatMap((element) => element.children as FakeElement[]);
    },
    document: {
      activeElement: null as unknown,
      body: null as unknown as FakeElement,
      currentScript: null as unknown as FakeElement,
      createElement: (tag: string) => {
        const element = new FakeElement(tag, page);
        if (motion) {
          element.animate = (keyframes: object[], options: { duration: number }) => {
            const animation = {
              cancelled: false,
              reversed: 0,
              onfinish: null as (() => void) | null,
              cancel: () => void (animation.cancelled = true),
              reverse: () => void animation.reversed++,
            };
            page.animations.push([keyframes, options, animation]);
            return animation;
          };
        }
        // An iframe's window, for messages to and from it.
        if (tag === "iframe") element.contentWindow = { postMessage: vi.fn() };
        return element;
      },
      createElementNS: (namespace: string, tag: string) => {
        expect(namespace).toBe("http://www.w3.org/2000/svg");
        return new FakeElement(tag, page);
      },
      createTextNode: (text: string) => ({ nodeValue: text }),
      querySelectorAll: (selector: string) => {
        const name = /^\[([\w-]+)\]$/.exec(selector)![1]!;
        const all = (element: FakeElement): FakeElement[] =>
          element.children.flatMap((child) => (child instanceof FakeElement ? [child, ...all(child)] : []));
        return all(page.document.body).filter((element) => element.hasAttribute(name));
      },
      addEventListener: (type: string, listener: (event: object) => void) => (documentListeners[type] ??= []).push(listener),
      contains: (element: FakeElement) => {
        for (let e: FakeElement | null = element; e; e = e.parent) if (e === page.document.body) return true;
        return false;
      },
    },
    window: {
      TutiSettings: settings,
      matchMedia: (query: string) => {
        const list = {
          matches: (narrow && query === "(max-width: 640px)") || (motion === "reduced" && query === "(prefers-reduced-motion: reduce)"),
          media: query,
          onchange: null as (() => void) | null,
        };
        mediaLists.push(list);
        return list;
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(_target: unknown, options: { attributeFilter?: string[] }) {
          watching.push(options);
        }
      },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
      addEventListener: (type: string, listener: (event: object) => void) => (windowListeners[type] ??= []).push(listener),
      fetch: vi.fn(async (url: string) => {
        if (url.startsWith("https://app.tuti.example/api/widget/seen?")) {
          if (seen === "fail") throw new TypeError("Failed to fetch");
          await seenAfter;
          return { ok: true, json: async () => ({ seen, messages }) };
        }
        if (latest === "hang") return new Promise(() => {});
        if (!latest) throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => latest };
      }),
    } as Record<string, unknown>,
    get body() {
      return page.document.body;
    },
    get button() {
      return page.body.children.find((child) => (child as FakeElement).tagName === "button") as FakeElement | undefined;
    },
    get panel() {
      return page.body.children.find((child) => (child as FakeElement).id === "tuti-widget") as FakeElement;
    },
    get frame() {
      return page.panel.children.find((child) => (child as FakeElement).tagName === "iframe") as FakeElement | undefined;
    },
    /** Calls to /api/widget/seen. */
    get seenRequests() {
      return (page.window.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes("/api/widget/seen"));
    },
    get stored() {
      return stored;
    },
    /** The panel saying the visitor has seen announcements up to `at`. */
    seen(at: string) {
      page.windowListeners.message?.forEach((listener) =>
        listener({ source: (page.frame as unknown as { contentWindow?: unknown }).contentWindow, origin: "https://acme.tuti.example", data: { type: "tuti:seen", at } }),
      );
    },
    get Tuti() {
      return page.window.Tuti as {
        identify(getToken: () => unknown): void;
        open(options?: object): void;
        close(): void;
        unseen(): boolean;
        on(name: string, callback: (unseen: boolean) => void): void;
      };
    },
  };
  page.document.body = new FakeElement("body", page);
  const script = new FakeElement("script", page);
  script.src = "https://app.tuti.example/widget.js";
  script.setAttribute("data-project", "acme");
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  page.document.currentScript = script;
  before?.(page);
  new Function("window", "document", "fetch", widgetLoader("https://{project}.tuti.example"))(
    page.window,
    page.document,
    page.window.fetch,
  );
  return page;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the launcher shows the team's name, colour, corner and icon once the app has said what they are", async () => {
  const page = loadWidget({
    before: (page) => void inlineMount(page),
    latest: { latest: null, launcher: { label: "Help & ideas", color: "#5b21b6", textColor: "#ffffff", position: "bottom-left", icon: "megaphone", iconUrl: null } },
  });
  expect(page.window.fetch).toHaveBeenCalledWith("https://app.tuti.example/api/widget/latest?project=acme");
  // Not before, so it doesn't change under the visitor's pointer.
  expect(page.button).toBeUndefined();
  await settled();
  const button = page.button!;
  // A round button with an icon in its text colour; the name is for screen readers and the tooltip.
  expect(button.accessibleName).toEqual({ label: "Help & ideas", title: "Help & ideas" });
  expect(button.icon).toEqual(WIDGET_ICONS.megaphone);
  expect((button.children[0] as FakeElement).getAttribute("stroke")).toBe("currentColor");
  expect(button.style).toMatchObject({ width: "56px", height: "56px", borderRadius: "999px", background: "#5b21b6", color: "#ffffff", left: "20px", right: "auto" });
  expect(page.panel.style).toMatchObject({ left: "20px", right: "auto" });
  // The panel is named after the button that opens it, and so is one already in the page.
  expect(page.inlineFrames[0]!.title).toBe("Help & ideas");
  page.Tuti.open();
  expect(page.frame!.title).toBe("Help & ideas");
});

test("the team's own icon is an image; one that doesn't load, an image without its address, or an unknown icon, is the chat bubble", async () => {
  const launcher = { label: "Help", color: null, position: "bottom-right" };
  const own = loadWidget({ latest: { latest: null, launcher: { ...launcher, icon: "image", iconUrl: "https://app.tuti.example/media/m1/w480.webp?s=x" } } });
  await settled();
  expect(own.button!.icon).toEqual({ src: "https://app.tuti.example/media/m1/w480.webp?s=x" });
  expect((own.button!.children[0] as FakeElement).alt).toBe("");
  // One that doesn't load is the chat bubble.
  (own.button!.children[0] as FakeElement & { onerror(): void }).onerror();
  expect(own.button!.icon).toEqual(WIDGET_ICONS.chat);
  for (const icon of [{ icon: "image", iconUrl: null }, { icon: "toString" }, { icon: "rocket" }]) {
    const page = loadWidget({ latest: { latest: null, launcher: { ...launcher, ...icon } } });
    await settled();
    expect(page.button!.icon).toEqual(WIDGET_ICONS.chat);
  }
});

test("without settings (or without an answer) the launcher is the green chat bubble named Feedback, bottom right", async () => {
  for (const latest of [{ latest: null, launcher: null }, null]) {
    const page = loadWidget({ latest });
    await settled();
    expect(page.button!.accessibleName).toEqual({ label: "Feedback", title: "Feedback" });
    expect(page.button!.icon).toEqual(WIDGET_ICONS.chat);
    expect(page.button!.style).toMatchObject({ right: "20px", background: "oklch(0.529 0.125 155)" });
    expect(page.Tuti.unseen()).toBe(false);
  }
});

test("if the app doesn't answer, the button shows up after 3 seconds anyway", () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ latest: "hang" });
    vi.advanceTimersByTime(2999);
    expect(page.button).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(page.button!.accessibleName.label).toBe("Feedback");
  } finally {
    vi.useRealTimers();
  }
});

test("data-hide-launcher or TutiSettings.hideLauncher leaves the button out; Tuti.open() and Tuti.close() still work", async () => {
  for (const page of [loadWidget({ attributes: { "data-hide-launcher": "" } }), loadWidget({ settings: { hideLauncher: true } })]) {
    await settled();
    expect(page.button).toBeUndefined();
    // The panel takes the button's place.
    expect(page.panel.style.bottom).toBe("20px");
    const own = page.body.appendChild(new FakeElement("button", page));
    own.focus();
    page.Tuti.open();
    expect(page.panel.style.display).toBe("block");
    expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
    page.Tuti.close();
    expect(page.panel.style.display).toBe("none");
    // Focus goes back to the page's own button.
    expect(page.document.activeElement).toBe(own);
  }
});

test("Tuti.open({ tab }) opens the panel at that tab, Tuti.open() where it was; unknown tabs are reported", async () => {
  const page = loadWidget({});
  page.Tuti.open({ tab: "whats-new" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=whats-new");
  page.Tuti.open({ tab: "docs" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=docs");
  page.Tuti.open();
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=docs");
  page.Tuti.open({ tab: "feedback" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=feedback");
  page.Tuti.open({ tab: "home" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  page.Tuti.open({ tab: "settings" });
  expect(error).toHaveBeenCalledWith("Tuti widget: tab is one of home, messages, docs, feedback or whats-new");
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
  error.mockRestore();
});

test("Tuti.open({ article }) and data-tuti-article elements, also ones added later, open the panel at that article", async () => {
  const page = loadWidget({});
  page.Tuti.open({ article: "a b/c" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=docs&article=a%20b%2Fc");
  page.Tuti.close();

  // A help link added after the script ran, clicked on its icon: no navigation, the article opens.
  const help = page.body.appendChild(new FakeElement("a", page));
  help.setAttribute("data-tuti-article", "exporting-your-data");
  const icon = help.appendChild(new FakeElement("svg", page));
  expect(icon.click()).toBe(true);
  expect(page.panel.style.display).toBe("block");
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=docs&article=exporting-your-data");
  // Closing gives focus back to it.
  page.Tuti.close();
  expect(page.document.activeElement).toBe(help);

  // Other clicks are the page's own.
  expect(page.body.appendChild(new FakeElement("button", page)).click()).toBe(false);
  expect(page.panel.style.display).toBe("none");
  // So are a help link's clicks with a modifier key (new tab, new window, download) or that the page already handled.
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    expect(help.click(init)).toBe(false);
  }
  help.click({ defaultPrevented: true });
  expect(page.panel.style.display).toBe("none");
});

test("Tuti.unseen() and Tuti.on('unseen') tell the page about an announcement this browser hasn't seen", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([]);
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  expect(calls).toEqual([true]);
  expect(page.button!.getAttribute("aria-label")).toBe("Feedback, new updates");
  // A callback added later hears the status straight away; a failing one doesn't stop the others.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  page.Tuti.on("unseen", () => {
    throw new Error("page bug");
  });
  const late: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => late.push(unseen));
  expect(late).toEqual([true]);
  error.mockRestore();
});

test("the panel saying it showed an older announcement doesn't hide a newer one", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  await settled();
  page.Tuti.open({ tab: "whats-new" });
  const seen = (at: string) =>
    page.windowListeners.message?.forEach((listener) =>
      listener({ source: (page.frame as unknown as { contentWindow?: unknown }).contentWindow, origin: "https://acme.tuti.example", data: { type: "tuti:seen", at } }),
    );
  // The panel was rendered before the newest announcement was published.
  seen("2026-10-17T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(true);
  seen("2026-10-18T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(false);
});

test("an announcement this browser has seen isn't unseen", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  (page.window.localStorage as { setItem(key: string, value: string): void }).setItem("tuti:seen:acme", "2026-10-18T10:00:00.000Z");
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([false]);
});

const token = () => Promise.resolve("sso-token");
const LATEST = { latest: "2026-10-18T10:00:00.000Z", launcher: null };

test("someone the page signs in who saw the announcement on another device doesn't see it as new here; this browser remembers", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "2026-10-19T08:00:00.000Z", seenHere: "2026-10-01T00:00:00.000Z" });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  // Worked out once, with what they've seen anywhere: no dot that comes and goes.
  expect(calls).toEqual([false]);
  expect(page.Tuti.unseen()).toBe(false);
  expect(page.seenRequests).toEqual([
    ["https://app.tuti.example/api/widget/seen?project=acme", { headers: { authorization: "Bearer sso-token" } }],
  ]);
  // The later of the two times.
  expect(page.stored.get("tuti:seen:acme")).toBe("2026-10-19T08:00:00.000Z");
});

test("the later of this browser's time and the person's counts; without a newer one, it's still new", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "2026-10-01T00:00:00.000Z", seenHere: "2026-10-05T00:00:00.000Z" });
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  expect(page.stored.get("tuti:seen:acme")).toBe("2026-10-05T00:00:00.000Z");
});

test("nobody signed in, or seen in this browser already: no request about the person", async () => {
  const anonymous = loadWidget({ latest: LATEST });
  const seenHere = loadWidget({ settings: { identify: token }, latest: LATEST, seenHere: "2026-10-18T10:00:00.000Z" });
  await settled();
  expect(anonymous.Tuti.unseen()).toBe(true);
  expect(seenHere.Tuti.unseen()).toBe(false);
  expect([...anonymous.seenRequests, ...seenHere.seenRequests]).toEqual([]);
});

test("if the person's time can't be read (no token, or the request fails), this browser's counts", async () => {
  const failed = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "fail" });
  const noToken = loadWidget({ settings: { identify: () => null }, latest: LATEST, seen: "2026-10-19T08:00:00.000Z" });
  await settled();
  expect(failed.Tuti.unseen()).toBe(true);
  expect(noToken.Tuti.unseen()).toBe(true);
  expect(noToken.seenRequests).toEqual([]);
});

test("signed in after the status was worked out (Tuti.identify), it's checked again", async () => {
  const page = loadWidget({ latest: LATEST, seen: "2026-10-19T08:00:00.000Z" });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.identify(token);
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([true, false]);
});

test("when the panel shows the announcement, it's recorded for the person, so their other devices know", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: null });
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.open({ tab: "whats-new" });
  page.seen("2026-10-18T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(false);
  await settled();
  expect(page.seenRequests.at(-1)).toEqual([
    "https://app.tuti.example/api/widget/seen?project=acme",
    {
      method: "POST",
      headers: { authorization: "Bearer sso-token", "content-type": "application/json" },
      body: JSON.stringify({ at: "2026-10-18T10:00:00.000Z" }),
    },
  ]);
  // Not for visitors the page doesn't sign in.
  const anonymous = loadWidget({ latest: LATEST });
  await settled();
  anonymous.Tuti.open({ tab: "whats-new" });
  anonymous.seen("2026-10-18T10:00:00.000Z");
  await settled();
  expect(anonymous.seenRequests).toEqual([]);
});

test("by default the panel opens above the launcher; on a phone it's the whole screen, over the launcher; no drawer, no backdrop", async () => {
  const page = loadWidget({});
  await settled();
  page.button!.click();
  expect(page.panel.style).toMatchObject({ display: "block", top: "auto", right: "20px", bottom: "88px", borderRadius: "14px" });
  // Turned to a phone's width and back.
  page.resize(true);
  expect(page.panel.style).toMatchObject({ top: "0", left: "0", borderRadius: "0" });
  page.resize(false);
  expect(page.panel.style).toMatchObject({ top: "auto", right: "20px", left: "auto", borderRadius: "14px", paddingTop: "0" });
  expect(page.backdrop).toBeUndefined();
  expect(page.inlineFrames).toEqual([]);

  const phone = loadWidget({ narrow: true });
  await settled();
  phone.button!.click();
  expect(phone.panel.style).toMatchObject({ display: "block", top: "0", right: "0", bottom: "0", left: "0", borderRadius: "0", zIndex: "2147483001" });
  // Clear of the phone's status bar and home indicator, where the page runs under them.
  expect(phone.panel.style).toMatchObject({ boxSizing: "border-box", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" });
  expect(phone.backdrop).toBeUndefined();
});

test("data-display or TutiSettings.display picks the mode, the attribute first; an unknown one is reported and it's the launcher", async () => {
  const sidebar = (page: FakePage) => page.panel.style.top === "0";
  expect(sidebar(loadWidget({ attributes: { "data-display": "sidebar" } }))).toBe(true);
  expect(sidebar(loadWidget({ settings: { display: "sidebar" } }))).toBe(true);
  expect(sidebar(loadWidget({ attributes: { "data-display": "launcher" }, settings: { display: "sidebar" } }))).toBe(false);

  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const unknown = loadWidget({ attributes: { "data-display": "popup" } });
  expect(error).toHaveBeenCalledWith("Tuti widget: display is one of launcher, sidebar or inline");
  error.mockRestore();
  await settled();
  expect(sidebar(unknown)).toBe(false);
  expect(unknown.button!.accessibleName.label).toBe("Feedback");
});

test("the panel grows out of the launcher's corner as it opens, and shrinks back before it's hidden; turned around halfway, it goes back from where it is", async () => {
  const page = loadWidget({ motion: "full", latest: { latest: null, launcher: { position: "bottom-left" } } });
  await settled();
  expect(page.panel.style.transformOrigin).toBe("bottom left");
  page.button!.click();
  expect(page.panel.style.display).toBe("block");
  const [keyframes, options, opening] = page.animations[0]!;
  expect(keyframes).toEqual([{ opacity: 0, transform: "translateY(16px) scale(0.94)" }, { opacity: 1, transform: "none" }]);
  expect(options.duration).toBe(260);
  opening.onfinish!();

  // Closing: still there while it animates away, but closed (focus back on the button) and inert, then hidden.
  page.Tuti.close();
  const [away, , closing] = page.animations[1]!;
  expect(away).toEqual([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(16px) scale(0.94)" }]);
  expect(page.panel.style.display).toBe("block");
  expect(page.panel.hasAttribute("inert")).toBe(true);
  expect(page.button!.getAttribute("aria-expanded")).toBe("false");
  closing.onfinish!();
  expect(page.panel.style.display).toBe("none");

  // Opened, then closed and opened again before either finishes: the same animation turns around each time.
  page.Tuti.open();
  expect(page.panel.hasAttribute("inert")).toBe(false);
  page.Tuti.close();
  page.Tuti.open();
  expect(page.animations).toHaveLength(3);
  expect(page.animations[2]![2].reversed).toBe(2);
  page.animations[2]![2].onfinish!();
  expect(page.panel.style.display).toBe("block");
});

test("a sidebar slides in from its edge; with less motion asked for, the panel just appears and goes", async () => {
  const sidebar = loadWidget({ motion: "full", attributes: { "data-display": "sidebar" } });
  sidebar.Tuti.open();
  expect(sidebar.animations[0]![0]).toEqual([{ transform: "translateX(100%)" }, { transform: "none" }]);

  const calm = loadWidget({ motion: "reduced" });
  calm.Tuti.open();
  expect(calm.panel.style.display).toBe("block");
  calm.Tuti.close();
  expect(calm.panel.style.display).toBe("none");
  expect(calm.animations).toEqual([]);

  // Asked for while the page is open: from then on.
  const page = loadWidget({ motion: "full" });
  page.mediaLists.find((list) => (list as { media?: string }).media === "(prefers-reduced-motion: reduce)")!.matches = true;
  page.Tuti.open();
  expect(page.animations).toEqual([]);
});

test("sidebar: a full-height drawer on the launcher's side; Escape closes it and focus goes back to the button", async () => {
  const page = loadWidget({ attributes: { "data-display": "sidebar" } });
  await settled();
  const button = page.button!;
  expect(page.panel.style).toMatchObject({ display: "none", top: "0", bottom: "0", right: "0", width: "min(400px, 100vw)" });
  // Over the launcher, which sits in the same corner.
  expect(Number(page.panel.style.zIndex)).toBeGreaterThan(Number(button.style.zIndex));
  button.focus();
  button.click();
  expect(page.panel.style.display).toBe("block");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(page.document.activeElement).toBe(page.frame);
  // Wide screen: the page stays usable beside it.
  expect(page.backdrop!.style.display).toBe("none");
  page.press("Escape");
  expect(page.panel.style.display).toBe("none");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(page.document.activeElement).toBe(button);

  // On the left with a bottom-left launcher.
  const left = loadWidget({ attributes: { "data-display": "sidebar" }, latest: { latest: null, launcher: { position: "bottom-left" } } });
  await settled();
  expect(left.panel.style).toMatchObject({ left: "0", right: "auto" });
});

test("sidebar on a narrow screen: a backdrop that closes the drawer, also after the screen changes", async () => {
  const page = loadWidget({ attributes: { "data-display": "sidebar" }, narrow: true });
  await settled();
  const button = page.button!;
  button.click();
  expect(page.backdrop!.style.display).toBe("block");
  // Under the drawer, over the page.
  expect(page.body.children.indexOf(page.backdrop)).toBeLessThan(page.body.children.indexOf(page.panel));
  page.backdrop!.click();
  expect(page.panel.style.display).toBe("none");
  expect(page.backdrop!.style.display).toBe("none");
  expect(page.document.activeElement).toBe(button);

  // Turned to landscape while open, and back.
  page.Tuti.open();
  page.resize(false);
  expect(page.backdrop!.style.display).toBe("none");
  page.resize(true);
  expect(page.backdrop!.style.display).toBe("block");
  // A closed drawer leaves no backdrop behind.
  page.Tuti.close();
  page.resize(false);
  page.resize(true);
  expect(page.backdrop!.style.display).toBe("none");
});

/** A data-tuti-inline element on the page, naming `tab` (empty: the default), with other `attributes`. */
function inlineMount(page: FakePage, tab = "", attributes: Record<string, string> = {}) {
  const element = page.body.appendChild(new FakeElement("div", page));
  element.setAttribute("data-tuti-inline", tab);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

test("inline: each data-tuti-inline element gets its own panel, at the tab it names, without a close button", async () => {
  const page = loadWidget({
    attributes: { "data-display": "inline" },
    before: (page) => {
      inlineMount(page);
      inlineMount(page, "docs");
      // The page's own data-tab (its own tabs, say) is none of the widget's business.
      inlineMount(page, "", { "data-tab": "whats-new" });
    },
  });
  await settled();
  // No launcher in inline mode.
  expect(page.button).toBeUndefined();
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual([
    "https://acme.tuti.example/widget?display=inline",
    "https://acme.tuti.example/widget?tab=docs&display=inline",
    "https://acme.tuti.example/widget?display=inline",
  ]);
  for (const frame of page.inlineFrames) {
    expect(frame).toMatchObject({ tagName: "iframe", name: "tuti-inline", title: "Feedback" });
    expect(frame.style).toMatchObject({ width: "100%", height: "100%", minHeight: "500px", border: "0" });
  }
  // The floating panel is still there for Tuti.open().
  page.Tuti.open({ tab: "whats-new" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=whats-new");
  expect(page.inlineFrames).toHaveLength(3);
});

test("inline mounts work in every mode, also ones added later, each mounted once; an unknown tab is reported, and it's the default", async () => {
  const page = loadWidget({ before: (page) => void inlineMount(page, "whats-new") });
  await settled();
  expect(page.button!.accessibleName.label).toBe("Feedback");
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual(["https://acme.tuti.example/widget?tab=whats-new&display=inline"]);

  // A single-page app shows one later.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  inlineMount(page, "settings");
  page.mutated();
  page.mutated();
  expect(error).toHaveBeenCalledWith("Tuti widget: tab is one of home, messages, docs, feedback or whats-new");
  error.mockRestore();
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual([
    "https://acme.tuti.example/widget?tab=whats-new&display=inline",
    "https://acme.tuti.example/widget?display=inline",
  ]);
});

test("inline panels get sign-in tokens and say what's been seen; they can't close the floating panel", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, before: (page) => void inlineMount(page) });
  await settled();
  const inline = page.inlineFrames[0]!;
  const frameWindow = inline.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: "tuti:identify", token: "sso-token" }, "https://acme.tuti.example");

  // Only from the portal's origin, and only from the script's own frames.
  page.message(frameWindow, { type: "tuti:seen", at: LATEST.latest }, "https://evil.example");
  page.message({ postMessage: vi.fn() }, { type: "tuti:seen", at: LATEST.latest });
  expect(page.Tuti.unseen()).toBe(true);
  page.message(frameWindow, { type: "tuti:seen", at: LATEST.latest });
  expect(page.Tuti.unseen()).toBe(false);

  page.Tuti.open();
  page.message(frameWindow, "tuti:close");
  expect(page.panel.style.display).toBe("block");
  page.message(page.frame!.contentWindow, "tuti:close");
  expect(page.panel.style.display).toBe("none");

  // One the page has removed is forgotten.
  const mount = inline.parent!;
  page.body.children.splice(page.body.children.indexOf(mount), 1);
  mount.parent = null;
  page.mutated();
  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
});

test("asked twice, a panel gets only the newest token: an older one the page's app answers later (someone signed in before) is dropped", async () => {
  // The page's app answers each request when the test says.
  const answers: ((token: string) => void)[] = [];
  const identify = () => new Promise<string>((resolve) => answers.push(resolve));
  const page = loadWidget({ settings: { identify }, latest: LATEST, before: (page) => void inlineMount(page) });
  await settled();
  // The script's own (what's been seen elsewhere), then the panel's two.
  const frameWindow = page.inlineFrames[0]!.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
  page.message(frameWindow, { type: "tuti:ready" });
  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(answers).toHaveLength(3);
  answers[0]!("token-for-sam");
  answers[2]!("token-for-kim");
  await settled();
  answers[1]!("token-for-sam");
  await settled();
  expect(frameWindow.postMessage.mock.calls).toEqual([[{ type: "tuti:identify", token: "token-for-kim" }, "https://acme.tuti.example"]]);
});

test("an inline mount the page removes and puts back (tab panels, keep-alive views) keeps its panel, which still gets tokens and says what's been seen", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, before: (page) => void inlineMount(page) });
  await settled();
  const mount = page.body.children[0] as FakeElement;
  const inline = page.inlineFrames[0]!;
  const frameWindow = inline.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
  page.body.children.splice(0, 1);
  mount.parent = null;
  page.mutated();
  page.body.appendChild(mount);
  page.mutated();
  // Still the one panel, not a second.
  expect(page.inlineFrames).toEqual([inline]);

  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: "tuti:identify", token: "sso-token" }, "https://acme.tuti.example");
  expect(page.Tuti.unseen()).toBe(true);
  page.message(frameWindow, { type: "tuti:seen", at: LATEST.latest });
  expect(page.Tuti.unseen()).toBe(false);
});

test("with the support inbox on, the team's unseen messages to whoever the page signs in show the dot, until the panel says they're seen", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: { latest: null, launcher: null, inbox: true }, messages: 2 });
  await settled();
  expect(page.seenRequests).toHaveLength(1);
  expect(page.Tuti.unseen()).toBe(true);
  expect(page.button!.getAttribute("aria-label")).toBe("Feedback, new updates");

  page.Tuti.open({ tab: "messages" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=messages");
  const frameWindow = (page.frame as unknown as { contentWindow: unknown }).contentWindow;
  page.message(frameWindow, { type: "tuti:unseen-messages", count: 1 });
  expect(page.Tuti.unseen()).toBe(true);
  page.message(frameWindow, { type: "tuti:unseen-messages", count: 0 });
  expect(page.Tuti.unseen()).toBe(false);

  // With it off, nobody's asked about.
  const off = loadWidget({ settings: { identify: token }, latest: { latest: null, launcher: null }, messages: 2 });
  await settled();
  expect(off.seenRequests).toEqual([]);
  expect(off.Tuti.unseen()).toBe(false);
});

test("when the page signs them out (Tuti.identify with no token), the team's unseen messages to them stop showing", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: { latest: null, launcher: null, inbox: true }, messages: 2 });
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.identify(() => null);
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
});

test("Tuti.identify again: the team's messages counted for whoever was before stop showing at once, not once the new token's read", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: { latest: null, launcher: null, inbox: true }, messages: 0 });
  await settled();
  page.Tuti.open();
  page.message((page.frame as unknown as { contentWindow: unknown }).contentWindow, { type: "tuti:unseen-messages", count: 3 });
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.identify(() => new Promise<string>(() => {}));
  expect(page.Tuti.unseen()).toBe(false);
});

test("Tuti.identify after a panel reported messages the script didn't know the inbox had: the new person's are read", async () => {
  // The inbox flag was read before the team turned it on.
  const page = loadWidget({ settings: { identify: token }, latest: { latest: null, launcher: null, inbox: false }, messages: 2 });
  await settled();
  page.Tuti.open();
  page.message((page.frame as unknown as { contentWindow: unknown }).contentWindow, { type: "tuti:unseen-messages", count: 3 });
  page.Tuti.identify(token);
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
});

test("the floating panel hears when it's closed and opened again, so a hidden one doesn't count replies as seen", async () => {
  const page = loadWidget({});
  await settled();
  page.Tuti.open({ tab: "messages" });
  const panel = (page.frame as unknown as { contentWindow: { postMessage: ReturnType<typeof vi.fn> } }).contentWindow;
  page.Tuti.close();
  expect(panel.postMessage).toHaveBeenLastCalledWith({ type: "tuti:shown", shown: false }, "https://acme.tuti.example");
  page.Tuti.open();
  expect(panel.postMessage).toHaveBeenLastCalledWith({ type: "tuti:shown", shown: true }, "https://acme.tuti.example");
});

test("a floating panel closed while it loaded hears so once it's ready, so it doesn't stay online or see replies", async () => {
  const page = loadWidget({});
  await settled();
  page.Tuti.open({ tab: "messages" });
  const panel = (page.frame as unknown as { contentWindow: { postMessage: ReturnType<typeof vi.fn> } }).contentWindow;
  page.Tuti.close();
  panel.postMessage.mockClear();
  page.message(panel, { type: "tuti:ready" });
  expect(panel.postMessage).toHaveBeenCalledWith({ type: "tuti:shown", shown: false }, "https://acme.tuti.example");
});

test("a slow answer from the server doesn't bring back a count the open panel has since cleared", async () => {
  let answer!: () => void;
  const page = loadWidget({
    settings: { identify: token },
    latest: { latest: null, launcher: null, inbox: true },
    messages: 1,
    seenAfter: new Promise<void>((resolve) => (answer = resolve)),
  });
  await settled();
  page.Tuti.open({ tab: "messages" });
  // The panel showed the reply (so it's seen) before the server's count, asked for earlier, arrives.
  page.message((page.frame as unknown as { contentWindow: unknown }).contentWindow, { type: "tuti:unseen-messages", count: 0 });
  answer();
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
});

test("a page that signs nobody in says so, so the panel doesn't wait for a token before someone writes as a visitor", async () => {
  for (const settings of [undefined, { identify: () => null }, { identify: () => Promise.reject(new Error("Not signed in")) }]) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = loadWidget({ settings, latest: LATEST, before: (page) => void inlineMount(page) });
    await settled();
    const frameWindow = page.inlineFrames[0]!.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
    page.message(frameWindow, { type: "tuti:ready" });
    await settled();
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: "tuti:identify", token: null }, "https://acme.tuti.example");
    error.mockRestore();
  }
});

test("Tuti.identify with someone else hands the new token to panels already open, so none keeps the previous person's", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, before: (page) => void inlineMount(page) });
  await settled();
  page.Tuti.open();
  const floating = (page.frame as unknown as { contentWindow: { postMessage: ReturnType<typeof vi.fn> } }).contentWindow;
  const inline = page.inlineFrames[0]!.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
  page.Tuti.identify(() => Promise.resolve("someone-else"));
  await settled();
  for (const panel of [floating, inline]) {
    expect(panel.postMessage).toHaveBeenLastCalledWith({ type: "tuti:identify", token: "someone-else" }, "https://acme.tuti.example");
  }
});

test("when the page's new identify gives no token or fails, open panels hear nobody's signed in", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const page = loadWidget({ settings: { identify: token }, latest: LATEST });
  await settled();
  page.Tuti.open();
  const panel = (page.frame as unknown as { contentWindow: { postMessage: ReturnType<typeof vi.fn> } }).contentWindow;
  for (const identify of [() => Promise.resolve(""), () => Promise.reject(new Error("Signed out"))]) {
    page.Tuti.identify(identify);
    await settled();
    expect(panel.postMessage).toHaveBeenLastCalledWith({ type: "tuti:identify", token: null }, "https://acme.tuti.example");
  }
  error.mockRestore();
});

test("on a phone, until the panel's page is up with its own Close, the loader's Close is there, so a page that never comes can still be closed", async () => {
  const page = loadWidget({ narrow: true });
  await settled();
  page.button!.click();
  const standIn = page.panel.children.find((child) => child instanceof FakeElement && child.getAttribute("aria-label") === "Close") as FakeElement;
  expect(standIn.style.display).toBe("flex");
  // The page failed (offline, an error): its Close closes the panel.
  standIn.click();
  expect(page.panel.hasAttribute("inert")).toBe(true);
  // Up, with its own Close: the loader's goes.
  page.button!.click();
  page.message(page.frame!.contentWindow, "tuti:closable");
  expect(standIn.style.display).toBe("none");
  // Its page goes away (a tab loading as a new page, which may fail): back until the next says it's up.
  page.message(page.frame!.contentWindow, { type: "tuti:closable", closable: false });
  expect(standIn.style.display).toBe("flex");
  page.message(page.frame!.contentWindow, "tuti:closable");
  expect(standIn.style.display).toBe("none");
  // Wide screens never show it.
  page.resize(false);
  expect(standIn.style.display).toBe("none");
});

test("on a phone the open panel is the whole screen, so the page under it is out of reach (Tab, screen readers) until it closes", async () => {
  const page = loadWidget({ narrow: true });
  const content = page.body.appendChild(new FakeElement("main", page));
  // Something the page made inert itself stays so.
  const own = page.body.appendChild(new FakeElement("aside", page));
  own.setAttribute("inert", "");
  await settled();
  page.button!.click();
  expect(content.hasAttribute("inert")).toBe(true);
  expect(page.button!.hasAttribute("inert")).toBe(true);
  expect(page.panel.hasAttribute("inert")).toBe(false);
  page.press("Escape");
  expect(content.hasAttribute("inert")).toBe(false);
  expect(own.hasAttribute("inert")).toBe(true);
  // Turned wide while open: back in reach.
  page.button!.click();
  page.resize(false);
  expect(content.hasAttribute("inert")).toBe(false);
});

test("on a phone, what the page adds while the panel covers it (the button, once it's set up) is out of reach too", async () => {
  const page = loadWidget({ narrow: true });
  page.Tuti.open();
  const late = page.body.appendChild(new FakeElement("div", page));
  page.mutated();
  expect(late.hasAttribute("inert")).toBe(true);
  page.Tuti.close();
  expect(late.hasAttribute("inert")).toBe(false);
});

test("on a phone, a page with a modal open (help opened from inside it) isn't covered: the modal stays usable", async () => {
  const page = loadWidget({ narrow: true });
  const app = page.body.appendChild(new FakeElement("div", page));
  const dialog = app.appendChild(new FakeElement("div", page)) as FakeElement & { checkVisibility?: () => boolean };
  dialog.setAttribute("aria-modal", "true");
  // Closed, kept in the markup: the page is covered as usual.
  dialog.checkVisibility = () => false;
  page.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(true);
  page.Tuti.close();
  // Showing: left as it is.
  dialog.checkVisibility = () => true;
  page.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(false);
  // Closed in place while the panel's open (no element added or taken away): covered then. The loader
  // hears of it: it watches the attributes a modal is opened and closed by.
  expect(page.watching.some((options) => ["aria-modal", "open"].every((name) => options.attributeFilter?.includes(name)))).toBe(true);
  dialog.setAttribute("aria-modal", "false");
  page.mutated();
  expect(app.hasAttribute("inert")).toBe(true);
});

test("on a phone, a modal the page opens once the panel covers it closes the panel: the page and the modal are left usable, focus where the modal put it", async () => {
  const page = loadWidget({ narrow: true });
  const app = page.body.appendChild(new FakeElement("div", page));
  page.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(true);
  // A popup of the page's (on a timer, say) traps focus and taps: under the panel, neither could be closed.
  const popup = page.body.appendChild(new FakeElement("div", page));
  popup.setAttribute("aria-modal", "true");
  popup.focus();
  page.mutated();
  // Closed: the panel is out of reach.
  expect(page.panel.hasAttribute("inert")).toBe(true);
  expect(app.hasAttribute("inert")).toBe(false);
  expect(popup.hasAttribute("inert")).toBe(false);
  expect(page.document.activeElement).toBe(popup);
});

test("on a phone, a page's modal counts as showing only when it is: not faded out, nor without a box where the browser can't say", async () => {
  type Modal = FakeElement & { checkVisibility?: (options?: { visibilityProperty?: boolean; opacityProperty?: boolean }) => boolean; getClientRects?: () => unknown[] };
  // Faded out (visibility: hidden, opacity 0): shown to a plain checkVisibility(), not with its options.
  const faded = loadWidget({ narrow: true });
  const app = faded.body.appendChild(new FakeElement("div", faded));
  const dialog = app.appendChild(new FakeElement("div", faded)) as Modal;
  dialog.setAttribute("aria-modal", "true");
  dialog.checkVisibility = (options) => !(options?.visibilityProperty && options.opacityProperty);
  faded.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(true);
  // A browser without checkVisibility (Safari before 17.4): one with no box (hidden) isn't showing.
  const older = loadWidget({ narrow: true });
  const page = older.body.appendChild(new FakeElement("div", older));
  const kept = page.appendChild(new FakeElement("div", older)) as Modal;
  kept.setAttribute("aria-modal", "true");
  kept.getClientRects = () => [];
  older.Tuti.open();
  expect(page.hasAttribute("inert")).toBe(true);
  // Nor one that has a box but has faded out (opacity 0).
  const fadedOut = loadWidget({ narrow: true });
  const host = fadedOut.body.appendChild(new FakeElement("div", fadedOut));
  const closing = host.appendChild(new FakeElement("div", fadedOut)) as Modal;
  closing.setAttribute("aria-modal", "true");
  closing.getClientRects = () => [{}];
  (fadedOut.window as unknown as { getComputedStyle: (element: unknown) => { display: string; visibility: string; opacity: string } }).getComputedStyle = (element) => ({
    display: "block",
    visibility: "visible",
    opacity: element === closing ? "0" : "1",
  });
  fadedOut.Tuti.open();
  expect(host.hasAttribute("inert")).toBe(true);
});

test("on a phone, a page's modal with no box of its own (display: contents) counts as showing when what's in it is", async () => {
  type Shown = FakeElement & { checkVisibility?: () => boolean };
  const page = loadWidget({ narrow: true });
  const app = page.body.appendChild(new FakeElement("div", page));
  const dialog = app.appendChild(new FakeElement("div", page)) as Shown;
  dialog.setAttribute("aria-modal", "true");
  // No box, so checkVisibility says no; what's in it shows.
  dialog.checkVisibility = () => false;
  const content = dialog.appendChild(new FakeElement("div", page)) as Shown;
  content.checkVisibility = () => true;
  (page.window as unknown as { getComputedStyle: (element: unknown) => { display: string; visibility: string } }).getComputedStyle = (element) => ({
    display: element === dialog ? "contents" : "block",
    visibility: "visible",
  });
  page.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(false);
});

test("on a phone, a page's modal that closes by a class or style (no attribute the loader hears) has the page covered once it's gone", async () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ narrow: true });
    const app = page.body.appendChild(new FakeElement("div", page));
    const dialog = app.appendChild(new FakeElement("div", page)) as FakeElement & { checkVisibility?: () => boolean };
    dialog.setAttribute("aria-modal", "true");
    let shown = true;
    dialog.checkVisibility = () => shown;
    page.Tuti.open();
    expect(app.hasAttribute("inert")).toBe(false);
    // Hidden by a style the page sets (Alpine's x-show, say): nothing the observer hears.
    shown = false;
    vi.advanceTimersByTime(300);
    expect(app.hasAttribute("inert")).toBe(true);
    page.Tuti.close();
    expect(app.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("on a phone, a modal of the page's opened inside what the panel covers (its own move of focus failed, inert) gets focus as the panel closes", async () => {
  const page = loadWidget({ narrow: true });
  const app = page.body.appendChild(new FakeElement("div", page));
  const dialog = app.appendChild(new FakeElement("div", page)) as FakeElement & { checkVisibility?: () => boolean };
  dialog.setAttribute("aria-modal", "false");
  page.Tuti.open();
  expect(app.hasAttribute("inert")).toBe(true);
  // The page opens it in place; focus stays where it was (in the panel).
  dialog.setAttribute("aria-modal", "true");
  page.mutated();
  expect(app.hasAttribute("inert")).toBe(false);
  expect(page.document.activeElement).toBe(dialog);
  expect(dialog.getAttribute("tabindex")).toBe("-1");
});

test("on a phone, a page's modal library that saves what's inert as it opens (Headless UI) and puts it back as it closes doesn't leave the page inert", async () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ narrow: true });
    const app = page.body.appendChild(new FakeElement("div", page));
    page.Tuti.open();
    expect(app.hasAttribute("inert")).toBe(true);
    // The library opens its dialog: it records the page's inert (the loader's) and makes it inert itself.
    const saved = app.hasAttribute("inert");
    app.setAttribute("inert", "");
    const popup = page.body.appendChild(new FakeElement("div", page));
    popup.setAttribute("aria-modal", "true");
    page.mutated();
    // The panel closes for it.
    expect(page.panel.hasAttribute("inert")).toBe(true);
    // Closed: it puts back what it recorded.
    page.body.children.splice(page.body.children.indexOf(popup), 1);
    if (saved) app.setAttribute("inert", "");
    vi.advanceTimersByTime(300);
    expect(app.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("on a phone, help opened again from that library's modal, which then closes, has the page covered till the panel closes", async () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ narrow: true });
    const app = page.body.appendChild(new FakeElement("div", page));
    page.Tuti.open();
    // The library's dialog opens (recording the loader's inert, setting its own): the panel closes.
    const saved = app.hasAttribute("inert");
    app.setAttribute("inert", "");
    const popup = page.body.appendChild(new FakeElement("div", page));
    popup.setAttribute("aria-modal", "true");
    page.mutated();
    // Help opened from inside it a moment later: waits, uncovered, while it shows.
    vi.advanceTimersByTime(100);
    page.Tuti.open();
    vi.advanceTimersByTime(200);
    // It closes, putting back what it recorded; the panel covers the page (and both checks run once more).
    page.body.children.splice(page.body.children.indexOf(popup), 1);
    if (saved) app.setAttribute("inert", "");
    page.mutated();
    vi.advanceTimersByTime(600);
    expect(app.hasAttribute("inert")).toBe(true);
    page.Tuti.close();
    expect(app.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("on a phone, help opened over a modal of the page's is a card, the modal in sight; the whole screen once it's gone", async () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ narrow: true });
    const app = page.body.appendChild(new FakeElement("div", page));
    const dialog = app.appendChild(new FakeElement("div", page)) as FakeElement & { checkVisibility?: () => boolean };
    dialog.setAttribute("aria-modal", "true");
    let shown = true;
    dialog.checkVisibility = () => shown;
    page.Tuti.open();
    expect(page.panel.style.top).toBe("auto");
    expect(page.panel.style.borderRadius).toBe("14px");
    shown = false;
    vi.advanceTimersByTime(300);
    expect(app.hasAttribute("inert")).toBe(true);
    expect(page.panel.style.top).toBe("0");
  } finally {
    vi.useRealTimers();
  }
});

test("on a phone, a native dialog of the page's opened over everything once the panel covers it (showModal) closes the panel", async () => {
  const page = loadWidget({ narrow: true });
  const dialog = page.body.appendChild(new FakeElement("dialog", page));
  let modal = false;
  (page.document as unknown as { querySelector: (selector: string) => unknown }).querySelector = (selector) => (selector === "dialog:modal" && modal ? dialog : null);
  page.Tuti.open();
  expect(dialog.hasAttribute("inert")).toBe(true);
  // The page opens it with showModal() (it gets `open`, and matches dialog:modal).
  modal = true;
  dialog.setAttribute("open", "");
  page.mutated();
  // Closed: the panel is out of reach.
  expect(page.panel.hasAttribute("inert")).toBe(true);
  expect(dialog.hasAttribute("inert")).toBe(false);
});
