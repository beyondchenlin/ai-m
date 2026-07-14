import { describe, expect, it } from "vitest";
import { detectMimeType } from "../archiving/content-detection";
import { chunkText } from "../audio-chunking";

describe("speech first-class contract", () => {
  it("recognizes MP3 files with ID3 tags and frame-sync headers", () => {
    expect(detectMimeType(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]))).toBe("audio/mpeg");
    expect(detectMimeType(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]))).toBe("audio/mpeg");
  });

  it("never overlaps narration chunks", () => {
    const result = chunkText("第一句。第二句。第三句。", { maxTextLength: 5 });
    for (let index = 1; index < result.chunks.length; index++) {
      expect(result.chunks[index].startOffset).toBeGreaterThanOrEqual(result.chunks[index - 1].endOffset);
    }
  });
});
