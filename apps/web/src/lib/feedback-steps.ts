/**
 * Where J (`by` 1) or K (-1) goes from the post open in Feedback's pane: the next or previous one in the list
 * (`order`, post numbers). Triaged out of the list (a new status), it goes on from where the post stood in the
 * list as it was (`before`, of the same list); past its last one, J opens one that came into the list since,
 * after where it stood (the next page's first, moved up). With none open, or one the list never had, J opens the first.
 */
export function feedbackStep(order: number[], before: number[], open: number | null, by: 1 | -1): number | null {
  if (open === null) {
    return by === 1 ? (order[0] ?? null) : null;
  }
  const list = order.includes(open) ? order : before;
  const at = list.indexOf(open);
  if (at === -1) {
    return by === 1 ? (order[0] ?? null) : null;
  }
  // The nearest one that's still in the list.
  for (let i = at + by; i >= 0 && i < list.length; i += by) {
    if (order.includes(list[i]!)) {
      return list[i]!;
    }
  }
  if (by === -1) {
    return null;
  }
  // Past the last: one that came into the list since, after where the post stood (the next page's first, moved
  // up), not one that arrived above it.
  let from = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (order.includes(list[i]!)) {
      from = order.indexOf(list[i]!) + 1;
      break;
    }
  }
  return order.slice(from).find((number) => !list.includes(number)) ?? null;
}

/** Whether two of Feedback's addresses are the same list: more of it loaded (`page`) is the same list. */
export function sameFeedbackList(a: string, b: string): boolean {
  const list = (address: string) => {
    const url = new URL(address, "http://list");
    url.searchParams.delete("page");
    url.searchParams.sort();
    return `${url.pathname}?${url.searchParams}`;
  };
  return list(a) === list(b);
}
