"use client";

import { type ReactNode, useState } from "react";

/** The hero's product window: a tab per part of Tuti, one picture showing at a time (the first before any script runs). */
export function HeroTabs({ panels }: { panels: { label: string; icon: ReactNode; url: string; picture: ReactNode }[] }) {
  const [open, setOpen] = useState(0);
  return (
    <div className="show">
      <div className="tabs">
        {panels.map((panel, i) => (
          <button key={panel.label} type="button" className="tab" aria-pressed={i === open} onClick={() => setOpen(i)}>
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
