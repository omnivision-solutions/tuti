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
