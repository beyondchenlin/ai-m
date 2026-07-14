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

async function validateWav(reader: BoundedFileReader): Promise<boolean> {
  const riff = await reader.bytes(0, 12);
  if (!riff || riff.subarray(0, 4).toString("ascii") !== "RIFF"
    || riff.subarray(8, 12).toString("ascii") !== "WAVE"
    || riff.readUInt32LE(4) + 8 !== reader.size) return false;
  let offset = 12;
  let sawFormat = false;
  let sawData = false;
  let pcmBlockAlign: number | null = null;
  while (offset < reader.size) {
    const chunk = await reader.bytes(offset, 8);
    if (!chunk) return false;
    const type = chunk.subarray(0, 4).toString("ascii");
    const chunkSize = chunk.readUInt32LE(4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const paddedEnd = dataEnd + (chunkSize & 1);
    if (dataEnd > reader.size || paddedEnd > reader.size) return false;
    if (type === "fmt ") {
      if (sawFormat || chunkSize < 16) return false;
      const format = await reader.bytes(dataStart, Math.min(chunkSize, 40));
      if (!format || format.length < 16) return false;
      const formatTag = format.readUInt16LE(0);
      const channels = format.readUInt16LE(2);
      const sampleRate = format.readUInt32LE(4);
      const byteRate = format.readUInt32LE(8);
      const blockAlign = format.readUInt16LE(12);
      const bitsPerSample = format.readUInt16LE(14);
      if (formatTag === 0 || channels < 1 || channels > 64 || sampleRate < 1 || sampleRate > 768_000
        || byteRate < 1 || blockAlign < 1) return false;
      if (formatTag === 1 || formatTag === 3 || formatTag === 0xfffe) {
        if (bitsPerSample < 1 || bitsPerSample > 64 || byteRate !== sampleRate * blockAlign
          || blockAlign !== channels * Math.ceil(bitsPerSample / 8)
          || (formatTag === 0xfffe && chunkSize < 40)) return false;
        pcmBlockAlign = blockAlign;
      }
      sawFormat = true;
    } else if (type === "data") {
      if (!sawFormat || sawData || chunkSize === 0 || (pcmBlockAlign !== null && chunkSize % pcmBlockAlign !== 0)) {
        return false;
      }
      sawData = true;
    }
    offset = paddedEnd;
  }
  return offset === reader.size && sawFormat && sawData;
}

const MPEG1_BITRATES = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
} as const;
const MPEG2_BITRATES = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;

type Mp3Frame = Readonly<{
  length: number;
  versionBits: number;
  layerBits: 1 | 2 | 3;
  sampleRate: number;
  channelMode: number;
  crcBytes: number;
}>;

function parseMp3FrameHeader(header: number): Mp3Frame | null {
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) return null;
  const versionBits = (header >>> 19) & 0x03;
  const layerBits = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  const padding = (header >>> 9) & 1;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15
    || sampleRateIndex === 3 || (header & 0x03) === 2) return null;
  const typedLayer = layerBits as 1 | 2 | 3;
  const bitrateTable = versionBits === 3 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrate = bitrateTable[typedLayer][bitrateIndex] * 1_000;
  const rates = versionBits === 3 ? [44_100, 48_000, 32_000]
    : versionBits === 2 ? [22_050, 24_000, 16_000] : [11_025, 12_000, 8_000];
  const sampleRate = rates[sampleRateIndex];
  const length = typedLayer === 3
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((typedLayer === 1 && versionBits !== 3 ? 72 : 144) * bitrate) / sampleRate) + padding;
  if (!Number.isSafeInteger(length) || length < 4) return null;
  return {
    length, versionBits, layerBits: typedLayer, sampleRate,
    channelMode: (header >>> 6) & 0x03,
    crcBytes: (header & 0x00010000) === 0 ? 2 : 0,
  };
}

async function readSynchsafeSize(reader: BoundedFileReader, offset: number): Promise<number | null> {
  const bytes = await reader.bytes(offset, 4);
  if (!bytes || bytes.some((byte) => (byte & 0x80) !== 0)) return null;
  return ((bytes[0] << 21) | (bytes[1] << 14) | (bytes[2] << 7) | bytes[3]) >>> 0;
}

