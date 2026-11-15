import { Decompress } from "fzstd";
import {
  ArchiveAbortError,
  ArchiveError,
  ArchiveLimitError,
  ArchiveParseError,
  type ArchiveLimits,
} from "../types";
import type { StreamDecoder } from "./types";

/**
 * Incremental streaming Zstandard decoder using fzstd.
 */
export const decodeZstd: StreamDecoder = async function* (
  input: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  let totalDecodedBytes = 0;
  const outputQueue: Uint8Array[] = [];

  const decompressor = new Decompress((chunk, _isLast) => {
    if (chunk && chunk.byteLength > 0) {
      outputQueue.push(chunk);
    }
  });

  try {
    for await (const inputChunk of input) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }

      try {
        decompressor.push(inputChunk, false);
      } catch (err) {
        throw new ArchiveParseError(
          `Zstd decompression failed: ${err instanceof Error ? err.message : String(err)}`,
          "DECODER_ERROR"
        );
      }

      while (outputQueue.length > 0) {
        if (signal?.aborted) {
          throw new ArchiveAbortError();
        }
        const chunk = outputQueue.shift()!;
        totalDecodedBytes += chunk.byteLength;
        if (totalDecodedBytes > limits.maxDecodedBytes) {
          throw new ArchiveLimitError(
            `Decompressed archive size (${totalDecodedBytes} bytes) exceeds limit of ${limits.maxDecodedBytes} bytes`,
            "EXCEEDED_DECODED_SIZE"
          );
        }
        yield chunk;
      }
    }

    if (signal?.aborted) {
      throw new ArchiveAbortError();
    }

    // Flush end of stream
    try {
      decompressor.push(new Uint8Array(0), true);
    } catch (err) {
      throw new ArchiveParseError(
        `Zstd stream ended prematurely or corrupted: ${err instanceof Error ? err.message : String(err)}`,
        "DECODER_ERROR"
      );
    }

    while (outputQueue.length > 0) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }
      const chunk = outputQueue.shift()!;
      totalDecodedBytes += chunk.byteLength;
      if (totalDecodedBytes > limits.maxDecodedBytes) {
        throw new ArchiveLimitError(
          `Decompressed archive size (${totalDecodedBytes} bytes) exceeds limit of ${limits.maxDecodedBytes} bytes`,
          "EXCEEDED_DECODED_SIZE"
        );
      }
      yield chunk;
    }
  } catch (err) {
    if (err instanceof ArchiveError) {
      throw err;
    }
    throw new ArchiveParseError(
      `Zstd decompression error: ${err instanceof Error ? err.message : String(err)}`,
      "DECODER_ERROR"
    );
  }
};
