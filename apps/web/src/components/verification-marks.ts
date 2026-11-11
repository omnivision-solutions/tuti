import { matchingSentence, normalizeSentence as normalize, sentenceTokens } from "@/lib/docs-review";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type VerificationFinding = {
  statement: string;
  source?: string;
  verdict: "current" | "outdated" | "unclear";
};
const key = new PluginKey("verificationHighlights");

/** Match the checked words across formatting spans, without annotating a replacement claim. */
export function verificationRanges(doc: Node, findings: VerificationFinding[]) {
  const ranges: {
    from: number;
    to: number;
    number: number;
    verdict: "outdated" | "unclear";
  }[] = [];
  findings
    .filter((finding) => finding.verdict !== "current")
    .forEach((finding, index) => {
      const wanted = normalize(finding.source ?? finding.statement);
      if (!wanted) return;
      const blocks: { node: Node; pos: number }[] = [];
      doc.descendants((node, pos) => { if (node.isTextblock) blocks.push({ node, pos }); });
      const paraphrase = matchingSentence(finding.source ?? finding.statement, blocks.map(({ node }) => node.textContent));
      let found = false;
      doc.descendants((node, pos) => {
        if (!node.isTextblock || found) return;
        let source = "";
        const positions: number[] = [];
        node.descendants((child, offset) => {
          if (!child.isText) return;
          const value = child.text ?? "";
          source += value;
          for (let characterIndex = 0; characterIndex < value.length; characterIndex++) {
            positions.push(pos + 1 + offset + characterIndex);
          }
        });
        const tokens = sentenceTokens(source);
        const text = tokens.map(({ word }) => word).join(" ");
        const start = (` ${text} `).indexOf(` ${wanted} `);
        if (start < 0 && blocks[paraphrase]?.pos !== pos) return;
        const first = start < 0 ? 0 : text.slice(0, start).split(" ").filter(Boolean).length;
        const last = start < 0 ? tokens.length - 1 : first + wanted.split(" ").length - 1;
        if (!tokens[first] || !tokens[last]) return;
        const from = positions[tokens[first].from]!;
        const to = positions[tokens[last].to - 1]! + 1;
        ranges.push({
          from,
          to,
          number: index + 1,
          verdict: finding.verdict as "outdated" | "unclear",
        });
        found = true;
      });
    });
  return ranges;
}

/** Decorations stay out of saved JSON, and disappear as soon as the checked claim is edited. */
export function verificationPlugin(findings: VerificationFinding[]) {
  const decorate = (doc: Node) =>
    DecorationSet.create(
      doc,
      verificationRanges(doc, findings).flatMap((range) => [
        Decoration.inline(range.from, range.to, {
          "data-verdict": range.verdict,
          class:
            range.verdict === "outdated"
              ? "decoration-destructive underline decoration-1 underline-offset-4"
              : "decoration-muted-foreground underline decoration-dotted underline-offset-4",
        }),
        Decoration.widget(
          range.from,
          () => {
            const marker = document.createElement("span");
            const number = document.createElement("span");
            number.textContent = String(range.number);
            number.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.className = "sr-only";
            label.textContent = `Finding ${range.number}: ${range.verdict === "outdated" ? "out of date" : "can't tell"}`;
            marker.append(number, label);
            marker.dataset.finding = String(range.number);
            marker.className = `absolute -left-6 mt-1 inline-flex size-4 items-center justify-center rounded-sm text-xs font-semibold ${range.verdict === "outdated" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"}`;
            return marker;
          },
          { side: -1 },
        ),
      ]),
    );
  return new Plugin({
    key,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, previous) => (tr.docChanged ? decorate(tr.doc) : previous),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
