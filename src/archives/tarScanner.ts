import { createByteSource, type ByteSourceStats } from "./byteSource";
import { getDecoder } from "./decoders";
import {
  ArchiveAbortError,
  ArchiveError,
  ArchiveLimitError,
  ArchiveParseError,
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveCompressionFormat,
  type ArchiveEntry,
  type ArchiveEntryType,
  type ArchiveLimits,
  type ArchiveScanResult,
  type PreviewArchiveOptions,
  type PreviewExtractionResult,
  type ScanArchiveOptions,
} from "./types";

const TAR_BLOCK_SIZE = 512;
const UTF8_DECODER = new TextDecoder("utf-8");
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Controller for cooperative UI yielding based on elapsed time, decoded bytes, and entry count.
 */
export class YieldController {
  private lastYieldTime = Date.now();
  private lastYieldBytes = 0;
  private entriesSinceYield = 0;

  constructor(private onYield?: () => Promise<void> | void) {}

  async check(totalBytesRead: number, isEntry = false): Promise<void> {
    if (!this.onYield) return;
    if (isEntry) {
      this.entriesSinceYield++;
    }
    const now = Date.now();
    const bytesSince = totalBytesRead - this.lastYieldBytes;
    if (now - this.lastYieldTime >= 16 || bytesSince >= 1024 * 1024 || this.entriesSinceYield >= 200) {
      await this.onYield();
      this.lastYieldTime = Date.now();
      this.lastYieldBytes = totalBytesRead;
      this.entriesSinceYield = 0;
    }
  }
}

/**
 * Helper class for reading exact byte counts and skipping data across an AsyncIterable<Uint8Array>.
 */
export class ChunkReader {
  private chunks: Uint8Array[] = [];
  private currentChunkOffset = 0;
  private iterator: AsyncIterator<Uint8Array>;
  private isDone = false;
  public totalBytesRead = 0;

  constructor(
    stream: AsyncIterable<Uint8Array>,
    private limits: ArchiveLimits,
    private signal?: AbortSignal,
    private yieldController?: YieldController
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /**
   * Reads exactly `count` bytes from the stream.
   * If the stream ends before `count` bytes can be read, returns whatever was read (length < count).
   */
  async readExact(count: number): Promise<Uint8Array> {
    if (this.signal?.aborted) {
      throw new ArchiveAbortError();
    }
    if (count === 0) {
      return new Uint8Array(0);
    }

    const result = new Uint8Array(count);
    let offset = 0;

    while (offset < count) {
      if (this.chunks.length === 0) {
        if (this.isDone) {
          break;
        }
        const next = await this.iterator.next();
        if (next.done) {
          this.isDone = true;
          break;
        }
        if (next.value && next.value.byteLength > 0) {
          this.chunks.push(next.value);
        }
        continue;
      }

      const chunk = this.chunks[0];
      const available = chunk.byteLength - this.currentChunkOffset;
      const needed = count - offset;
      const toCopy = Math.min(available, needed);

      result.set(
        chunk.subarray(this.currentChunkOffset, this.currentChunkOffset + toCopy),
        offset
      );

      offset += toCopy;
      this.currentChunkOffset += toCopy;
      this.totalBytesRead += toCopy;

      if (this.currentChunkOffset >= chunk.byteLength) {
        this.chunks.shift();
        this.currentChunkOffset = 0;
      }

      await this.yieldController?.check(this.totalBytesRead);
    }

    if (offset === count) {
      return result;
    }
    return result.subarray(0, offset);
  }

  /**
   * Skips `count` bytes in the stream without retaining buffer memory.
   */
  async skip(count: number): Promise<void> {
    if (this.signal?.aborted) {
      throw new ArchiveAbortError();
    }
    let remaining = count;

    while (remaining > 0) {
      if (this.chunks.length === 0) {
        if (this.isDone) {
          break;
        }
        const next = await this.iterator.next();
        if (next.done) {
          this.isDone = true;
          break;
        }
        if (next.value && next.value.byteLength > 0) {
          this.chunks.push(next.value);
        }
        continue;
      }

      const chunk = this.chunks[0];
      const available = chunk.byteLength - this.currentChunkOffset;
      const toSkip = Math.min(available, remaining);

      this.currentChunkOffset += toSkip;
      remaining -= toSkip;
      this.totalBytesRead += toSkip;

      if (this.currentChunkOffset >= chunk.byteLength) {
        this.chunks.shift();
        this.currentChunkOffset = 0;
      }

      await this.yieldController?.check(this.totalBytesRead);
    }

    if (remaining > 0) {
      throw new ArchiveParseError("Truncated archive payload", "TRUNCATED_ARCHIVE");
    }
  }

  /**
   * Drains any remaining bytes in the decoder stream to trigger trailer verification and checksums.
   */
  async drain(maxBytes?: number): Promise<void> {
    const limit = maxBytes ?? this.limits.maxDecodedBytes;
    while (!this.isDone) {
      if (this.signal?.aborted) {
        throw new ArchiveAbortError();
      }
      const next = await this.iterator.next();
      if (next.done) {
        this.isDone = true;
        break;
      }
      if (next.value && next.value.byteLength > 0) {
        this.totalBytesRead += next.value.byteLength;
        if (this.totalBytesRead > limit) {
          throw new ArchiveLimitError(
            `Archive data size (${this.totalBytesRead} bytes) exceeds decoded limit of ${limit} bytes`,
            "EXCEEDED_DECODED_SIZE"
          );
        }
        await this.yieldController?.check(this.totalBytesRead);
      }
    }
  }

  /**
   * Closes the reader and underlying stream iterator.
   */
  async close(): Promise<void> {
    this.isDone = true;
    try {
      await this.iterator.return?.();
    } catch {
      // Ignore errors on close
    }
  }
}

/**
 * Reads a null-terminated string from header buffer.
 */
function readNullTerminatedString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) {
    end++;
  }
  return UTF8_DECODER.decode(bytes.subarray(offset, end)).trim();
}

