/** An entry that may be new to someone (announced lately), and when it was published. */
export type Fresh = { number: number; at: string };

/** The later of two times seen up to (null: never). */
export function laterSeen(a: string | null, b: string | null): string | null {
  return !a || (b && new Date(b) > new Date(a)) ? b : a;
}

/** The fresh entries published after `seen`: unread to whoever has seen up to then (null: never). */
export function unreadNumbers(fresh: Fresh[], seen: string | null): number[] {
  return fresh.filter(({ at }) => !seen || new Date(at) > new Date(seen)).map(({ number }) => number);
}
