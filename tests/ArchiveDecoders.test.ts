import { describe, expect, it } from "vitest";
import { createByteSource } from "../src/archives/byteSource";
import { getDecoder } from "../src/archives/decoders";
import {
  ArchiveAbortError,
  ArchiveLimitError,
  ArchiveParseError,
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveCompressionFormat,
  type ArchiveLimits,
} from "../src/archives/types";
import { compressData } from "./tarTestHelpers";

describe("ArchiveDecoders", () => {
  const sampleText = "The quick brown fox jumps over the lazy dog. ".repeat(100);
  const sampleBytes = new TextEncoder().encode(sampleText);
  const formats: ArchiveCompressionFormat[] = ["plain", "gzip", "bzip2", "xz", "zstd"];

  for (const format of formats) {
    describe(`Format: ${format}`, () => {
      it("correctly decompresses valid compressed stream", async () => {
        const compressed = compressData(sampleBytes, format);
        const decoder = getDecoder(format);
        const source = createByteSource(compressed, DEFAULT_ARCHIVE_LIMITS);
        const decompressed = decoder(source, DEFAULT_ARCHIVE_LIMITS);

        const chunks: Uint8Array[] = [];
        for await (const chunk of decompressed) {
          chunks.push(chunk);
        }

        const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        const result = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }

        expect(new TextDecoder("utf-8").decode(result)).toBe(sampleText);
      });

      it("enforces maxDecodedBytes limit", async () => {
        const compressed = compressData(sampleBytes, format);
        const decoder = getDecoder(format);
        const lowLimit: ArchiveLimits = {
          ...DEFAULT_ARCHIVE_LIMITS,
          maxDecodedBytes: 50, // lower than sampleText size (~4500 bytes)
        };
        const source = createByteSource(compressed, lowLimit);
        const decompressed = decoder(source, lowLimit);

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of decompressed) {
            // no-op
          }
        }).rejects.toThrow(ArchiveLimitError);
      });

      it("supports cancellation via AbortSignal", async () => {
        const compressed = compressData(sampleBytes, format);
        const decoder = getDecoder(format);
        const controller = new AbortController();
        controller.abort();

        const source = createByteSource(compressed, DEFAULT_ARCHIVE_LIMITS, controller.signal);
        const decompressed = decoder(source, DEFAULT_ARCHIVE_LIMITS, controller.signal);

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of decompressed) {
            // no-op
          }
        }).rejects.toThrow(ArchiveAbortError);
      });

      if (format !== "plain") {
        it("handles corrupt compressed stream by throwing ArchiveParseError", async () => {
          const compressed = compressData(sampleBytes, format);
          const corrupt = new Uint8Array(compressed);
          // Corrupt bytes in the middle of the compressed stream
          const mid = Math.floor(corrupt.length / 2);
          for (let i = mid; i < Math.min(mid + 10, corrupt.length); i++) {
            corrupt[i] = corrupt[i] ^ 0xff;
          }

          const decoder = getDecoder(format);
          const source = createByteSource(corrupt, DEFAULT_ARCHIVE_LIMITS);
          const decompressed = decoder(source, DEFAULT_ARCHIVE_LIMITS);

          await expect(async () => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _chunk of decompressed) {
              // no-op
            }
          }).rejects.toThrow(ArchiveParseError);
        });
      }
    });
  }
});
