import type { ArchiveCompressionFormat } from "../types";
import { decodeBzip2 } from "./bzip2";
import { decodeGzip } from "./gzip";
import { decodePlain } from "./plain";
import type { StreamDecoder } from "./types";
import { decodeXz } from "./xz";
import { decodeZstd } from "./zstd";

export * from "./bzip2";
export * from "./gzip";
export * from "./plain";
export * from "./types";
export * from "./xz";
export * from "./zstd";

/**
 * Returns the stream decoder function for the specified compression format.
 */
export function getDecoder(format: ArchiveCompressionFormat): StreamDecoder {
  switch (format) {
    case "plain":
      return decodePlain;
    case "gzip":
      return decodeGzip;
    case "bzip2":
      return decodeBzip2;
    case "xz":
      return decodeXz;
    case "zstd":
      return decodeZstd;
  }
}
