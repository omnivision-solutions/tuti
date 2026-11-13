"use client";

import { useRef, useState } from "react";

import { useFieldChanged } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { parseHex } from "@/lib/colors";

/**
 * A colour in a Customize form, sent as `name` (`#rrggbb`): the browser's swatch ("<label> picker") and
 * its hex beside it (`id`, for the field's label), kept in step; `#rgb` is expanded. A hex that isn't a
 * colour says so once the field is left and keeps the form from saving; the swatch keeps the last colour
 * that was one.
 */
export function ColorField({
  id,
  name,
  label,
  color,
  defaultColor,
  defaultLabel = "Use the default green",
  follows,
}: {
  id: string;
  name: string;
  label: string;
  color: string;
  defaultColor: string;
  /** The button that picks `defaultColor` again. */
  defaultLabel?: string;
  /**
   * For a default that can change (the accent, for the widget's launcher): whether the colour follows it, sent as
   * `<name>Follows` ("on"), since a colour of its own may be the same as the default. Picking the default follows it.
   */
  follows?: boolean;
}) {
  const [picked, setPicked] = useState(color);
  const [typed, setTyped] = useState(color);
  const [wrong, setWrong] = useState(false);
  const [following, setFollowing] = useState(follows);
  const swatch = useRef<HTMLInputElement>(null);
  const hex = useRef<HTMLInputElement>(null);
  useFieldChanged(swatch, `${picked} ${following}`);
  const choose = (value: string) => {
    setPicked(value);
    if (follows !== undefined) {
      setFollowing(value === defaultColor);
    }
  };
  const pick = (value: string) => {
    choose(value);
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
          aria-label={`${label} picker`}
          value={picked}
          onChange={(event) => pick(event.target.value)}
          className="h-9 w-14 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
        />
        <Input
          ref={hex}
          id={id}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            const hex = parseHex(event.target.value);
            if (hex) {
              choose(hex);
              setWrong(false);
            }
          }}
          onBlur={() => (parseHex(typed) ? setTyped(parseHex(typed)!) : setWrong(true))}
          // Required too: an empty field skips `pattern`, and would save the swatch's last colour.
          required
          pattern="\s*#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\s*"
          title="A hex colour, such as #2563eb"
          aria-invalid={wrong || undefined}
          aria-describedby={wrong ? `${id}-error` : undefined}
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          className="w-28 font-mono"
        />
        {follows !== undefined && <input type="hidden" name={`${name}Follows`} value={following ? "on" : ""} />}
        {(follows !== undefined ? !following : picked !== defaultColor) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              // The button goes once it's done: focus to the hex it set, not the page.
              hex.current?.focus();
              pick(defaultColor);
            }}
          >
            {defaultLabel}
          </Button>
        )}
      </div>
      {wrong && <FieldError id={`${id}-error`}>Type a hex colour, such as #2563eb.</FieldError>}
    </div>
  );
}