/**
 * Reads a strict octal integer from header buffer.
 * Rejects invalid octal characters or trailing non-space/null garbage.
 */
export function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  let start = offset;
  const end = offset + length;

  // Skip leading nulls and spaces
  while (start < end && (bytes[start] === 0 || bytes[start] === 0x20)) {
    start++;
  }

  // If entire field is empty (spaces or nulls)
  if (start >= end) {
    return 0;
  }

  let val = 0;
  while (start < end) {
    const b = bytes[start];
    // Trailing null or space terminates the number
    if (b === 0 || b === 0x20) {
      // Ensure remaining bytes are only nulls or spaces
      for (let i = start + 1; i < end; i++) {
        if (bytes[i] !== 0 && bytes[i] !== 0x20) {
          throw new ArchiveParseError("Malformed octal field with trailing garbage", "INVALID_HEADER");
        }
      }
      break;
    }
    // Check for valid octal ASCII digit '0' (0x30) .. '7' (0x37)
    if (b < 0x30 || b > 0x37) {
      throw new ArchiveParseError(`Invalid character in octal field: 0x${b.toString(16)}`, "INVALID_HEADER");
    }
    val = val * 8 + (b - 0x30);
    if (!Number.isSafeInteger(val)) {
      throw new ArchiveParseError("Octal field exceeds safe integer limit", "INVALID_HEADER");
    }
    start++;
  }

  return val;
}

/**
 * Reads size field from header buffer (supporting standard octal and GNU 12-byte base-256 binary).
 */
export function readSize(bytes: Uint8Array, offset: number, length: number): number {
  // Check GNU base-256 format (high bit 0x80 set)
  if ((bytes[offset] & 0x80) !== 0) {
    // If negative binary 2's complement (0xff)
    if ((bytes[offset] & 0x40) !== 0 || bytes[offset] === 0xff) {
      throw new ArchiveParseError("Invalid negative base-256 size in header", "INVALID_HEADER");
    }
    let size = bytes[offset] & 0x3f;
    for (let i = offset + 1; i < offset + length; i++) {
      size = size * 256 + bytes[i];
      if (!Number.isSafeInteger(size)) {
        throw new ArchiveParseError("Base-256 size exceeds safe integer limit", "INVALID_HEADER");
      }
    }
    return size;
  }
  return readOctal(bytes, offset, length);
}

