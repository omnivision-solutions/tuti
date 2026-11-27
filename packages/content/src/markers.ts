// Where a marker starts, however it was written ("[check: …]", "[ Screenshot : …]").
export const MARKERS = { any: /\[\s*(?:check|screenshot)\s*:/gi, screenshot: /\[\s*screenshot\s*:/gi };

/**
 * Where the markers ("[Check: …]", "[Screenshot: …]": what a draft left for the team to fill in) are in a line of text,
 * as [start, end) offsets: each from its opening bracket to the one that closes it (brackets of its own inside counted),
 * or to the line's end if none does, since one left open is no less a note to self. Publishing refuses what this finds
 * (markersIn, @tuti/jobs), and the editor highlights the same.
 */
export function markerSpans(text: string, kind: keyof typeof MARKERS = "any"): [number, number][] {
  const found: [number, number][] = [];
  let covered = 0;
  for (const start of text.matchAll(MARKERS[kind])) {
    // Inside the one before it ("[Check: or [Check: this?]]"): that one names it.
    if (start.index < covered) {
      continue;
    }
    let depth = 0;
    covered = text.length;
    for (let i = start.index; i < text.length; i++) {
      depth += text[i] === "[" ? 1 : text[i] === "]" ? -1 : 0;
      if (depth === 0) {
        covered = i + 1;
        break;
      }
    }
    found.push([start.index, covered]);
  }
  return found;
}
