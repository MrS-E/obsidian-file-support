import { describe, expect, it } from "vitest";
import { createByteSource } from "../src/archives/byteSource";
import {
  ArchiveAbortError,
  ArchiveLimitError,
  type ArchiveLimits,
} from "../src/archives/types";

describe("ArchiveByteSource", () => {
  it("chunks Uint8Array into configured chunk sizes", async () => {
    const data = new Uint8Array(150 * 1024); // 150 KiB
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const limits: ArchiveLimits = {
      maxCompressedInputBytes: 10 * 1024 * 1024,
      maxDecodedBytes: 10 * 1024 * 1024,
      maxEntryCount: 100,
      maxEntryNameLength: 1000,
      maxMetadataBytes: 1000,
      maxPreviewBytes: 1000,
    };

    const chunks: Uint8Array[] = [];
    for await (const chunk of createByteSource(data, limits, undefined, 64 * 1024)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(3);
    expect(chunks[0].byteLength).toBe(64 * 1024);
    expect(chunks[1].byteLength).toBe(64 * 1024);
    expect(chunks[2].byteLength).toBe(22 * 1024);

    const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    expect(totalBytes).toBe(150 * 1024);
  });

  it("handles AsyncIterable stream chunking", async () => {
    async function* makeStream() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6]);
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of createByteSource(makeStream())) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(Array.from(chunks[0])).toEqual([1, 2, 3]);
    expect(Array.from(chunks[1])).toEqual([4, 5, 6]);
  });

  it("throws ArchiveLimitError when buffer exceeds maxCompressedInputBytes", async () => {
    const data = new Uint8Array(100);
    const limits: ArchiveLimits = {
      maxCompressedInputBytes: 50,
      maxDecodedBytes: 1000,
      maxEntryCount: 100,
      maxEntryNameLength: 1000,
      maxMetadataBytes: 1000,
      maxPreviewBytes: 1000,
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of createByteSource(data, limits)) {
        // no-op
      }
    }).rejects.toThrow(ArchiveLimitError);
  });

  it("throws ArchiveLimitError when stream exceeds maxCompressedInputBytes during reading", async () => {
    async function* makeLargeStream() {
      yield new Uint8Array(40);
      yield new Uint8Array(40);
    }

    const limits: ArchiveLimits = {
      maxCompressedInputBytes: 50,
      maxDecodedBytes: 1000,
      maxEntryCount: 100,
      maxEntryNameLength: 1000,
      maxMetadataBytes: 1000,
      maxPreviewBytes: 1000,
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of createByteSource(makeLargeStream(), limits)) {
        // no-op
      }
    }).rejects.toThrow(ArchiveLimitError);
  });

  it("cancels immediately when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of createByteSource(new Uint8Array(10), undefined, controller.signal)) {
        // no-op
      }
    }).rejects.toThrow(ArchiveAbortError);
  });

  it("cancels during iteration when AbortSignal fires", async () => {
    const controller = new AbortController();

    async function* makeStream() {
      yield new Uint8Array(10);
      controller.abort();
      yield new Uint8Array(10);
    }

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of createByteSource(makeStream(), undefined, controller.signal)) {
        // no-op
      }
    }).rejects.toThrow(ArchiveAbortError);
  });
});