/**
 * Calculates unsigned and signed checksums of a 512-byte TAR header block.
 */
function calculateHeaderChecksums(header: Uint8Array): { unsignedSum: number; signedSum: number } {
  let unsignedSum = 0;
  let signedSum = 0;

  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    // Treat bytes 148..155 (checksum field) as 8 ASCII space characters (0x20)
    const val = i >= 148 && i < 156 ? 0x20 : header[i];
    unsignedSum += val;
    signedSum += (val << 24) >> 24; // cast to signed 8-bit int
  }

  return { unsignedSum, signedSum };
}

/**
 * Checks if a 512-byte block is all zeros.
 */
function isZeroBlock(header: Uint8Array): boolean {
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== 0) return false;
  }
  return true;
}

/**
 * Parses PAX extended header records.
 */
export function parsePaxHeaders(
  payload: Uint8Array,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS
): Record<string, string> {
  if (payload.byteLength > limits.maxMetadataBytes) {
    throw new ArchiveLimitError(
      `PAX metadata size (${payload.byteLength} bytes) exceeds limit of ${limits.maxMetadataBytes} bytes`,
      "EXCEEDED_METADATA_SIZE"
    );
  }

  const text = UTF8_DECODER.decode(payload);
  const result: Record<string, string> = {};
  let pos = 0;
  let recordCount = 0;
  const MAX_PAX_RECORDS = 1000;

  while (pos < text.length) {
    if (recordCount++ >= MAX_PAX_RECORDS) {
      break;
    }

    const spaceIdx = text.indexOf(" ", pos);
    if (spaceIdx === -1) break;

    const lengthStr = text.slice(pos, spaceIdx);
    const length = parseInt(lengthStr, 10);
    if (isNaN(length) || length <= 0 || pos + length > text.length) {
      break;
    }

    const lineEnd = pos + length;
    let record = text.slice(spaceIdx + 1, lineEnd);
    if (record.endsWith("\n")) {
      record = record.slice(0, -1);
    }

    const eqIdx = record.indexOf("=");
    if (eqIdx !== -1) {
      const key = record.slice(0, eqIdx).trim();
      const value = record.slice(eqIdx + 1);
      if (key.length > 0 && key.length <= 256) {
        result[key] = value;
      }
    }

    pos = lineEnd;
  }

  return result;
}

/**
 * Checks whether a raw path contains directory traversal, drive letters, or absolute paths.
 */
export function isPathUnsafe(rawPath: string): boolean {
  if (!rawPath) return false;
  if (/[\x00-\x1f]/.test(rawPath)) return true;
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(rawPath)) return true;
  const normalizedSlashes = rawPath.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/");
  for (const seg of segments) {
    if (seg === "..") return true;
  }
  return false;
}

/**
 * Sanitizes and normalizes an entry path inside the archive to prevent directory traversal.
 */
export function sanitizeArchivePath(rawPath: string, maxNameLength: number): string {
  if (!rawPath) return "_";

  // Replace backslashes with forward slashes
  let path = rawPath.replace(/\\/g, "/");

  // Remove leading slashes and drive letters
  path = path.replace(/^[a-zA-Z]:/, "");
  path = path.replace(/^[\/\\]+/, "");

  // Normalize path segments (remove '.' and resolve '..')
  const segments = path.split("/").filter((s) => s.length > 0 && s !== ".");
  const safeSegments: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      // Prevent escaping archive root
      if (safeSegments.length > 0) {
        safeSegments.pop();
      }
    } else {
      safeSegments.push(segment);
    }
  }

  let normalized = safeSegments.join("/");
  if (!normalized) {
    normalized = "_";
  }

  // Preserve trailing slash if original was a directory
  if ((rawPath.endsWith("/") || rawPath.endsWith("\\")) && !normalized.endsWith("/")) {
    normalized += "/";
  }

  if (normalized.length > maxNameLength) {
    throw new ArchiveLimitError(
      `Archive entry name length (${normalized.length}) exceeds limit of ${maxNameLength}`,
      "EXCEEDED_NAME_LENGTH"
    );
  }

  return normalized;
}