async function validateMp3(reader: BoundedFileReader): Promise<boolean> {
  // A stream with no length evidence that ends exactly on a valid frame boundary is a
  // complete shorter MP3. Original-object intent is provable only via expectedSizeBytes
  // or a matching Xing/Info/VBRI declaration.
  let audioStart = 0;
  const id3 = await reader.bytes(0, Math.min(10, reader.size));
  if (id3?.subarray(0, 3).toString("ascii") === "ID3") {
    if (id3.length < 10 || id3[3] === 0xff || id3[4] === 0xff) return false;
    const tagSize = await readSynchsafeSize(reader, 6);
    if (tagSize === null) return false;
    const footerSize = id3[3] === 4 && (id3[5] & 0x10) !== 0 ? 10 : 0;
    audioStart = 10 + tagSize + footerSize;
    if (audioStart > reader.size) return false;
  }
  let audioEnd = reader.size;
  if (reader.size - audioStart >= 128
    && (await reader.bytes(reader.size - 128, 3))?.toString("ascii") === "TAG") audioEnd -= 128;
  if (audioEnd - audioStart < 4) return false;

  let offset = audioStart;
  let frameCount = 0;
  let firstFrame: Mp3Frame | null = null;
  while (offset < audioEnd) {
    const headerBytes = await reader.bytes(offset, 4);
    if (!headerBytes) return false;
    const frame = parseMp3FrameHeader(headerBytes.readUInt32BE(0));
    if (!frame || offset + frame.length > audioEnd) return false;
    if (firstFrame && (frame.versionBits !== firstFrame.versionBits
      || frame.layerBits !== firstFrame.layerBits || frame.sampleRate !== firstFrame.sampleRate)) return false;
    firstFrame ??= frame;
    frameCount++;
    offset += frame.length;
  }
  if (!firstFrame || frameCount === 0 || offset !== audioEnd) return false;

  if (firstFrame.layerBits === 1) {
    const sideInfo = firstFrame.versionBits === 3
      ? (firstFrame.channelMode === 3 ? 17 : 32)
      : (firstFrame.channelMode === 3 ? 9 : 17);
    const xingOffset = audioStart + 4 + firstFrame.crcBytes + sideInfo;
    const xingTag = await reader.bytes(xingOffset, 4);
    if (xingTag && ["Xing", "Info"].includes(xingTag.toString("ascii"))) {
      const flagsBytes = await reader.bytes(xingOffset + 4, 4);
      if (!flagsBytes) return false;
      const flags = flagsBytes.readUInt32BE(0);
      let fieldOffset = xingOffset + 8;
      if ((flags & 1) !== 0) {
        const value = await reader.bytes(fieldOffset, 4);
        // The Xing/Info metadata frame is not included in its declared audio-frame count.
        if (!value || value.readUInt32BE(0) === 0 || value.readUInt32BE(0) !== frameCount - 1) return false;
        fieldOffset += 4;
      }
      if ((flags & 2) !== 0) {
        const value = await reader.bytes(fieldOffset, 4);
        if (!value || value.readUInt32BE(0) === 0 || value.readUInt32BE(0) !== audioEnd - audioStart) return false;
        fieldOffset += 4;
      }
      if ((flags & 4) !== 0) fieldOffset += 100;
      if ((flags & 8) !== 0) fieldOffset += 4;
      if (fieldOffset > audioStart + firstFrame.length) return false;
    }

    const vbriOffset = audioStart + 36;
    const vbriTag = await reader.bytes(vbriOffset, 4);
    if (vbriTag?.toString("ascii") === "VBRI") {
      const declaration = await reader.bytes(vbriOffset + 10, 8);
      if (!declaration || declaration.readUInt32BE(0) === 0 || declaration.readUInt32BE(4) === 0
        || declaration.readUInt32BE(0) !== audioEnd - audioStart
        || declaration.readUInt32BE(4) !== frameCount) return false;
    }
  }
  return true;
}

/** Structural completeness check shared by writer publication and recovery. */
export async function validateCompleteMediaFile(
  filePath: string,
  mimeType: string,
  sizeBytes: number,
): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== sizeBytes) return false;
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
    if (mimeType === "audio/wav") return await validateWav(reader);
    if (mimeType === "audio/mpeg") return await validateMp3(reader);
    return true;
  } finally {
    await handle.close();
  }
}
