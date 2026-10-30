"use client";

import { ChevronDownIcon, LockIcon, MonitorIcon, MoonIcon, SmartphoneIcon, SunIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useActionState, useCallback, useContext, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { COMMAND_MENU_NAVIGATE } from "@/lib/command-menu-event";
import { keepingFields } from "@/lib/forms";
import { CUSTOMIZE, PREVIEW_TOKEN_PARAM, PREVIEW_TTL_SECONDS } from "@/lib/portal-base";
import { isFromPortal, type PortalLook, PREVIEW_FRAME, type ToPortal } from "@/lib/portal-look";
import { cn } from "@/lib/utils";
import { CUSTOMIZE_GROUPS, sectionTitle } from "@/app/app/[project]/customize/sections";
import type { WidgetIcon } from "@/lib/widget-icons";
import type { FormState } from "@/server/form-state";

/** The widget's launcher as the team is setting it, for Widget's preview. */
export type WidgetDraft = { label: string; color: string; position: "bottom-right" | "bottom-left"; icon: WidgetIcon; iconUrl: string | null };

/** The portal's search listing as the team is setting it, for SEO's preview (`image`: its address). */
export type SeoDraft = { title: string; description: string; image: string | null };

/** Changes not saved yet: to the portal's look (sent to the frame), to the widget's launcher, or to the search listing. */
export type Draft = Partial<PortalLook> & { widget?: WidgetDraft; seo?: SeoDraft };

/** A form of the section's that "Save changes" in the panel's header submits (see useCustomizeForm); a section may have several. */
type SaveForm = { dirty: boolean; pending: boolean };

/** What a Customize section's settings can ask of the preview beside them. */
type Preview = {
  /** Shows what's saved: a new frame (`version` counts them), and the page's settings as saved. */
  reload: () => void;
  version: number;
  draft: Draft;
  /** Merges a change not saved yet into the preview. */
  setDraft: (draft: Draft) => void;
  /** A form's state, by its id; null once it's gone. */
  register: (id: string, form: SaveForm | null) => void;
};

const PreviewContext = createContext<Preview>({ reload: () => {}, version: 0, draft: {}, setDraft: () => {}, register: () => {} });

/** The preview beside a Customize section's settings (a no-op anywhere else). */
export const usePreview = () => useContext(PreviewContext);

/**
 * A Customize section's form: "Save changes" in the panel's header submits it (`save`, an action like
 * useActionState's), enabled once something in it differs from what was saved and while nothing is
 * `busy` (an upload); `toDraft` (when given) turns what's in it into a change for the preview, shown as
 * it's made. Spread `form` on the form. Fields set by code rather than typing say so with useFieldChanged.
 */
export function useCustomizeForm({
  save,
  onSaved,
  toDraft,
  busy = false,
}: {
  save: (state: FormState, data: FormData) => Promise<FormState>;
  /** After a save that went through. */
  onSaved?: () => void;
  toDraft?: (data: FormData) => Draft;
  busy?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLFormElement>(null);
  const { setDraft, register } = usePreview();
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const draftOf = useRef(toDraft);
  useEffect(() => {
    draftOf.current = toDraft;
  });

  const read = useCallback(() => {
    const form = ref.current;
    if (!form) {
      return;
    }
    const data = new FormData(form);
    const snapshot = JSON.stringify([...data.entries()].map(([name, value]) => [name, typeof value === "string" ? value : ""]));
    baseline.current ??= snapshot;
    setDirty(snapshot !== baseline.current);
    if (draftOf.current) {
      setDraft(draftOf.current(data));
    }
  }, [setDraft]);

  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, data) => {
    const result = await save(prev, data);
    if (!result.error) {
      // What's in the form now is what's saved.
      baseline.current = null;
      read();
      onSaved?.();
    }
    return result;
  }, {});

  useEffect(() => {
    const form = ref.current;
    if (!form) {
      return;
    }
    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
    };
  }, [read]);
  useEffect(() => register(id, { dirty, pending: pending || busy }), [register, id, dirty, pending, busy]);
  useEffect(() => () => register(id, null), [register, id]);

  const { onSubmit, ...submit } = keepingFields(action);
  return {
    state,
    form: {
      ...submit,
      id,
      ref,
      // Saves trim what's typed: so does the form first, so what it shows (and counts as saved) is what's saved.
      onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
        for (const field of event.currentTarget.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type]), input[type="text"], input[type="url"], textarea')) {
          field.value = field.value.trim();
        }
        onSubmit(event);
      },
    },
  };
}

/** Tells a form (useCustomizeForm) that a field in `element` changed without anyone typing: after each change of `value`. */
export function useFieldChanged(element: React.RefObject<Element | null>, value: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    element.current?.dispatchEvent(new Event("change", { bubbles: true }));
  }, [element, value]);
}

const DEVICES = {
  desktop: { width: 1280, label: "Desktop", icon: MonitorIcon },
  phone: { width: 390, label: "Phone", icon: SmartphoneIcon },
} as const;
type Device = keyof typeof DEVICES;

const THEMES = {
  light: { label: "Light mode", icon: SunIcon },
  dark: { label: "Dark mode", icon: MoonIcon },
} as const;
type Theme = keyof typeof THEMES;

