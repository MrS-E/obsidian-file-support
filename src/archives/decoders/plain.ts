import {
  ArchiveAbortError,
  ArchiveLimitError,
  type ArchiveLimits,
} from "../types";
import type { StreamDecoder } from "./types";

/**
 * Pass-through decoder for uncompressed TAR streams.
 */
export const decodePlain: StreamDecoder = async function* (
  input: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  let totalDecodedBytes = 0;

  for await (const chunk of input) {
    if (signal?.aborted) {
      throw new ArchiveAbortError();
    }

    totalDecodedBytes += chunk.byteLength;
    if (totalDecodedBytes > limits.maxDecodedBytes) {
      throw new ArchiveLimitError(
        `Archive data size (${totalDecodedBytes} bytes) exceeds decoded limit of ${limits.maxDecodedBytes} bytes`,
        "EXCEEDED_DECODED_SIZE"
      );
    }

    yield chunk;
  }
};
