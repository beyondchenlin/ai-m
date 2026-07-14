import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

class BoundedFileReader {
  private readonly buffer = Buffer.alloc(64 * 1024);
  private bufferStart = -1;
  private bufferLength = 0;

  constructor(private readonly handle: FileHandle, readonly size: number) {}

  async byte(offset: number): Promise<number | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size) return null;
    if (offset < this.bufferStart || offset >= this.bufferStart + this.bufferLength) {
      this.bufferStart = offset;
      this.bufferLength = (await this.handle.read(this.buffer, 0, this.buffer.length, offset)).bytesRead;
    }
    return this.buffer[offset - this.bufferStart] ?? null;
  }

  async bytes(offset: number, length: number): Promise<Buffer | null> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > this.size) return null;
    const result = Buffer.alloc(length);
    let cursor = 0;
    while (cursor < length) {
      const read = await this.handle.read(result, cursor, length - cursor, offset + cursor);
      if (read.bytesRead === 0) return null;
      cursor += read.bytesRead;
    }
    return result;
  }
}

async function validateJpeg(reader: BoundedFileReader): Promise<boolean> {
  if (reader.size < 4 || await reader.byte(0) !== 0xff || await reader.byte(1) !== 0xd8) return false;
  let offset = 2;
  let inScan = false;
  let sawScan = false;
  while (offset < reader.size) {
    if (await reader.byte(offset) !== 0xff) {
      if (!inScan) return false;
      offset++;
      continue;
    }
    while (offset < reader.size && await reader.byte(offset) === 0xff) offset++;
    const marker = await reader.byte(offset++);
    if (marker === null) return false;
    if (inScan && marker === 0x00) continue;
    if (marker === 0xd9) return sawScan;
    if (marker === 0xd8 || (!inScan && marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const lengthBytes = await reader.bytes(offset, 2);
    if (!lengthBytes) return false;
    const segmentLength = lengthBytes.readUInt16BE(0);
    if (segmentLength < 2 || offset + segmentLength > reader.size) return false;
    offset += segmentLength;
    inScan = marker === 0xda;
    if (inScan) sawScan = true;
  }
  return false;
}

async function validateWebp(reader: BoundedFileReader): Promise<boolean> {
  const header = await reader.bytes(0, 12);
  if (!header || header.subarray(0, 4).toString("ascii") !== "RIFF"
    || header.subarray(8, 12).toString("ascii") !== "WEBP"
    || header.readUInt32LE(4) + 8 !== reader.size) return false;
  let offset = 12;
  let sawImage = false;
  while (offset < reader.size) {
    const chunk = await reader.bytes(offset, 8);
    if (!chunk) return false;
    const type = chunk.subarray(0, 4).toString("ascii");
    const chunkSize = chunk.readUInt32LE(4);
    const paddedSize = chunkSize + (chunkSize & 1);
    if (offset + 8 + paddedSize > reader.size) return false;
    if (type === "VP8 " || type === "VP8L" || type === "ANMF") sawImage = true;
    offset += 8 + paddedSize;
  }
  return offset === reader.size && sawImage;
}

async function skipGifSubBlocks(reader: BoundedFileReader, start: number): Promise<number | null> {
  let offset = start;
  for (;;) {
    const size = await reader.byte(offset++);
    if (size === null) return null;
    if (size === 0) return offset;
    if (offset + size > reader.size) return null;
    offset += size;
  }
}

async function validateGif(reader: BoundedFileReader): Promise<boolean> {
  const header = await reader.bytes(0, 13);
  if (!header || !["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return false;
  let offset = 13;
  if ((header[10] & 0x80) !== 0) offset += 3 * (2 ** ((header[10] & 0x07) + 1));
  if (offset > reader.size) return false;
  let sawImage = false;
  while (offset < reader.size) {
    const introducer = await reader.byte(offset++);
    if (introducer === 0x3b) return sawImage && offset === reader.size;
    if (introducer === 0x21) {
      if (await reader.byte(offset++) === null) return false;
      const next = await skipGifSubBlocks(reader, offset);
      if (next === null) return false;
      offset = next;
      continue;
    }
    if (introducer !== 0x2c) return false;
    const descriptor = await reader.bytes(offset, 9);
    if (!descriptor) return false;
    offset += 9;
    if ((descriptor[8] & 0x80) !== 0) offset += 3 * (2 ** ((descriptor[8] & 0x07) + 1));
    const codeSize = await reader.byte(offset++);
    if (codeSize === null || codeSize === 0 || offset > reader.size) return false;
    const next = await skipGifSubBlocks(reader, offset);
    if (next === null) return false;
    offset = next;
    sawImage = true;
  }
  return false;
}

async function validateMp4(reader: BoundedFileReader): Promise<boolean> {
  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  let sawMdat = false;
  while (offset + 8 <= reader.size) {
    const box = await reader.bytes(offset, Math.min(16, reader.size - offset));
    if (!box || box.length < 8) return false;
    let boxSize = box.readUInt32BE(0);
    const type = box.subarray(4, 8).toString("ascii");
    let headerSize = 8;
    if (boxSize === 1) {
      if (box.length < 16) return false;
      const extended = box.readBigUInt64BE(8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(extended);
      headerSize = 16;
    } else if (boxSize === 0) boxSize = reader.size - offset;
    if (boxSize < headerSize || offset + boxSize > reader.size) return false;
    if (offset === 0 && (type !== "ftyp" || boxSize < 16)) return false;
    if (type === "ftyp") sawFtyp = true;
    if (type === "moov") sawMoov = true;
    if (type === "mdat") sawMdat = true;
    offset += boxSize;
  }
  return offset === reader.size && sawFtyp && sawMoov && sawMdat;
}

/** Structural completeness check shared by writer publication and recovery. */
export async function validateCompleteMediaFile(
  filePath: string,
  mimeType: string,
  sizeBytes: number,
): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    if (mimeType === "image/png") {
      if (sizeBytes < 20) return false;
      const tail = Buffer.alloc(12);
      await handle.read(tail, 0, tail.length, sizeBytes - tail.length);
      return tail.readUInt32BE(0) === 0 && tail.subarray(4, 8).toString("ascii") === "IEND";
    }
    const reader = new BoundedFileReader(handle, sizeBytes);
    if (mimeType === "image/jpeg") return await validateJpeg(reader);
    if (mimeType === "image/webp") return await validateWebp(reader);
    if (mimeType === "image/gif") return await validateGif(reader);
    if (mimeType === "video/mp4") return await validateMp4(reader);
    return true;
  } finally {
    await handle.close();
  }
}
