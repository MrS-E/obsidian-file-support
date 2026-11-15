import type { ArchiveCompressionFormat } from "./types";

/**
 * Standard suffix mappings for plain and compressed TAR archives.
 */
export const ARCHIVE_FORMAT_EXTENSIONS: Record<ArchiveCompressionFormat, readonly string[]> = {
  plain: ["tar"],
  gzip: ["tar.gz", "tgz", "gz"],
  bzip2: ["tar.bz2", "tbz2", "tbz", "bz2"],
  xz: ["tar.xz", "txz", "xz"],
  zstd: ["tar.zst", "tzst", "zst"],
};

/**
 * High-priority multi-part suffixes to test before single extensions.
 */
const COMPOUND_EXTENSIONS: readonly [string, ArchiveCompressionFormat][] = [
  [".tar.gz", "gzip"],
  [".tar.bz2", "bzip2"],
  [".tar.xz", "xz"],
  [".tar.zst", "zstd"],
];

/**
 * Single extension mappings.
 */
const SINGLE_EXTENSIONS: Readonly<Record<string, ArchiveCompressionFormat>> = {
  tar: "plain",
  tgz: "gzip",
  gz: "gzip",
  tbz2: "bzip2",
  tbz: "bzip2",
  bz2: "bzip2",
  txz: "xz",
  xz: "xz",
  tzst: "zstd",
  zst: "zstd",
};

/**
 * Determines the compression format from a file name or path.
 * Returns null if the file name does not match any known archive extension.
 */
export function getArchiveCompressionFormat(filename: string): ArchiveCompressionFormat | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();

  // Test compound extensions first (e.g. .tar.gz)
  for (const [suffix, format] of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(suffix)) {
      return format;
    }
  }

  // Extract last extension
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === lower.length - 1) {
    return null;
  }

  const ext = lower.slice(dotIndex + 1);
  return SINGLE_EXTENSIONS[ext] ?? null;
}

/**
 * Checks whether a file name represents a supported TAR archive or compressed stream.
 */
export function isArchiveFilename(filename: string): boolean {
  return getArchiveCompressionFormat(filename) !== null;
}

/**
 * Checks whether a file name is explicitly named as a TAR archive (e.g. .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tbz, .tar.xz, .txz, .tar.zst, .tzst).
 * Returns false for bare compression suffixes like .gz or .xz that might not be TARs.
 */
export function isTarArchiveFilename(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar.bz2") ||
    lower.endsWith(".tbz2") ||
    lower.endsWith(".tbz") ||
    lower.endsWith(".tar.xz") ||
    lower.endsWith(".txz") ||
    lower.endsWith(".tar.zst") ||
    lower.endsWith(".tzst")
  ) {
    return true;
  }
  return false;
}

/**
 * Returns a display badge label for the given format.
 */
export function getArchiveBadgeLabel(format: ArchiveCompressionFormat): string {
  switch (format) {
    case "plain":
      return "TAR";
    case "gzip":
      return "TGZ";
    case "bzip2":
      return "TBZ2";
    case "xz":
      return "TXZ";
    case "zstd":
      return "TZST";
  }
}
