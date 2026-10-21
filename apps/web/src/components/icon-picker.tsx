"use client";

import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

const COLUMNS = 8;
/** Icons drawn at first, and added as the grid scrolls near its end. Each loads its own drawing once it's drawn. */
const BATCH = COLUMNS * 8;

/**
 * Lucide's icons in a grid, searched by name (the installed lucide-react has no tags). Its code
 * and the names come only when the picker opens (see IconField); each icon's drawing as it's drawn.
 * Arrow keys or Tab move through the icons, Enter picks one; Escape closes the picker.
 */
export default function IconPicker({ value, onPick }: { value: string | null; onPick: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(BATCH);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
    return iconNames.filter((name) => words.every((word) => name.includes(word)));
  }, [query]);

  useEffect(() => search.current?.focus(), []);

  const cells = () => [...(grid.current?.querySelectorAll("button") ?? [])];
  const onKeyDown = (event: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS } as Record<string, number>)[event.key];
    if (step === undefined) {
      return;
    }
    const all = cells();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    if (at + step < 0) {
      search.current?.focus();
    } else {
      all[Math.min(at + step, all.length - 1)]?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        ref={search}
        type="search"
        value={query}
        placeholder="Search icons"
        aria-label="Search icons"
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setShown(BATCH);
          grid.current?.scrollTo({ top: 0 });
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            cells()[0]?.focus();
          }
        }}
      />
      {matches.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">No icons match “{query.trim()}”</p>
      ) : (
        <div
          ref={grid}
          role="group"
          aria-label="Icons"
          className="grid max-h-60 grid-cols-8 gap-1 overflow-y-auto"
          onKeyDown={onKeyDown}
          onScroll={(event) => {
            const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
            if (scrollTop + clientHeight > scrollHeight - 80 && shown < matches.length) {
              setShown(shown + BATCH);
            }
          }}
        >
          {matches.slice(0, shown).map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name.replaceAll("-", " ")}
              title={name}
              aria-pressed={name === value}
              onClick={() => onPick(name)}
              className="flex size-9 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              <DynamicIcon name={name} aria-hidden className="size-5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
