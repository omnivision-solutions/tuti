import { FAKE_OPENAI_KEY } from "@tuti/testkit";

/**
 * Makes the OpenAI fake treat two texts as this similar (cosine) when the app
 * embeds them: a post's title (without a body) or a title being typed.
 * Other texts stay unrelated to everything.
 */
export async function similar(a: string, b: string, similarity: number) {
  for (const [text, vector] of [
    [a, [1, 0]],
    [b, [similarity, Math.sqrt(1 - similarity ** 2)]],
  ] as const) {
    const response = await fetch(`${process.env.E2E_OPENAI_URL}/fixtures`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ text, vector }),
    });
    if (!response.ok) {
      throw new Error(`Couldn't set a vector for "${text}" (${response.status})`);
    }
  }
}
