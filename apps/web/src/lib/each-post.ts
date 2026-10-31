/**
 * Does `run` to each post in turn, as on its own; returns what failed and why ("#12: …"). One failing, or its
 * call throwing (the network, the server), is that post's: the rest still go.
 */
export async function eachPost<P extends { number: number }>(posts: P[], run: (post: P) => Promise<{ error?: string }>): Promise<string[]> {
  const failed: string[] = [];
  for (const post of posts) {
    const result = await run(post).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
    if (result.error) {
      failed.push(`#${post.number}: ${result.error}`);
    }
  }
  return failed;
}
