import type { ArchiveLimits } from "../types";

/**
 * Interface for streaming decompression adapters.
 */
export type StreamDecoder = (
  input: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  signal?: AbortSignal
) => AsyncIterable<Uint8Array>;
