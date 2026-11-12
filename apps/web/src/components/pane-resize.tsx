"use client";

import { cn } from "cn";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { PANE_WIDTHS, type ResizablePane } from "@/lib/pane-width";

/** An overlay in the existing pane gap: resizing never adds a column or moves the gap. */
export function PaneResize({ pane, className }: { pane: ResizablePane; className: string }) {
  const config = PANE_WIDTHS[pane];
  // Rem defaults equal the minimum; server ARIA starts at its baseline pixel value.
  const initialWidth = typeof config.default === "number" ? config.default : config.min;
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const stop = useCallback(() => {
    const pointer = drag.current?.pointer;
    drag.current = null;
    document.documentElement.removeAttribute("data-pane-resizing");
    if (pointer !== undefined && handle.current?.hasPointerCapture(pointer)) handle.current.releasePointerCapture(pointer);
  }, []);
  const measure = useCallback(() => {
    // Hidden handles need no measurements or preference updates; reconnect when shown again.
    if (!shown.current) return `${initialWidth},${config.min},${config.max}`;
    const min = pane === "inbox" ? 22 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize) : config.min;
    let max: number = config.max;
    const workspace = handle.current?.closest(".inbox-workspace");
    if (workspace) {
      // CSS reserves this room before hydration; measuring the rendered cards keeps ARIA and input in sync.
      // Layout changes only clamp the rendered width, leaving the stored preference untouched.
      const thread = workspace.querySelector(".inbox-thread");
      const details = workspace.querySelector(".inbox-details");
      const detailsWidth = details?.getBoundingClientRect().width ?? 0;
      const detailsSpace = detailsWidth && thread ? detailsWidth + Number.parseFloat(getComputedStyle(thread).columnGap) : 0;
      const gap = Number.parseFloat(getComputedStyle(workspace).columnGap);
      max = Math.max(min, Math.min(max, Math.floor(workspace.getBoundingClientRect().width - gap - detailsSpace - 480)));
    }
    const defaultWidth = typeof config.default === "number" ? config.default : min;
    const preferred = Number.parseFloat(document.documentElement.style.getPropertyValue(config.variable)) || Math.max(defaultWidth, min);
    return `${Math.min(max, Math.max(min, preferred))},${min},${max}`;
  }, [config, initialWidth, pane]);
  const value = useRef(`${initialWidth},${config.min},${config.max}`);
  const subscribe = useCallback((changed: () => void) => {
    // React also asks for snapshots during unrelated server refreshes. Only observer notifications
    // measure layout; reads during render return the last measured value.
    const update = () => {
      const next = measure();
      if (next !== value.current) {
        value.current = next;
        changed();
      }
    };
    const mutations = new MutationObserver(update);
    const sizes = new ResizeObserver(update);
    const children = new MutationObserver(() => connect());
    const connect = () => {
      mutations.disconnect();
      sizes.disconnect();
      children.disconnect();
      if (shown.current) {
        mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
        const column = document.querySelector(config.selector);
        if (column) sizes.observe(column);
        const workspace = handle.current?.closest(".inbox-workspace");
        if (workspace) {
          sizes.observe(workspace);
          // Navigation replaces the thread. Observe only its parent's direct children, never messages.
          const conversation = workspace.querySelector(".inbox-conversation-pane");
          if (conversation) children.observe(conversation, { childList: true });
          const thread = workspace.querySelector(".inbox-thread");
          if (thread) mutations.observe(thread, { attributes: true, attributeFilter: ["data-details"] });
          const details = workspace.querySelector(".inbox-details");
          if (details) sizes.observe(details);
        }
      } else stop();
      update();
    };
    // The handle follows the same @container/app query as its pane. Observe its
    // rendered visibility rather than a viewport query, including rem and sidebar changes.
    const visibility = new ResizeObserver(([entry]) => {
      shown.current = entry.contentRect.width > 0;
      connect();
    });
    if (handle.current) visibility.observe(handle.current);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
      children.disconnect();
      visibility.disconnect();
      shown.current = false;
    };
  }, [config, measure, stop]);
  const snapshot = useCallback(() => value.current, []);
  const [width, min, max] = useSyncExternalStore(subscribe, snapshot, () => `${initialWidth},${config.min},${config.max}`).split(",").map(Number);

  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
    };
  }, [stop]);
  const setWidth = (value: number | null) => {
    const root = document.documentElement;
    const next = value === null ? null : Math.round(Math.min(max, Math.max(min, value)));
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
      aria-valuemin={min}
      aria-valuemax={max}
      className={cn("pane-resize group/resize z-20 hidden w-2.5 touch-none cursor-col-resize items-center justify-center outline-none", pane === "docs" ? "@min-[61rem]/app:flex" : "@min-[52.5rem]/inbox:flex", className)}
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
        const next = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: min, End: max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setWidth(next);
      }}
    >
      <span aria-hidden className="pointer-events-none h-8 w-0.5 rounded-full bg-border group-hover/resize:h-[calc(100%-16px)] group-hover/resize:bg-primary group-focus/resize:h-[calc(100%-16px)] group-focus/resize:bg-primary in-[:root[data-pane-resizing]]:h-[calc(100%-16px)] in-[:root[data-pane-resizing]]:bg-primary" />
    </div>
  );
}
