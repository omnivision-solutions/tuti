import { cn } from "@/lib/utils"

/**
 * An on/off switch: a native checkbox (so forms send it as "on", and its change events bubble) drawn
 * as a switch, with `role="switch"` for screen readers. Off: a light track outlined in `muted-foreground`, a grey thumb;
 * on: the green track, a white thumb. Each part reads at 3:1 or more, and off and on are apart by lightness too, not
 * only by hue (colours.test.ts).
 */
function Switch({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-input inset-ring inset-ring-muted-foreground transition-colors outline-none checked:bg-primary checked:inset-ring-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-muted-foreground before:shadow-sm before:transition-transform checked:before:translate-x-4 checked:before:bg-background",
        className
      )}
      {...props}
    />
  )
}

export { Switch }
