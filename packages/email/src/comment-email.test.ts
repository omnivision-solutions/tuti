import { render } from "@react-email/render";
import { expect, test } from "vitest";

import { commentEmail } from "./comment-email";

const props = {
  projectName: "Acme",
  postTitle: "Slack notifications per board",
  voteCount: 23,
  status: "UNDER_REVIEW",
  comments: [{ authorId: "u-sam", authorName: "Sam Lee", text: "Same here! We'd want a separate channel for the Bugs board." }],
  postUrl: "https://acme.example.com/feedback/ideas/slack-notifications-per-board-12",
  unsubscribeUrl: "https://acme.example.com/unsubscribe?token=t",
};

test("one comment: who wrote it, the post with its votes and status, Reply and why they get it", async () => {
  const { subject, body } = commentEmail(props);
  expect(subject).toBe("New comment on “Slack notifications per board”");
  const text = await render(body, { plainText: true });
  for (const line of ["New comment on your idea", "Sam commented on your idea", "23", "Under review", "Sam Lee", "Same here!", "Reply", "You get this because you posted this idea.", "Unsubscribe from Acme"]) {
    expect(text).toContain(line);
  }
  const html = await render(body);
  expect(html).toContain(`href="${props.postUrl}"`);
  expect(html).toContain(`href="${props.unsubscribeUrl}"`);
});

test("several: named once each, the first five shown and the rest counted", async () => {
  const comments = ["Sam Lee", "Kim Park", "Sam Lee", "Jo Rivera", "Ada Park", "Lee Chen", "Max Moss"].map((authorName, i) => ({ authorId: `u-${authorName}`, authorName, text: `Comment ${i + 1}` }));
  const { subject, body } = commentEmail({ ...props, comments });
  expect(subject).toBe("New comments on “Slack notifications per board”");
  const text = await render(body, { plainText: true });
  expect(text).toContain("Sam and 5 others commented on your idea");
  expect(text).toContain("Comment 5");
  expect(text).not.toContain("Comment 6");
  expect(text).toContain("2 more comments on the post.");
  const two = await render(commentEmail({ ...props, comments: comments.slice(0, 2) }).body, { plainText: true });
  expect(two).toContain("Sam and Kim commented on your idea");
  // People are told apart by who they are, not their names: two who share a whole name are two, and one person's two
  // comments one.
  const sams = [
    { authorId: "u-1", authorName: "Sam Lee", text: "a" },
    { authorId: "u-2", authorName: "Sam Lee", text: "b" },
    { authorId: "u-1", authorName: "Sam Lee", text: "c" },
  ];
  expect(await render(commentEmail({ ...props, comments: sams }).body, { plainText: true })).toContain("Sam and Sam commented on your idea");
  expect(await render(commentEmail({ ...props, comments: [sams[0]!, sams[2]!] }).body, { plainText: true })).toContain("Sam commented on your idea");
});
