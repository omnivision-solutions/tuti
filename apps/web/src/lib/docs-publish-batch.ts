type PublishResult = { error?: string; code?: string };
const stopsBatch = new Set(["article_limit", "forbidden", "unauthorized"]);

/** Keep individual refusals out of retries; a project-wide refusal stops further requests. */
export async function publishBatch<T>(articles: T[], publish: (article: T) => Promise<PublishResult>) {
  const published: T[] = [];
  const failed: { article: T; error: string; code?: string }[] = [];
  for (const [index, article] of articles.entries()) {
    const result = await publish(article);
    if (!result.error) {
      published.push(article);
      continue;
    }
    failed.push({ article, error: result.error, code: result.code });
    if (stopsBatch.has(result.code ?? "")) {
      failed.push(...articles.slice(index + 1).map((remaining) => ({ article: remaining, error: `Not attempted: ${result.error}`, code: result.code })));
      break;
    }
  }
  return { published, failed };
}
