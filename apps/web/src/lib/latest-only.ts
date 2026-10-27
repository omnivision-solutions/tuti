/**
 * Runs jobs one at a time, in the order they're asked for, and only the latest: a job asked for
 * before another starts is skipped, and one that finishes after another was asked for keeps its
 * result to itself. For exchanges whose side effects (cookies) must end up as the latest one left them.
 */
export function latestOnly() {
  let latest = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>, then: (result: T) => void) => {
    const mine = ++latest;
    queue = queue
      .then(async () => {
        if (mine !== latest) {
          return;
        }
        const result = await run();
        if (mine === latest) {
          then(result);
        }
      })
      .catch(() => {});
  };
}