/**
 * Maps TAR typeflag character to ArchiveEntryType.
 */
function mapEntryType(typeflag: string, path: string): ArchiveEntryType {
  switch (typeflag) {
    case "0":
    case "\0":
    case "":
      return path.endsWith("/") ? "directory" : "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "3":
      return "character-device";
    case "4":
      return "block-device";
    case "5":
      return "directory";
    case "6":
      return "fifo";
    case "7":
      return "contiguous-file";
    default:
      return "unsupported";
  }
}

/**
 * Checks whether a buffer appears to contain binary data (contains null bytes in first 8000 bytes or invalid UTF-8).
 */
export function isBinaryData(buffer: Uint8Array): boolean {
  const checkLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  try {
    FATAL_UTF8_DECODER.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/**
 * Item yielded by the TAR entry stream.
 */
export interface TarEntryStreamItem {
  entry: ArchiveEntry;
  effectiveSize: number;
  paddedPayloadSize: number;
  readPayload: (maxBytes?: number) => Promise<Uint8Array>;
  skipPayload: () => Promise<void>;
}

export interface TarScanTracker {
  totalDecodedBytes: number;
  totalCompressedBytes: number;
  isComplete: boolean;
}

/**
 * Single unified async generator for traversing TAR entries in plain or compressed streams.
 */
export async function* iterateTarEntries(
  input: ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array>,
  format: ArchiveCompressionFormat,
  options: ScanArchiveOptions = {},
  tracker?: TarScanTracker
): AsyncGenerator<TarEntryStreamItem, void, undefined> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const signal = options.signal;
  const onYield = options.onYield;

  const byteStats: ByteSourceStats = { totalBytesRead: 0 };
  const byteSource = createByteSource(input, limits, signal, undefined, byteStats);
  const decoder = getDecoder(format);
  const decompressedStream = decoder(byteSource, limits, signal);
  const reader = new ChunkReader(decompressedStream, limits, signal);

  let pendingGnuName: string | null = null;
  let pendingGnuLink: string | null = null;
  let pendingPax: Record<string, string> | null = null;
  let globalPax: Record<string, string> = {};

  let ordinal = 0;
  let zeroBlockCount = 0;
  let sawEndOfArchive = false;

  let lastYieldTime = Date.now();
  let lastYieldBytes = 0;
  let entriesSinceYield = 0;

  async function checkCooperativeYield(): Promise<void> {
    if (!onYield) return;
    const now = Date.now();
    const bytesSince = reader.totalBytesRead - lastYieldBytes;
    if (now - lastYieldTime >= 16 || bytesSince >= 1024 * 1024 || entriesSinceYield >= 200) {
      await onYield();
      lastYieldTime = Date.now();
      lastYieldBytes = reader.totalBytesRead;
      entriesSinceYield = 0;
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw new ArchiveAbortError();
      }

      await checkCooperativeYield();

      const header = await reader.readExact(TAR_BLOCK_SIZE);
      if (header.byteLength === 0) {
        if (!sawEndOfArchive && zeroBlockCount < 2) {
          throw new ArchiveParseError(
            "Archive ended prematurely without end-of-archive marker",
            "TRUNCATED_ARCHIVE"
          );
        }
        break;
      }

      if (header.byteLength < TAR_BLOCK_SIZE) {
        throw new ArchiveParseError("Truncated archive header", "TRUNCATED_ARCHIVE");
      }

      if (isZeroBlock(header)) {
        zeroBlockCount++;
        if (zeroBlockCount >= 2) {
          sawEndOfArchive = true;
          // Drain the remaining stream to verify trailer integrity and checksums
          await reader.drain();
          if (tracker) {
            tracker.isComplete = true;
          }
          break;
        }
        continue;
      }
      zeroBlockCount = 0;

      // Verify checksum
      const { unsignedSum, signedSum } = calculateHeaderChecksums(header);
      const checksumField = readNullTerminatedString(header, 148, 8);
      const storedChecksum = readOctal(header, 148, 8);

      if (storedChecksum !== unsignedSum && storedChecksum !== signedSum) {
        throw new ArchiveParseError("Invalid TAR header checksum", "BAD_CHECKSUM");
      }

      // Read header fields
      const name = readNullTerminatedString(header, 0, 100);
      const mode = readOctal(header, 100, 8);
      const uid = readOctal(header, 108, 8);
      const gid = readOctal(header, 116, 8);
      const size = readSize(header, 124, 12);
      const mtime = readOctal(header, 136, 12);
      const typeflag = String.fromCharCode(header[156]);
      const linkname = readNullTerminatedString(header, 157, 100);
      const magic = readNullTerminatedString(header, 257, 6);
      const uname = readNullTerminatedString(header, 265, 32);
      const gname = readNullTerminatedString(header, 297, 32);
      const prefix = readNullTerminatedString(header, 345, 155);

      const headerPaddedPayloadSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

      // Handle GNU Long Name
      if (typeflag === "L") {
        if (size > limits.maxMetadataBytes) {
          throw new ArchiveLimitError(
            `GNU long name size (${size} bytes) exceeds metadata limit of ${limits.maxMetadataBytes} bytes`,
            "EXCEEDED_METADATA_SIZE"
          );
        }
        const payload = await reader.readExact(size);
        if (payload.byteLength < size) {
          throw new ArchiveParseError("Truncated GNU long name payload", "TRUNCATED_ARCHIVE");
        }
        await reader.skip(headerPaddedPayloadSize - size);
        pendingGnuName = UTF8_DECODER.decode(payload).replace(/\0+$/, "");
        continue;
      }

      // Handle GNU Long Link
      if (typeflag === "K") {
        if (size > limits.maxMetadataBytes) {
          throw new ArchiveLimitError(
            `GNU long link size (${size} bytes) exceeds metadata limit of ${limits.maxMetadataBytes} bytes`,
            "EXCEEDED_METADATA_SIZE"
          );
        }
        const payload = await reader.readExact(size);
        if (payload.byteLength < size) {
          throw new ArchiveParseError("Truncated GNU long link payload", "TRUNCATED_ARCHIVE");
        }
        await reader.skip(headerPaddedPayloadSize - size);
        pendingGnuLink = UTF8_DECODER.decode(payload).replace(/\0+$/, "");
        continue;
      }

      // Handle PAX extended header
      if (typeflag === "x") {
        if (size > limits.maxMetadataBytes) {
          throw new ArchiveLimitError(
            `PAX header size (${size} bytes) exceeds metadata limit of ${limits.maxMetadataBytes} bytes`,
            "EXCEEDED_METADATA_SIZE"
          );
        }
        const payload = await reader.readExact(size);
        if (payload.byteLength < size) {
          throw new ArchiveParseError("Truncated PAX header payload", "TRUNCATED_ARCHIVE");
        }
        await reader.skip(headerPaddedPayloadSize - size);
        pendingPax = parsePaxHeaders(payload, limits);
        continue;
      }

      // Handle PAX global extended header
      if (typeflag === "g") {
        if (size > limits.maxMetadataBytes) {
          throw new ArchiveLimitError(
            `PAX global header size (${size} bytes) exceeds metadata limit of ${limits.maxMetadataBytes} bytes`,
            "EXCEEDED_METADATA_SIZE"
          );
        }
        const payload = await reader.readExact(size);
        if (payload.byteLength < size) {
          throw new ArchiveParseError("Truncated PAX global header payload", "TRUNCATED_ARCHIVE");
        }
        await reader.skip(headerPaddedPayloadSize - size);
        const parsedGlobal = parsePaxHeaders(payload, limits);
        // Merge into globalPax up to limit; do not copy path/linkpath into globalPax
        delete parsedGlobal.path;
        delete parsedGlobal.linkpath;
        if (Object.keys(globalPax).length + Object.keys(parsedGlobal).length <= 1000) {
          globalPax = { ...globalPax, ...parsedGlobal };
        }
        continue;
      }

      // Handle Volume Header
      if (typeflag === "V") {
        await reader.skip(headerPaddedPayloadSize);
        continue;
      }

      // Standard entry
      let rawPath = name;
      if (magic.startsWith("ustar") && prefix.length > 0) {
        rawPath = `${prefix}/${name}`;
      }

      const finalPath = pendingPax?.path ?? pendingGnuName ?? rawPath;
      const finalLink = pendingPax?.linkpath ?? pendingGnuLink ?? linkname;

      // Validate PAX numeric fields
      let effectiveSize = size;
      if (pendingPax?.size !== undefined) {
        const parsedSize = parseInt(pendingPax.size, 10);
        if (isNaN(parsedSize) || !Number.isSafeInteger(parsedSize) || parsedSize < 0) {
          throw new ArchiveParseError("Invalid PAX size record", "MALFORMED_ARCHIVE");
        }
        effectiveSize = parsedSize;
      }

      let finalMtime = mtime ? mtime * 1000 : undefined;
      if (pendingPax?.mtime !== undefined) {
        const parsedMtime = parseFloat(pendingPax.mtime);
        if (!isNaN(parsedMtime) && isFinite(parsedMtime) && parsedMtime >= 0) {
          finalMtime = Math.round(parsedMtime * 1000);
        }
      }

      let finalUid = uid || undefined;
      if (pendingPax?.uid !== undefined) {
        const parsedUid = parseInt(pendingPax.uid, 10);
        if (!isNaN(parsedUid) && Number.isSafeInteger(parsedUid) && parsedUid >= 0) {
          finalUid = parsedUid;
        }
      }

      let finalGid = gid || undefined;
      if (pendingPax?.gid !== undefined) {
        const parsedGid = parseInt(pendingPax.gid, 10);
        if (!isNaN(parsedGid) && Number.isSafeInteger(parsedGid) && parsedGid >= 0) {
          finalGid = parsedGid;
        }
      }

      const finalUname = pendingPax?.uname ?? globalPax?.uname ?? (uname || undefined);
      const finalGname = pendingPax?.gname ?? globalPax?.gname ?? (gname || undefined);

      // Clear pending per-file metadata
      pendingGnuName = null;
      pendingGnuLink = null;
      pendingPax = null;

      const unsafe = isPathUnsafe(finalPath);
      const sanitizedPath = sanitizeArchivePath(finalPath, limits.maxEntryNameLength);
      const entryType = mapEntryType(typeflag, sanitizedPath);

      // Extract entry name from path
      const pathSegments = sanitizedPath.replace(/\/$/, "").split("/");
      const entryName = pathSegments[pathSegments.length - 1] || sanitizedPath;

      const entry: ArchiveEntry = {
        ordinal: ordinal++,
        path: sanitizedPath,
        name: entryName,
        type: entryType,
        size: entryType === "directory" ? 0 : Math.max(0, effectiveSize),
        modifiedTime: finalMtime,
        mode: mode || undefined,
        linkTarget: finalLink || undefined,
        uid: finalUid,
        gid: finalGid,
        uname: finalUname,
        gname: finalGname,
        ...(unsafe ? { isUnsafe: true } : {}),
      };

      const paddedPayloadSize =
        entryType === "directory" ? 0 : Math.ceil(effectiveSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

      let payloadHandled = false;

      const readPayload = async (maxBytes?: number): Promise<Uint8Array> => {
        if (payloadHandled) {
          throw new ArchiveError("Payload already consumed", "MALFORMED_ARCHIVE");
        }
        payloadHandled = true;
        const toRead = maxBytes !== undefined ? Math.min(effectiveSize, maxBytes) : effectiveSize;
        const payload = await reader.readExact(toRead);
        if (payload.byteLength < toRead) {
          throw new ArchiveParseError("Truncated entry payload", "TRUNCATED_ARCHIVE");
        }
        const remainingToSkip = paddedPayloadSize - toRead;
        if (remainingToSkip > 0) {
          await reader.skip(remainingToSkip);
        }
        return payload;
      };

      const skipPayload = async (): Promise<void> => {
        if (payloadHandled) return;
        payloadHandled = true;
        if (paddedPayloadSize > 0) {
          await reader.skip(paddedPayloadSize);
        }
      };

      entriesSinceYield++;

      yield {
        entry,
        effectiveSize,
        paddedPayloadSize,
        readPayload,
        skipPayload,
      };

      // If consumer did not read or skip payload, skip automatically to align next header
      if (!payloadHandled) {
        await skipPayload();
      }
    }
  } catch (err) {
    if (err instanceof ArchiveError) {
      throw err;
    }
    throw new ArchiveParseError(
      `Archive parsing failed: ${err instanceof Error ? err.message : String(err)}`,
      "MALFORMED_ARCHIVE"
    );
  } finally {
    if (tracker) {
      tracker.totalDecodedBytes = reader.totalBytesRead;
      tracker.totalCompressedBytes =
        input instanceof ArrayBuffer || ArrayBuffer.isView(input)
          ? input.byteLength
          : byteStats.totalBytesRead;
    }
  }
}

/**
 * Scans an archive incrementally and returns the indexed entries.
 */
export async function scanArchive(
  input: ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array>,
  format: ArchiveCompressionFormat,
  options: ScanArchiveOptions = {}
): Promise<ArchiveScanResult> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const entries: ArchiveEntry[] = [];
  const tracker: TarScanTracker = {
    totalDecodedBytes: 0,
    totalCompressedBytes: 0,
    isComplete: false,
  };

  for await (const item of iterateTarEntries(input, format, options, tracker)) {
    entries.push(item.entry);

    if (entries.length > limits.maxEntryCount) {
      throw new ArchiveLimitError(
        `Archive entry count (${entries.length}) exceeds limit of ${limits.maxEntryCount}`,
        "EXCEEDED_ENTRY_COUNT"
      );
    }
  }

  return {
    entries,
    totalDecodedBytes: tracker.totalDecodedBytes,
    totalCompressedBytes: tracker.totalCompressedBytes,
    format,
    isComplete: tracker.isComplete,
  };
}

