"use client";

import { cn } from "cn";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { DOCS_TREE_FOLDED_ATTRIBUTE } from "@/lib/docs-tree-fold";
import { PANE_WIDTHS, type ResizablePane } from "@/lib/pane-width";

function paneShown(pane: ResizablePane) {
  return window.matchMedia("(min-width: 1024px)").matches && (pane !== "docs" || !document.documentElement.hasAttribute(DOCS_TREE_FOLDED_ATTRIBUTE));
}

/** An overlay in the existing 12px pane gap: resizing never adds a column or moves the gap. */
export function PaneResize({ pane, className }: { pane: ResizablePane; className: string }) {
  const config = PANE_WIDTHS[pane];
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const subscribe = useCallback((changed: () => void) => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const mutations = new MutationObserver(changed);
    const sizes = new ResizeObserver(changed);
    const folds = new MutationObserver(() => connect());
    const connect = () => {
      mutations.disconnect();
      sizes.disconnect();
      folds.disconnect();
      if (desktop.matches && pane === "docs") folds.observe(document.documentElement, { attributes: true, attributeFilter: [DOCS_TREE_FOLDED_ATTRIBUTE] });
      if (paneShown(pane)) {
        mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
        const column = document.querySelector(config.selector);
        if (column) sizes.observe(column);
        const workspace = handle.current?.closest(".inbox-workspace");
        if (workspace) {
          sizes.observe(workspace);
          const thread = workspace.querySelector(".inbox-thread");
          if (thread) mutations.observe(thread, { attributes: true, attributeFilter: ["data-details"] });
          const details = workspace.querySelector(".inbox-details");
          if (details) sizes.observe(details);
        }
      }
      changed();
    };
    connect();
    desktop.addEventListener("change", connect);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
      folds.disconnect();
      desktop.removeEventListener("change", connect);
    };
  }, [config, pane]);
  const snapshot = useCallback(() => {
    // Hidden handles need no measurements or preference updates; reconnect when shown again.
    if (!paneShown(pane)) return `${config.default},${config.max}`;
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
      max = Math.max(config.min, Math.min(max, Math.floor(workspace.getBoundingClientRect().width - gap - detailsSpace - 480)));
    }
    const preferred = Number.parseFloat(document.documentElement.style.getPropertyValue(config.variable)) || config.default;
    return `${Math.min(max, preferred)},${max}`;
  }, [config, pane]);
  const [width, max] = useSyncExternalStore(subscribe, snapshot, () => `${config.default},${config.max}`).split(",").map(Number);

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
    const next = value === null ? null : Math.round(Math.min(max, Math.max(config.min, value)));
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
      aria-valuemax={max}
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
        const next = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: config.min, End: max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setWidth(next);
      }}
    >
      <span aria-hidden className="pointer-events-none h-8 w-0.5 rounded-full bg-border group-hover/resize:h-[calc(100%-16px)] group-hover/resize:bg-primary group-focus/resize:h-[calc(100%-16px)] group-focus/resize:bg-primary in-[:root[data-pane-resizing]]:h-[calc(100%-16px)] in-[:root[data-pane-resizing]]:bg-primary" />
    </div>
  );
}
