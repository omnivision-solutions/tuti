"use client";

import { cn } from "cn";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { PANE_WIDTHS, type ResizablePane } from "@/lib/pane-width";

function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  return () => observer.disconnect();
}

/** An overlay in the existing 12px pane gap: resizing never adds a column or moves the gap. */
export function PaneResize({ pane, className }: { pane: ResizablePane; className: string }) {
  const config = PANE_WIDTHS[pane];
  const width = useSyncExternalStore(subscribe, () => Number.parseFloat(document.documentElement.style.getPropertyValue(config.variable)) || config.default, () => config.default);
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const stop = useCallback(() => {
    const pointer = drag.current?.pointer;
    drag.current = null;
    document.documentElement.removeAttribute("data-pane-resizing");
    if (pointer !== undefined && handle.current?.hasPointerCapture(pointer)) handle.current.releasePointerCapture(pointer);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    window.addEventListener("blur", stop);
    query.addEventListener("change", stop);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      query.removeEventListener("change", stop);
    };
  }, [stop]);
  const setWidth = (value: number | null) => {
    const root = document.documentElement;
    const next = value === null ? null : Math.round(Math.min(config.max, Math.max(config.min, value)));
    if (next === null) root.style.removeProperty(config.variable);
    else root.style.setProperty(config.variable, `${next}px`);
    try {
      if (next === null) localStorage.removeItem(config.key);
      else localStorage.setItem(config.key, String(next));
    } catch {
      // Storage blocked: keep the width for this visit.
    }
  };
  return (
    <div
      ref={handle}
      role="separator"
      tabIndex={0}
      aria-label={config.label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={config.min}
      aria-valuemax={config.max}
      className={cn("pane-resize group/resize z-20 hidden w-2.5 touch-none cursor-col-resize items-center justify-center outline-none lg:flex", className)}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        const current = document.querySelector(config.selector)?.getBoundingClientRect().width ?? width;
        drag.current = { x: event.clientX, width: current, pointer: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.setAttribute("data-pane-resizing", pane);
      }}
      onPointerMove={(event) => {
        if (drag.current) setWidth(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => setWidth(null)}
      onKeyDown={(event) => {
        const next = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: config.min, End: config.max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setWidth(next);
      }}
    >
      <span aria-hidden className="pointer-events-none h-8 w-0.5 rounded-full bg-border group-hover/resize:h-[calc(100%-16px)] group-hover/resize:bg-primary group-focus/resize:h-[calc(100%-16px)] group-focus/resize:bg-primary in-[:root[data-pane-resizing]]:h-[calc(100%-16px)] in-[:root[data-pane-resizing]]:bg-primary" />
    </div>
  );
}
