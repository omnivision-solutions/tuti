/**
 * Which of a view's overlapping loads to show, by the order they started: an answer shows unless a newer
 * one already has, so a later load that fails, or is still on its way, can't hide it; a failure shows only
 * from the latest load.
 */
export function loadOrder() {
  let started = 0;
  let shown = 0;
  return {
    /** A load starts: its number. */
    start: () => ++started,
    /** Whether load `id`'s answer (or, `answered` false, its failure) shows; an answer that does is the one shown. */
    shows(id: number, answered: boolean) {
      if (!answered) {
        return id === started;
      }
      if (id < shown) {
        return false;
      }
      shown = id;
      return true;
    },
  };
}

/**
 * Whose answer a request is: `now` says who's here (null when nobody, or the view is gone), read as it
 * starts; the returned check says whether that's still them, so an answer or failure for someone before
 * (a previous visitor's expired token) never touches who's here now.
 */
export function askedBy<T>(now: () => T | null): () => boolean {
  const asked = now();
  return () => asked !== null && now() === asked;
}