type Choices = { device: Device; setDevice: (device: Device) => void; theme: Theme | null; setTheme: (theme: Theme) => void };
const ChoicesContext = createContext<Choices | null>(null);

/** The preview's size and light or dark mode, kept as you move between Customize's sections (its layout holds them). */
export function PreviewChoices({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<Device>("desktop");
  const [theme, setTheme] = useState<Theme | null>(null);
  return <ChoicesContext value={{ device, setDevice, theme, setTheme }}>{children}</ChoicesContext>;
}

/**
 * A Customize section: Customize's sections in a rail on the far left (the preview stays as you move
 * between them), the section's settings in a panel beside it (its title, "Save changes"),
 * and on the right the portal they change, live in a frame (its Tuti address, which the app may
 * frame: see proxy.ts), as a desktop or a phone shows it, in light or dark mode. Changes show there
 * as they're made; leaving with some not saved asks first. On phones the preview comes after the
 * settings.
 */
export function CustomizeShell({
  projectSlug,
  section,
  preview,
  children,
}: {
  projectSlug: string;
  /** The section's slug (sections.ts): its title, and where it is in the rail. */
  section: string;
  /**
   * The portal page to show: `origin`, its Tuti address; `path`, the page; `address`, where readers
   * find the portal, for the address bar. Or something of its own to show.
   */
  preview: { origin: string; path: string; address: string; token?: string } | { custom: ReactNode };
  children: ReactNode;
}) {
  const title = sectionTitle(section);
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const [draft, setDraftState] = useState<Draft>({});
  const [forms, setForms] = useState<Record<string, SaveForm>>({});
  const [leaving, setLeaving] = useState<string | null>(null);
  // The draft stays: once saved, it's what's saved (and the new frame gets it again when it opens).
  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    router.refresh();
  }, [router]);
  const setDraft = useCallback((part: Draft) => setDraftState((current) => ({ ...current, ...part })), []);
  const register = useCallback(
    (id: string, next: SaveForm | null) =>
      setForms((current) => {
        const others = { ...current };
        delete others[id];
        return next ? { ...others, [id]: next } : others;
      }),
    [],
  );
  const dirty = Object.values(forms).some((form) => form.dirty);
  const pending = Object.values(forms).some((form) => form.pending);
  // "Save changes": every form of the section's with a change.
  const save = () => {
    for (const [id, form] of Object.entries(forms)) {
      if (form.dirty) {
        (document.getElementById(id) as HTMLFormElement | null)?.requestSubmit();
      }
    }
  };

  // Leaving with changes not saved: the browser asks on reloading or closing, we ask on the app's links.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const url = new URL(link.href);
      // Another site, or this very page (its section in the rail): not leaving.
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setLeaving(`${url.pathname}${url.search}${url.hash}`);
    };
    // And on ⌘K's.
    const onNavigate = (event: Event) => {
      const href = (event as CustomEvent<string>).detail;
      const url = new URL(href, window.location.origin);
      // This very section: not leaving.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      event.preventDefault();
      setLeaving(href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener(COMMAND_MENU_NAVIGATE, onNavigate);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(COMMAND_MENU_NAVIGATE, onNavigate);
    };
  }, [dirty]);

  return (
    <PreviewContext value={{ reload, version, draft, setDraft, register }}>
      <div className="flex flex-1 flex-col lg:h-[calc(100svh-3rem)] lg:flex-row">
        <CustomizeRail projectSlug={projectSlug} section={section} />
        <div className="flex flex-col border-b lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
          <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b bg-background px-4">
            <h1 className="text-sm font-semibold">{title}</h1>
            {Object.keys(forms).length > 0 && (
              <Button type="button" size="sm" disabled={!dirty || pending} onClick={save} className="ml-auto">
                {pending ? "Saving…" : "Save changes"}
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-6 p-4">{children}</div>
        </div>
        {"custom" in preview ? (
          <div className="flex min-h-[32rem] flex-1 flex-col bg-muted/40 p-4 lg:min-h-0">{preview.custom}</div>
        ) : (
          <PortalPreview version={version} draft={draft} {...preview} />
        )}
      </div>
      <AlertDialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to {title} aren&apos;t saved. Leaving drops them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const href = leaving;
                setForms({});
                setLeaving(null);
                if (href) {
                  router.push(href);
                }
              }}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PreviewContext>
  );
}

