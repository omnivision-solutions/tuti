// @vitest-environment happy-dom
import { TRPCClientError } from "@trpc/client";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

// The reply box's calls (tRPC): a send its translation fails for, with the API's advice after why, as the server says it.
const trpc = vi.hoisted(() => ({
  conversations: {
    reply: { mutate: vi.fn() },
    // Never answers: the failed send's reason stays the preview.
    translateReply: { mutate: vi.fn(() => new Promise(() => {})) },
    upload: { mutate: vi.fn() },
    suggestReply: { mutate: vi.fn() },
    articles: { query: vi.fn() },
  },
  inbox: { language: { query: vi.fn(async () => ({ language: "de" })) } },
}));
vi.mock("@/components/trpc", () => ({
  useTRPCClient: () => trpc,
  errorMessage: (error: unknown, otherwise = "Something went wrong. Try again.") => (error instanceof TRPCClientError && error.shape ? error.message : otherwise),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const { ReplyForm } = await import("./reply-form");

test("a reply that couldn't be translated says why, without the API's advice to send it untranslated", async () => {
  trpc.conversations.reply.mutate.mockRejectedValueOnce(
    TRPCClientError.from({
      error: {
        code: -32603,
        message: "The translation provider didn't answer. Try again in a moment. Send it untranslated (untranslated: true), or try again.",
        data: { code: "translation_failed", httpStatus: 502 },
      },
    }),
  );
  const element = document.body.appendChild(document.createElement("div"));
  const root = createRoot(element);
  await act(async () =>
    root.render(h(ReplyForm, { projectSlug: "acme", number: 1, userId: "user-1", filesLastFor: 3_600_000, recipient: "Kai", translated: { language: "de", teamLanguage: "en" } })),
  );
  const box = element.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Anything else?");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => element.querySelector("form")!.requestSubmit());

  expect(trpc.conversations.reply.mutate).toHaveBeenCalledOnce();
  expect(element.textContent).toContain("The translation provider didn't answer. Try again in a moment.");
  expect(element.textContent).not.toContain("Send it untranslated");
  root.unmount();
});
