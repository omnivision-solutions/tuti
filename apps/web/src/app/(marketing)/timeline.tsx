"use client";

import { useEffect, useRef, type ReactNode } from "react";

/*
 * Plays a landing picture's steps on a loop. Children mark when they change, in seconds from the
 * start of the loop:
 *   data-in="2.6"        appears then (data-a: "up" by default, "fade" or "pop")
 *   data-out="3.2"       leaves then
 *   data-glow="4.6"      a soft green ring pulses once
 *   data-press="2.3"     pressed, as a click
 *   data-move="160,90,1,2.2"   glides from 160px right, 90px down to its place, between 1s and 2.2s
 *   data-count="0,128,6.4,1.4" its number counts from 0 to 128, starting at 6.4s for 1.4s
 * The whole picture fades in at the start and out at the end, so the loop joins cleanly. With
 * reduced motion it holds the finished picture, still.
 */

const EASE = "cubic-bezier(.22,.61,.36,1)";
const HIDDEN: Record<string, Keyframe> = {
  up: { opacity: 0, transform: "translateY(12px)" },
  fade: { opacity: 0, transform: "none" },
  pop: { opacity: 0, transform: "scale(.92)" },
};
const SHOWN: Keyframe = { opacity: 1, transform: "none" };
const ring = (percent: number, spread: number) => `0 0 0 ${spread}px color-mix(in oklch, var(--primary) ${percent}%, transparent)`;

export function Timeline({ seconds, className, children }: { seconds: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const total = seconds * 1000;
    // Where `s` seconds falls in the loop, 0–1.
    const at = (s: number) => Math.min(1, Math.max(0, (s * 1000) / total));
    const animations: Animation[] = [];
    const play = (el: Element, keyframes: Keyframe[]) => animations.push(el.animate(keyframes, { duration: total, iterations: Infinity, fill: "both" }));
    const all = (attribute: string) => [...root.querySelectorAll<HTMLElement>(`[${attribute}]`)];

    play(root, [{ opacity: 0 }, { opacity: 1, offset: at(0.65) }, { opacity: 1, offset: at(seconds - 0.7), easing: EASE }, { opacity: 0, offset: at(seconds - 0.25) }, { opacity: 0 }]);
    for (const el of all("data-in").concat(all("data-out").filter((el) => !el.dataset.in))) {
      const hidden = HIDDEN[el.dataset.a ?? "up"];
      const keyframes: Keyframe[] = [];
      if (el.dataset.in) {
        const t = Number(el.dataset.in);
        keyframes.push({ ...hidden, offset: 0 }, { ...hidden, offset: at(t), easing: EASE }, { ...SHOWN, offset: at(t + 0.65) });
      } else keyframes.push({ ...SHOWN, offset: 0 });
      if (el.dataset.out) {
        const t = Number(el.dataset.out);
        keyframes.push({ ...SHOWN, offset: at(t), easing: EASE }, { ...HIDDEN.fade, offset: at(t + 0.45) });
      }
      keyframes.push({ ...keyframes.at(-1), offset: 1 });
      play(el, keyframes);
    }
    for (const el of all("data-glow")) {
      const t = Number(el.dataset.glow) + 0.2;
      play(el, [{ boxShadow: ring(0, 0) }, { boxShadow: ring(0, 0), offset: at(t) }, { boxShadow: ring(25, 5), offset: at(t + 0.6) }, { boxShadow: ring(0, 10), offset: at(t + 1.8) }, { boxShadow: ring(0, 10) }]);
    }
    for (const el of all("data-press")) {
      const t = Number(el.dataset.press);
      play(el, [{ scale: 1 }, { scale: 1, offset: at(t) }, { scale: 0.94, offset: at(t + 0.15) }, { scale: 1, offset: at(t + 0.3) }, { scale: 1 }]);
    }
    for (const el of all("data-move")) {
      const [x, y, start, end] = el.dataset.move!.split(",").map(Number);
      const from = `${x}px ${y}px`;
      play(el, [{ translate: from }, { translate: from, offset: at(start), easing: "cubic-bezier(.65,0,.35,1)" }, { translate: "0px 0px", offset: at(end) }, { translate: "0px 0px" }]);
    }

    const counters = all("data-count").map((el) => ({ el, values: el.dataset.count!.split(",").map(Number) }));
    const count = (ms: number) => {
      for (const { el, values: [from, to, start, duration] } of counters) {
        const p = Math.min(1, Math.max(0, (ms / 1000 - start) / duration));
        el.textContent = String(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
      }
    };

    let frame = 0;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = total - 1500;
      }
      count(total);
    } else {
      const tick = () => {
        count(Number(animations[0].currentTime ?? 0) % total);
        frame = requestAnimationFrame(tick);
      };
      tick();
    }
    return () => {
      cancelAnimationFrame(frame);
      for (const animation of animations) animation.cancel();
    };
  }, [seconds]);

  // Hidden until its steps are set, so the stacked states never show at once.
  return (
    <div ref={ref} className={className} style={{ opacity: 0 }}>
      {children}
    </div>
  );
}
