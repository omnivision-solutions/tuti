"use client";

import { useRef, useState } from "react";

import { useFieldChanged } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { parseHex } from "@/lib/colors";

/**
 * A colour in a Customize form, sent as `name` (`#rrggbb`): the browser's swatch and its hex beside it
 * (`id`, for the field's label), kept in step; `#rgb` is expanded. A hex that isn't a colour says so once
 * the field is left and keeps the form from saving; the swatch keeps the last colour that was one.
 */
export function ColorField({ id, name, color, defaultColor }: { id: string; name: string; color: string; defaultColor: string }) {
  const [picked, setPicked] = useState(color);
  const [typed, setTyped] = useState(color);
  const [wrong, setWrong] = useState(false);
  const swatch = useRef<HTMLInputElement>(null);
  useFieldChanged(swatch, picked);
  const pick = (value: string) => {
    setPicked(value);
    setTyped(value);
    setWrong(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={swatch}
          name={name}
          type="color"
          aria-label="Colour picker"
          value={picked}
          onChange={(event) => pick(event.target.value)}
          className="h-9 w-14 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
        />
        <Input
          id={id}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            const hex = parseHex(event.target.value);
            if (hex) {
              setPicked(hex);
              setWrong(false);
            }
          }}
          onBlur={() => (parseHex(typed) ? setTyped(parseHex(typed)!) : setWrong(true))}
          pattern="\s*#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\s*"
          title="A hex colour, such as #2563eb"
          aria-invalid={wrong || undefined}
          aria-describedby={wrong ? `${id}-error` : undefined}
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          className="w-28 font-mono"
        />
        {picked !== defaultColor && (
          <Button type="button" variant="ghost" size="sm" onClick={() => pick(defaultColor)}>
            Use the default green
          </Button>
        )}
      </div>
      {wrong && <FieldError id={`${id}-error`}>Type a hex colour, such as #2563eb.</FieldError>}
    </div>
  );
}
