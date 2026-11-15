import {
  ArchiveAbortError,
  ArchiveLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveLimits,
} from "./types";

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB

/**
 * Mutable stats tracked during byte source consumption.
 */
export interface ByteSourceStats {
  totalBytesRead: number;
}

/**
 * Creates an AsyncIterable of bounded byte chunks from an ArrayBuffer, Uint8Array, or AsyncIterable<Uint8Array>.
 * Enforces maxCompressedInputBytes limit and abort signal cancellation.
 */
export async function* createByteSource(
  input: ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array>,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
  signal?: AbortSignal,
  chunkSize = DEFAULT_CHUNK_SIZE,
  stats?: ByteSourceStats
): AsyncIterable<Uint8Array> {
  let totalBytesRead = 0;

  if (signal?.aborted) {
    throw new ArchiveAbortError();
  }

  // Handle in-memory buffer inputs
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.byteLength > limits.maxCompressedInputBytes) {
      throw new ArchiveLimitError(
        `Compressed input size (${bytes.byteLength} bytes) exceeds limit of ${limits.maxCompressedInputBytes} bytes`,
        "EXCEEDED_INPUT_SIZE"
      );
    }

    let offset = 0;
    while (offset < bytes.byteLength) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }

      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      totalBytesRead += chunk.byteLength;
      if (stats) {
        stats.totalBytesRead = totalBytesRead;
      }
      offset = end;
      yield chunk;
    }
    return;
  }

  // Handle AsyncIterable input
  for await (const chunk of input) {
    if (signal?.aborted) {
      throw new ArchiveAbortError();
    }

    totalBytesRead += chunk.byteLength;
    if (stats) {
      stats.totalBytesRead = totalBytesRead;
    }
    if (totalBytesRead > limits.maxCompressedInputBytes) {
      throw new ArchiveLimitError(
        `Compressed input size (${totalBytesRead} bytes) exceeds limit of ${limits.maxCompressedInputBytes} bytes`,
        "EXCEEDED_INPUT_SIZE"
      );
    }

    yield chunk;
  }
}
