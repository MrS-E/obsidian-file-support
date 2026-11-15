import {
  ArchiveAbortError,
  ArchiveError,
  ArchiveLimitError,
  ArchiveParseError,
  type ArchiveLimits,
} from "../types";
import {
  createBitReader,
  decompressBzip2Block,
  readBzip2Header,
} from "./bzip2Core";
import type { StreamDecoder } from "./types";

const OUTPUT_CHUNK_SIZE = 64 * 1024; // 64 KiB

/**
 * Incremental streaming BZIP2 decoder.
 */
export const decodeBzip2: StreamDecoder = async function* (
  input: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of input) {
    if (signal?.aborted) {
      throw new ArchiveAbortError();
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new ArchiveParseError("Empty bzip2 stream", "DECODER_ERROR");
  }

  let chunkIdx = 0;
  const bitReader = createBitReader(() => {
    if (chunkIdx < chunks.length) {
      return chunks[chunkIdx++];
    }
    return null;
  });

  let totalDecodedBytes = 0;

  try {
    const blockSizeMultiplier = readBzip2Header(bitReader);
    const bufsize = 100_000 * blockSizeMultiplier;
    const buf = new Int32Array(bufsize);
    let streamCRC = 0;

    let outputBuffer = new Uint8Array(OUTPUT_CHUNK_SIZE);
    let outputPos = 0;

    const yieldBuffer = function* (): Generator<Uint8Array> {
      if (outputPos > 0) {
        const out = outputBuffer.subarray(0, outputPos);
        outputBuffer = new Uint8Array(OUTPUT_CHUNK_SIZE);
        outputPos = 0;
        yield out;
      }
    };

    while (true) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }

      const pendingChunks: Uint8Array[] = [];

      const onByte = (b: number) => {
        outputBuffer[outputPos++] = b;
        totalDecodedBytes++;

        if (totalDecodedBytes > limits.maxDecodedBytes) {
          throw new ArchiveLimitError(
            `Decompressed archive size (${totalDecodedBytes} bytes) exceeds limit of ${limits.maxDecodedBytes} bytes`,
            "EXCEEDED_DECODED_SIZE"
          );
        }

        if (outputPos >= OUTPUT_CHUNK_SIZE) {
          pendingChunks.push(outputBuffer.slice(0, outputPos));
          outputPos = 0;
        }
      };

      const newStreamCRC = decompressBzip2Block(bitReader, onByte, buf, bufsize, streamCRC);

      for (const pChunk of pendingChunks) {
        if (signal?.aborted) {
          throw new ArchiveAbortError();
        }
        yield pChunk;
      }

      if (newStreamCRC === null) {
        // End of stream reached
        break;
      }
      streamCRC = newStreamCRC;
    }

    for (const finalChunk of yieldBuffer()) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }
      yield finalChunk;
    }
  } catch (err) {
    if (err instanceof ArchiveError) {
      throw err;
    }
    throw new ArchiveParseError(
      `Bzip2 decompression error: ${err instanceof Error ? err.message : String(err)}`,
      "DECODER_ERROR"
    );
  }
};
