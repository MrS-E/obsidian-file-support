import { XzReadableStream } from "xz-decompress";
import {
  ArchiveAbortError,
  ArchiveError,
  ArchiveLimitError,
  ArchiveParseError,
  type ArchiveLimits,
} from "../types";
import type { StreamDecoder } from "./types";

/**
 * Incremental streaming XZ decoder using xz-decompress.
 */
export const decodeXz: StreamDecoder = async function* (
  input: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  let totalDecodedBytes = 0;
  const iterator = input[Symbol.asyncIterator]();

  const inputStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new ArchiveAbortError());
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      iterator.return?.();
    },
  });

  let xzStream: XzReadableStream;
  try {
    xzStream = new XzReadableStream(inputStream);
  } catch (err) {
    throw new ArchiveParseError(
      `Failed to initialize XZ stream: ${err instanceof Error ? err.message : String(err)}`,
      "DECODER_ERROR"
    );
  }

  const reader = xzStream.getReader();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value && value.byteLength > 0) {
        totalDecodedBytes += value.byteLength;
        if (totalDecodedBytes > limits.maxDecodedBytes) {
          throw new ArchiveLimitError(
            `Decompressed archive size (${totalDecodedBytes} bytes) exceeds limit of ${limits.maxDecodedBytes} bytes`,
            "EXCEEDED_DECODED_SIZE"
          );
        }
        yield value;
      }
    }
  } catch (err) {
    if (err instanceof ArchiveError) {
      throw err;
    }
    throw new ArchiveParseError(
      `XZ decompression error: ${err instanceof Error ? err.message : String(err)}`,
      "DECODER_ERROR"
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore release lock errors
    }
  }
};