/** The portal in a frame: it says which page is open, and takes changes not saved yet and light or dark mode. */
function PortalPreview({
  version,
  draft,
  origin,
  path: firstPath,
  address,
  token,
}: {
  version: number;
  draft: Draft;
  origin: string;
  path: string;
  address: string;
  /** Reads the portal as the team member looking (the portal keeps it as a cookie). */
  token?: string;
}) {
  const { device, setDevice, theme, setTheme } = useContext(ChoicesContext)!;
  // The page open in the frame (for the address bar); a new frame (after a save) opens it again.
  // The token is a frame's too: each render of the page signs a new one, and a new address would reload the frame.
  // It lasts an hour (it's the portal's cookie for the frame): half way, the page is refreshed for a new one, and the
  // frame reopens with it at its page.
  const router = useRouter();
  const [path, setPath] = useState(firstPath);
  const [opened, setOpened] = useState({ version, path: firstPath, token });
  if (opened.version !== version) {
    setOpened({ version, path, token });
  }
  const tokenAt = useRef(0);
  // An Effect Event, so the timer goes by the token alone: the router can be a new object after a refresh,
  // and restarting then would date the token afresh, and the new one would never be taken.
  const renew = useEffectEvent(() => router.refresh());
  useEffect(() => {
    tokenAt.current = Date.now();
    const timer = setTimeout(renew, (PREVIEW_TTL_SECONDS * 1000) / 2);
    return () => clearTimeout(timer);
  }, [opened.token]);
  useEffect(() => {
    if (token !== opened.token && Date.now() - tokenAt.current >= (PREVIEW_TTL_SECONDS * 1000) / 2) {
      setOpened((current) => ({ ...current, path, token }));
    }
  }, [token, opened.token, path]);
  const [ready, setReady] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin === origin && event.source === frame.current?.contentWindow && isFromPortal(event.data)) {
        setPath(event.data.path);
        setReady((count) => count + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  // Each change, and again whenever a page opens in the frame (it starts from what's saved).
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!ready || !target) {
      return;
    }
    const look: Partial<PortalLook> = { ...draft };
    delete (look as Draft).widget;
    delete (look as Draft).seo;
    target.postMessage({ type: "tuti:look", look } satisfies ToPortal, origin);
    if (theme) {
      target.postMessage({ type: "tuti:theme", theme } satisfies ToPortal, origin);
    }
  }, [ready, draft, theme, origin]);

  // The page laid out at the device's width, scaled down to fit the frame.
  const { width } = DEVICES[device];
  const scale = size.width ? Math.min(1, size.width / width) : 1;
  const query = new URLSearchParams({ [CUSTOMIZE.param]: CUSTOMIZE.value, ...(opened.token && { [PREVIEW_TOKEN_PARAM]: opened.token }) });
  const src = `${origin}${opened.path}${opened.path.includes("?") ? "&" : "?"}${query}`;
  const page = path.replace(/[?#].*$/, "");

  return (
    <div className="flex min-h-[36rem] flex-1 flex-col gap-3 bg-muted/40 p-4 lg:min-h-0">
      <div className="flex justify-end gap-3">
        <Toggle label="Preview mode" options={THEMES} value={theme} onChange={setTheme} />
        <Toggle label="Preview size" options={DEVICES} value={device} onChange={setDevice} />
      </div>
      <div className={cn("mx-auto flex w-full flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm", device === "phone" && "max-w-[392px]")}>
        <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
          <span aria-hidden className="flex gap-1.5">
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="size-2.5 rounded-full bg-muted-foreground/25" />
            ))}
          </span>
          <span className="mx-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <LockIcon className="size-3 shrink-0" />
            <span className="truncate">{`${address}${page === "/" ? "" : page}`.replace(/^https?:\/\//, "")}</span>
          </span>
        </div>
        <div ref={box} className="relative flex-1 overflow-hidden">
          {size.width > 0 && (
            <iframe
              ref={frame}
              // A new frame for each saved change, so it shows it.
              key={version}
              title="Portal preview"
              name={PREVIEW_FRAME}
              src={src}
              className="absolute top-0 left-0 origin-top-left border-0 bg-background"
              style={{ width, height: size.height / scale, transform: `scale(${scale})` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<T, { label: string; icon: typeof SunIcon }>;
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {(Object.keys(options) as T[]).map((key) => {
        const { label: name, icon: Icon } = options[key];
        return (
          <button
            key={key}
            type="button"
            aria-label={name}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
            className={buttonVariants({ variant: value === key ? "secondary" : "ghost", size: "icon-sm" })}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

/** One part of a Customize section's settings, in a box of its own: a title, a line on what it's for, then its fields. */
export function CustomizeSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  // Not a labelled region: its title is often its one field's label too ("Favicon").
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Customize's sections, in a rail on the far left from laptop width; above the panel, as a menu, on smaller screens. */
function CustomizeRail({ projectSlug, section }: { projectSlug: string; section: string }) {
  const link = (slug: string, title: string, Icon: React.ComponentType<{ className?: string }>) => (
    <Link
      key={slug}
      href={`/app/${projectSlug}/customize/${slug}`}
      aria-current={slug === section ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
        slug === section ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {title}
    </Link>
  );
  const groups = CUSTOMIZE_GROUPS.map((group) => (
    <div key={group.title} className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h2>
      {group.sections.map((s) => link(s.slug, s.title, s.icon))}
    </div>
  ));
  return (
    <>
      <nav aria-label="Customize" className="hidden w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3 lg:flex">
        {groups}
      </nav>
      {/* `key`: closed again after moving to another section. */}
      <details key={section} className="group border-b lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          Customize: {sectionTitle(section)}
          <ChevronDownIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <nav aria-label="Customize" className="flex flex-col gap-4 border-t p-3">
          {groups}
        </nav>
      </details>
    </>
  );
}
