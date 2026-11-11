type PublishResult = { error?: string; code?: string };
type PublishFailure<T> = { article: T; error: string; code?: string };
const stopsBatch = new Set(["article_limit", "forbidden", "unauthorized", "unreachable"]);

/** Keep individual refusals out of retries; a project-wide refusal stops further requests. */
export async function publishBatch<T>(articles: T[], publish: (article: T) => Promise<PublishResult>) {
  const published: T[] = [];
  const failed: PublishFailure<T>[] = [];
  const unattempted: PublishFailure<T>[] = [];
  let stopped: PublishFailure<T> | null = null;
  for (const [index, article] of articles.entries()) {
    let result: PublishResult;
    try {
      result = await publish(article);
    } catch {
      result = { error: "Couldn't reach the server", code: "unreachable" };
    }
    if (!result.error) {
      published.push(article);
      continue;
    }
    if (stopsBatch.has(result.code ?? "")) {
      stopped = { article, error: result.error, code: result.code };
      unattempted.push(...articles.slice(index + 1).map((remaining) => ({ article: remaining, error: `Not attempted: ${result.error}`, code: result.code })));
      break;
    }
    failed.push({ article, error: result.error, code: result.code });
  }
  return { published, failed, unattempted, stopped };
}
