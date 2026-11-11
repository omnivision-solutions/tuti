"use client";

import { type ReactNode, type RefObject, useState } from "react";

import { SCROLLING_ROW, useScrollingRow } from "@tuti/ui/scrolling-row";

/** The hero's product window: a tab per part of Tuti, one picture showing at a time (the first before any script runs). */
export function HeroTabs({ panels }: { panels: { label: string; icon: ReactNode; url: string; picture: ReactNode }[] }) {
  const [open, setOpen] = useState(0);
  // Too narrow (a phone), the tabs scroll sideways, faded at the end with more, the open one in view (docs/design.md, Layout).
  const row = useScrollingRow(open, panels.length) as RefObject<HTMLDivElement | null>;
  return (
    <div className="show">
      <div ref={row} className={`tabs ${SCROLLING_ROW}`}>
        {panels.map((panel, i) => (
          <button key={panel.label} type="button" className="tab scroll-mx-12" aria-pressed={i === open} data-active={i === open || undefined} onClick={() => setOpen(i)}>
            {panel.icon}
            {panel.label}
          </button>
        ))}
      </div>
      <div className="stage">
        <div className="win">
          <div className="bar" aria-hidden>
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <div className="url">{panels[open].url}</div>
          </div>
          {panels.map((panel, i) => (
            <div key={panel.label} hidden={i !== open} className="panel-wrap">
              {panel.picture}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
