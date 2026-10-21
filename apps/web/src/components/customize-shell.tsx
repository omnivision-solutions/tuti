"use client";

import { ChevronLeftIcon, LockIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import Link from "next/link";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What a Customize section's settings can ask of the preview beside them: `reload` it once a change is saved (`version` counts them). */
type Preview = { reload: () => void; version: number };

const PreviewContext = createContext<Preview>({ reload: () => {}, version: 0 });

/** The preview beside a Customize section's settings (a no-op anywhere else). */
export const usePreview = () => useContext(PreviewContext);

const DEVICES = {
  desktop: { width: 1280, label: "Desktop", icon: MonitorIcon },
  phone: { width: 390, label: "Phone", icon: SmartphoneIcon },
} as const;
type Device = keyof typeof DEVICES;

/**
 * A Customize section: its settings in a panel on the left (the way back, its title, then the
 * settings), and on the right the portal they change, live in a frame (its Tuti address, which the
 * app may frame: see proxy.ts), as a desktop or a phone shows it. On phones the preview comes after
 * the settings.
 */
export function CustomizeShell({
  backHref,
  title,
  preview,
  children,
}: {
  backHref: string;
  title: string;
  /** `src`: the page to show (with CUSTOMIZE's param); `address`: where readers find it, for the address bar. Or something of its own to show. */
  preview: { src: string; address: string } | { custom: ReactNode };
  children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <PreviewContext value={{ reload, version }}>
      <div className="flex flex-1 flex-col lg:h-[calc(100svh-3rem)] lg:flex-row">
        <section aria-labelledby="customize-title" className="flex flex-col border-b lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
          <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b bg-background px-2">
            <Link href={backHref} aria-label="Back to Customize" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
              <ChevronLeftIcon />
            </Link>
            <h1 id="customize-title" className="text-sm font-semibold">
              {title}
            </h1>
          </div>
          <div className="flex flex-col gap-6 p-4">{children}</div>
        </section>
        {"custom" in preview ? (
          <div className="flex min-h-[32rem] flex-1 flex-col bg-muted/40 p-4 lg:min-h-0">{preview.custom}</div>
        ) : (
          <PortalPreview version={version} src={preview.src} address={preview.address} />
        )}
      </div>
    </PreviewContext>
  );
}

function PortalPreview({ version, src, address }: { version: number; src: string; address: string }) {
  const [device, setDevice] = useState<Device>("desktop");
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
  // The page laid out at the device's width, scaled down to fit the frame.
  const { width } = DEVICES[device];
  const scale = size.width ? Math.min(1, size.width / width) : 1;

  return (
    <div className="flex min-h-[36rem] flex-1 flex-col gap-3 bg-muted/40 p-4 lg:min-h-0">
      <div role="group" aria-label="Preview size" className="flex justify-end gap-1">
        {(Object.keys(DEVICES) as Device[]).map((key) => {
          const { label, icon: Icon } = DEVICES[key];
          return (
            <button
              key={key}
              type="button"
              aria-label={label}
              aria-pressed={device === key}
              onClick={() => setDevice(key)}
              className={buttonVariants({ variant: device === key ? "secondary" : "ghost", size: "icon-sm" })}
            >
              <Icon />
            </button>
          );
        })}
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
            <span className="truncate">{address.replace(/^https?:\/\//, "")}</span>
          </span>
        </div>
        <div ref={box} className="relative flex-1 overflow-hidden">
          {size.width > 0 && (
            <iframe
              // A new frame for each saved change, so it shows it.
              key={version}
              title="Portal preview"
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
