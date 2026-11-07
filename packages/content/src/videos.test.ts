import { Editor } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { imageKeysIn, mediaIdsIn, parseDoc, toPlainText } from "./document";
import { toMarkdown } from "./markdown";
import { isFileContent, isVideoFile, mediaKeys, videoFormat, videoKey } from "./media";
import { extensions } from "./profiles";
import { RichText } from "./react";

const MEDIA_ID = "clx0abcdefghijklmnopqrstu";
const doc = (...content: object[]) => ({ type: "doc", content });
const video = (id: string = MEDIA_ID) => ({ type: "video", attrs: { provider: "upload", id } });
const signed = { [videoKey(MEDIA_ID)]: "https://storage.example/m/video?sig=1" };
const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part)] : part)));

describe("uploaded videos", () => {
  test("only articles have them", () => {
    const result = parseDoc("article", doc(video()));
    expect(result.ok && result.doc.content?.[0]).toEqual(video());
    for (const profile of ["comment", "post", "changelog"] as const) {
      expect(parseDoc(profile, doc(video()))).toMatchObject({ ok: false });
    }
  });

  test("need an upload's id", () => {
    expect(parseDoc("article", doc(video("../etc/passwd")))).toEqual({ ok: false, error: "Only YouTube, Vimeo and Loom videos can be embedded." });
  });

  test("are uploads to attach and keep, signed to play in place", () => {
    const content = doc(video(), { type: "paragraph" });
    expect(mediaIdsIn(content)).toEqual([MEDIA_ID]);
    expect(imageKeysIn(content)).toEqual([videoKey(MEDIA_ID)]);
    expect(mediaKeys({ id: MEDIA_ID, width: null })).toContain(videoKey(MEDIA_ID));
    expect(toPlainText(content)).toBe("");
  });

  test("render as the browser's own player, loading nothing until played; without a signed link they're left out", () => {
    const html = renderToStaticMarkup(createElement(RichText, { doc: doc(video()), mediaUrls: signed }));
    expect(html).toBe('<div><div class="rich-video"><video src="https://storage.example/m/video?sig=1" controls="" preload="metadata" playsInline=""></video></div></div>');
    expect(renderToStaticMarkup(createElement(RichText, { doc: doc(video()) }))).not.toContain("<video");
  });

  test("Markdown links the video's file; without one, nothing", () => {
    expect(toMarkdown(doc(video()), { mediaUrls: signed })).toBe("[Video](https://storage.example/m/video?sig=1)");
    expect(toMarkdown(doc(video()))).toBe("");
  });

  test("are MP4, WebM or MOV files, by name and by their first bytes", () => {
    expect(["demo.mp4", "Demo.MOV", "a.webm"].every(isVideoFile)).toBe(true);
    expect([null, "demo.pdf", "mp4"].some(isVideoFile)).toBe(false);
    const mp4 = bytes([0, 0, 0, 0x20], "ftypisom");
    expect(videoFormat(mp4)).toBe("mp4");
    expect(videoFormat(bytes([0, 0, 0, 0x14], "ftypqt  "))).toBe("mov");
    expect(videoFormat(bytes([0, 0, 0, 0x08], "moov"))).toBe("mov");
    expect(videoFormat(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(isFileContent("mp4", mp4)).toBe(true);
    // A web page or SVG named as a video isn't one.
    expect(isFileContent("mp4", bytes("<!doctype html><script>alert(1)</script>"))).toBe(false);
    expect(isFileContent("webm", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(false);
  });
});

test("a video goes in a step's body", () => {
  const steps = { type: "steps", content: [{ type: "step", content: [{ type: "stepTitle", content: [{ type: "text", text: "Watch" }] }, video()] }] };
  expect(parseDoc("article", doc(steps))).toMatchObject({ ok: true });
});

test("a video added while a block is picked (an upload finishing) goes after it, not in its place", () => {
  const image = { type: "image", attrs: { mediaId: "clx0imageimageimageimage1", width: "100", align: "center", alt: "", w: 10, h: 10 } };
  const editor = new Editor({ extensions: extensions("article"), content: doc(image, { type: "paragraph" }) });
  editor.commands.setNodeSelection(0);
  editor.commands.setVideo({ provider: "upload", id: MEDIA_ID });
  expect(editor.getJSON().content?.map((node) => node.type)).toEqual(["image", "video", "paragraph"]);
  editor.destroy();
});