/**
 * Rescans an archive to extract the text preview of an entry identified by ordinal.
 */
export async function extractTextPreview(
  input: ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array>,
  format: ArchiveCompressionFormat,
  targetOrdinal: number,
  options: PreviewArchiveOptions = {}
): Promise<PreviewExtractionResult> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const maxPreviewBytes = options.maxPreviewBytes ?? limits.maxPreviewBytes;

  for await (const item of iterateTarEntries(input, format, options)) {
    if (item.entry.ordinal === targetOrdinal) {
      if (item.entry.type !== "file") {
        return {
          entry: item.entry,
          content: "",
          isBinary: false,
          isOversized: false,
          isTruncated: false,
          errorMessage: `Cannot preview ${item.entry.type} entry`,
        };
      }

      if (item.entry.size > maxPreviewBytes) {
        await item.skipPayload();
        return {
          entry: item.entry,
          content: "",
          isBinary: false,
          isOversized: true,
          isTruncated: false,
          errorMessage: `Entry size (${item.entry.size} bytes) exceeds preview limit of ${maxPreviewBytes} bytes`,
        };
      }

      const payload = await item.readPayload();
      const isBinary = isBinaryData(payload);
      if (isBinary) {
        return {
          entry: item.entry,
          content: "",
          isBinary: true,
          isOversized: false,
          isTruncated: false,
          errorMessage: "Binary file cannot be previewed as text",
        };
      }

      const textContent = UTF8_DECODER.decode(payload);
      return {
        entry: item.entry,
        content: textContent,
        isBinary: false,
        isOversized: false,
        isTruncated: false,
      };
    }
  }

  throw new ArchiveError(`Entry at ordinal ${targetOrdinal} not found`, "ENTRY_NOT_FOUND");
}
