/**
 * Compression formats supported by the archive engine.
 */
export type ArchiveCompressionFormat = "plain" | "gzip" | "bzip2" | "xz" | "zstd";

/**
 * Entry types represented in a TAR archive.
 */
export type ArchiveEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character-device"
  | "block-device"
  | "fifo"
  | "contiguous-file"
  | "unsupported";

/**
 * Bounded limits applied during archive scanning and preview extraction.
 */
export interface ArchiveLimits {
  /** Maximum compressed input size in bytes (default: 128 MiB = 134,217,728) */
  maxCompressedInputBytes: number;
  /** Maximum decompressed/decoded data in bytes across the whole scan (default: 512 MiB = 536,870,912) */
  maxDecodedBytes: number;
  /** Maximum number of indexed entries (default: 50,000) */
  maxEntryCount: number;
  /** Maximum length in chars of an entry path/name (default: 4096) */
  maxEntryNameLength: number;
  /** Maximum size for metadata records (PAX/GNU long names) in bytes (default: 1 MiB = 1,048,576) */
  maxMetadataBytes: number;
  /** Maximum size for text preview in bytes (default: 1 MiB = 1,048,576) */
  maxPreviewBytes: number;
}

/**
 * Default archive limit constants.
 */
export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  maxCompressedInputBytes: 128 * 1024 * 1024, // 128 MiB
  maxDecodedBytes: 512 * 1024 * 1024,         // 512 MiB
  maxEntryCount: 50_000,
  maxEntryNameLength: 4096,
  maxMetadataBytes: 1024 * 1024,              // 1 MiB
  maxPreviewBytes: 1024 * 1024,               // 1 MiB
};

/**
 * Metadata representation of an archive entry.
 */
export interface ArchiveEntry {
  /** 0-based stable ordinal index in the archive. */
  ordinal: number;
  /** Normalized archive-relative path (e.g. "dir/file.txt"). */
  path: string;
  /** Base filename or directory name (e.g. "file.txt"). */
  name: string;
  /** Entry type ('file', 'directory', 'symlink', etc.). */
  type: ArchiveEntryType;
  /** Uncompressed size of the entry in bytes. */
  size: number;
  /** Last modification timestamp in milliseconds since UNIX epoch (if present). */
  modifiedTime?: number;
  /** POSIX file permissions mode number (if present). */
  mode?: number;
  /** Target path if this entry is a symlink or hardlink. */
  linkTarget?: string;
  /** User ID from header/PAX. */
  uid?: number;
  /** Group ID from header/PAX. */
  gid?: number;
  /** User name string from header/PAX. */
  uname?: string;
  /** Group name string from header/PAX. */
  gname?: string;
  /** Whether the original path contained directory traversal (..) or unsafe absolute/drive prefixes. */
  isUnsafe?: boolean;
}

/**
 * Result of scanning an archive.
 */
export interface ArchiveScanResult {
  /** List of indexed entries. */
  entries: ArchiveEntry[];
  /** Total uncompressed bytes decoded during the scan. */
  totalDecodedBytes: number;
  /** Total compressed bytes consumed during the scan. */
  totalCompressedBytes: number;
  /** Compression format detected/used. */
  format: ArchiveCompressionFormat;
  /** Whether the archive was completely scanned to the end without truncation. */
  isComplete: boolean;
}

/**
 * Result of extracting a single text entry for preview.
 */
export interface PreviewExtractionResult {
  /** Metadata for the selected entry. */
  entry: ArchiveEntry;
  /** Decoded UTF-8 content if text preview is supported and valid. */
  content: string;
  /** Whether the entry was detected to contain binary data. */
  isBinary: boolean;
  /** Whether the entry exceeds maxPreviewBytes. */
  isOversized: boolean;
  /** Whether preview content was truncated. */
  isTruncated: boolean;
  /** Error or unsupported reason message, if preview cannot be rendered. */
  errorMessage?: string;
}

/**
 * Options for scanning an archive.
 */
export interface ScanArchiveOptions {
  /** Custom resource limits. */
  limits?: Partial<ArchiveLimits>;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Optional cooperative yield function to avoid blocking the UI thread on long operations. */
  onYield?: () => Promise<void> | void;
}

/**
 * Options for preview extraction.
 */
export interface PreviewArchiveOptions extends ScanArchiveOptions {
  /** Optional custom max preview bytes (defaults to limits.maxPreviewBytes). */
  maxPreviewBytes?: number;
}

/**
 * Error codes for archive operations.
 */
export type ArchiveErrorCode =
  | "EXCEEDED_INPUT_SIZE"
  | "EXCEEDED_DECODED_SIZE"
  | "EXCEEDED_ENTRY_COUNT"
  | "EXCEEDED_NAME_LENGTH"
  | "EXCEEDED_METADATA_SIZE"
  | "EXCEEDED_PREVIEW_SIZE"
  | "INVALID_HEADER"
  | "BAD_CHECKSUM"
  | "TRUNCATED_ARCHIVE"
  | "MALFORMED_ARCHIVE"
  | "DECODER_ERROR"
  | "UNSUPPORTED_FORMAT"
  | "ABORTED"
  | "ENTRY_NOT_FOUND"
  | "UNSUPPORTED_ENTRY_TYPE";

/**
 * Base archive error class.
 */
export class ArchiveError extends Error {
  constructor(message: string, public readonly code: ArchiveErrorCode) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Error thrown when an archive scan or preview exceeds configured limits.
 */
export class ArchiveLimitError extends ArchiveError {
  constructor(message: string, code: ArchiveErrorCode) {
    super(message, code);
    this.name = "ArchiveLimitError";
  }
}

/**
 * Error thrown when archive header or stream structure is corrupt or malformed.
 */
export class ArchiveParseError extends ArchiveError {
  constructor(message: string, code: ArchiveErrorCode = "MALFORMED_ARCHIVE") {
    super(message, code);
    this.name = "ArchiveParseError";
  }
}

/**
 * Error thrown when an archive operation is cancelled via AbortSignal.
 */
export class ArchiveAbortError extends ArchiveError {
  constructor(message = "Archive scanning operation was cancelled") {
    super(message, "ABORTED");
    this.name = "ArchiveAbortError";
  }
}
