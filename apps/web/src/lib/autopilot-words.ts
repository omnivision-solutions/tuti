/** What an update is, as the review page names it. */
export function updateKind(update: { kind: string; problem?: string }): string {
  switch (update.kind) {
    case "resolves":
      return "Closes the request";
    case "moves_forward":
      return "Progress update";
    case "links":
      return "Link";
    case "article_edit":
      return update.problem === "missing" ? "Missing info" : "Out of date";
    case "new_article":
      return "New article";
    default:
      return "Changelog line";
  }
}
