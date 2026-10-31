/**
 * Where J (`by` 1) or K (-1) goes from the post open in Feedback's pane: the next or previous one in the list
 * (`order`, post numbers). Triaged out of the list (a new status), it goes on from where the post stood in the
 * list as it was (`before`, of the same list); past its last one, J opens one that came into the list since
 * (the next page's first, moved up). With none open, or one the list never had, J opens the first.
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
  return by === 1 ? (order.find((number) => !list.includes(number)) ?? null) : null;
}
